import {
  countNonDeletedAssignedChildThreads,
  getEnvironment,
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  updateThread,
} from "@bb/db";
import type { Environment, Thread, ThreadListEntry } from "@bb/domain";
import {
  createThreadRequestSchema,
  deleteThreadRequestSchema,
  threadGetQuerySchema,
  threadIncludeOptionSchema,
  threadListQuerySchema,
  updateThreadRequestSchema,
  typedRoutes,
  type ThreadGetQuery,
  type ThreadIncludeOption,
  type ThreadAssignedChildSummaryResponse,
  type ThreadWithIncludesResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import { renderTemplate } from "@bb/templates";
import type { Hono } from "hono";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { parseOptionalInteger } from "../../services/lib/validation.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../../services/environments/environment-cleanup.js";
import {
  getNonDestroyedHostWithStatus,
  requireEnvironment,
  requirePublicProject,
  requirePublicThread,
  requirePublicThreadEnvironment,
} from "../../services/lib/entity-lookup.js";
import { queueThreadRenameCommand } from "../../services/threads/thread-commands.js";
import {
  finalizeStoppedThread,
  requestThreadStopIfNeeded,
} from "../../services/threads/thread-lifecycle.js";
import { appendThreadOwnershipChangeEvent } from "../../services/threads/thread-events.js";
import { createThreadFromRequest } from "../../services/threads/thread-create.js";
import { queueManagerSystemMessage } from "../../services/threads/manager-system-messages.js";
import { requireManagerChildThreadsConfirmation } from "../../services/threads/manager-child-confirmation.js";
import {
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import { assertValidManagerParentThread } from "../../services/threads/thread-parent.js";

function parseThreadIncludes(query: ThreadGetQuery): Set<ThreadIncludeOption> {
  const includes = new Set<ThreadIncludeOption>();
  if (!query.include) {
    return includes;
  }
  for (const value of query.include.split(",")) {
    includes.add(threadIncludeOptionSchema.parse(value));
  }
  return includes;
}

interface BuildThreadResponseArgs {
  includes: Set<ThreadIncludeOption>;
  thread: Thread;
}

function resolveIncludedThreadEnvironment(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
): Environment | null {
  if (thread.environmentId === null) {
    return null;
  }
  return getEnvironment(deps.db, thread.environmentId);
}

function buildThreadResponse(
  deps: AppDeps,
  args: BuildThreadResponseArgs,
): ThreadWithIncludesResponse {
  const response: ThreadWithIncludesResponse = toThreadResponseFromThread(
    deps,
    {
      thread: args.thread,
    },
  );
  const shouldResolveEnvironment =
    args.includes.has("environment") || args.includes.has("host");
  const environment = shouldResolveEnvironment
    ? resolveIncludedThreadEnvironment(deps, args.thread)
    : null;

  if (args.includes.has("environment")) {
    response.environment = environment;
  }
  if (args.includes.has("host")) {
    response.host = environment
      ? getNonDestroyedHostWithStatus(deps.db, environment.hostId)
      : null;
  }
  return response;
}

function formatThreadLabelForManager(thread: {
  id: string;
  title: string | null;
}): string {
  return thread.title ? `${thread.id}: ${thread.title}` : thread.id;
}

async function queueManagerSystemMessageBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    managedThreadId: string;
    managerThreadId: string;
    messageText: string;
    reason: "assigned" | "removed";
  },
): Promise<void> {
  try {
    await queueManagerSystemMessage(deps, {
      managerThreadId: args.managerThreadId,
      messageText: args.messageText,
    });
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        managedThreadId: args.managedThreadId,
        managerThreadId: args.managerThreadId,
        reason: args.reason,
      },
      "Failed to queue manager ownership system message",
    );
  }
}

