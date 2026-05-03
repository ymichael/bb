import {
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  updateThread,
} from "@bb/db";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import {
  createThreadRequestSchema,
  threadListQuerySchema,
  updateThreadRequestSchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { renderTemplate } from "@bb/templates";
import type { Hono } from "hono";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../../services/environments/environment-cleanup.js";
import {
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
import {
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import { assertValidManagerParentThread } from "../../services/threads/thread-parent.js";

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
    const threads = listThreadsWithPendingInteractionState(deps.db, {
      projectId: query.projectId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.parentThreadId ? { parentThreadId: query.parentThreadId } : {}),
      archived:
        query.archived === undefined ? undefined : query.archived === "true",
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

  get("/threads/:id", (context) =>
    context.json(
      toThreadResponseFromThread(deps, {
        thread: requirePublicThread(deps.db, context.req.param("id")),
      }) satisfies ThreadWithRuntime,
    ),
  );

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

  del("/threads/:id", async (context) => {
    const { environment, thread } = requirePublicThreadEnvironment(
      deps.db,
      context.req.param("id"),
    );
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