export function registerThreadBaseRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/threads", threadListQuerySchema, (context, query) => {
    const limit = parseOptionalInteger(query.limit, "limit");
    if (limit !== undefined && limit <= 0) {
      throw new ApiError(400, "invalid_request", "limit must be positive");
    }
    const offset = parseOptionalInteger(query.offset, "offset");
    if (offset !== undefined && offset < 0) {
      throw new ApiError(
        400,
        "invalid_request",
        "offset must be non-negative",
      );
    }
    const threads = listThreadsWithPendingInteractionState(deps.db, {
      projectId: query.projectId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.parentThreadId ? { parentThreadId: query.parentThreadId } : {}),
      archived:
        query.archived === undefined ? undefined : query.archived === "true",
      managed:
        query.managed === undefined ? undefined : query.managed === "true",
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    return context.json(
      toThreadListEntryResponses(deps, { threads }) satisfies ThreadListEntry[],
    );
  });

  post("/threads", createThreadRequestSchema, async (context, payload) => {
    requirePublicProject(deps.db, payload.projectId);
    const thread = await createThreadFromRequest(deps, {
      ...payload,
      automationId: null,
      origin: payload.origin,
      type: "standard",
    });
    return context.json(toThreadResponseFromThread(deps, { thread }), 201);
  });

  get("/threads/:id", threadGetQuerySchema, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      buildThreadResponse(deps, {
        includes: parseThreadIncludes(query),
        thread,
      }),
    );
  });

  get("/threads/:id/assigned-child-summary", (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (thread.type !== "manager") {
      throw new ApiError(
        400,
        "invalid_request",
        "Assigned child summary is only available for manager threads",
      );
    }
    const nonDeletedAssignedChildCount = countNonDeletedAssignedChildThreads(
      deps.db,
      {
        parentThreadId: thread.id,
      },
    );
    return context.json({
      nonDeletedAssignedChildCount,
    } satisfies ThreadAssignedChildSummaryResponse);
  });

  patch("/threads/:id", updateThreadRequestSchema, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (payload.parentThreadId) {
      assertValidManagerParentThread(deps, {
        parentThreadId: payload.parentThreadId,
        projectId: thread.projectId,
      });
    }
    const updated = updateThread(deps.db, deps.hub, thread.id, payload);
    if (!updated) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    if (
      payload.title &&
      payload.title !== thread.title &&
      updated.environmentId
    ) {
      const environment = requireEnvironment(deps.db, updated.environmentId);
      if (environment.status === "ready" && environment.path) {
        queueThreadRenameCommand(deps, {
          environment: {
            id: environment.id,
            hostId: environment.hostId,
          },
          providerId: updated.providerId,
          threadId: updated.id,
          title: payload.title,
        });
      }
    }

    if (
      "parentThreadId" in payload &&
      payload.parentThreadId !== thread.parentThreadId
    ) {
      appendThreadOwnershipChangeEvent(deps, {
        threadId: updated.id,
        environmentId: updated.environmentId,
        previousParentThreadId: thread.parentThreadId,
        nextParentThreadId: updated.parentThreadId,
      });

      const threadLabel = formatThreadLabelForManager(updated);
      if (updated.parentThreadId) {
        await queueManagerSystemMessageBestEffort(deps, {
          managedThreadId: updated.id,
          managerThreadId: updated.parentThreadId,
          messageText: renderTemplate("systemMessageThreadOwnershipAssigned", {
            threadLabel,
          }),
          reason: "assigned",
        });
      }
      if (thread.parentThreadId) {
        await queueManagerSystemMessageBestEffort(deps, {
          managedThreadId: updated.id,
          managerThreadId: thread.parentThreadId,
          messageText: renderTemplate("systemMessageThreadOwnershipRemoved", {
            threadLabel,
          }),
          reason: "removed",
        });
      }
    }

    return context.json(toThreadResponseFromThread(deps, { thread: updated }));
  });

  del("/threads/:id", deleteThreadRequestSchema, async (context, payload) => {
    const { environment, thread } = requirePublicThreadEnvironment(
      deps.db,
      context.req.param("id"),
    );
    requireManagerChildThreadsConfirmation({
      action: "delete",
      confirmed: payload.managerChildThreadsConfirmed,
      deps,
      thread,
    });
    markThreadDeleted(deps.db, deps.hub, { threadId: thread.id });
    requestThreadStopIfNeeded(deps, thread, environment);
    await finalizeStoppedThread(deps, {
      threadId: thread.id,
      cancelPendingCommand: false,
    });
    requestEnvironmentCleanup(deps, {
      environmentId: environment.id,
      mode: "force",
    });
    await advanceEnvironmentCleanup(deps, {
      environmentId: environment.id,
    });
    return context.json({ ok: true });
  });
}
