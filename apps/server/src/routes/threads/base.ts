import {
  THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT,
  THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  countNonDeletedAssignedChildThreads,
  countThreads,
  getEnvironment,
  getThreadSectionById,
  listThreadMentionRowsByIds,
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  searchThreadsWithPendingInteractionState,
  updateThread,
  type ThreadSearchResultGroup as DbThreadSearchResultGroup,
  type UpdateThreadInput,
} from "@bb/db";
import type { Environment, Thread, ThreadListEntry } from "@bb/domain";
import {
  threadIncludeOptionSchema,
  THREAD_COUNT_ROOT_PARENT,
  publicApiRoutes,
  typedRoutes,
  type ThreadGetQuery,
  type ThreadIncludeOption,
  type ThreadChildSummaryResponse,
  type ThreadCountResponse,
  type ThreadRunningResponse,
  type ThreadSearchResponse,
  type ThreadWithIncludesResponse,
  type PublicApiSchema,
  type ResolveThreadMentionsResponse,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { parseOptionalInteger } from "../../services/lib/validation.js";
import {
  requestEnvironmentCleanup,
  requestEnvironmentCleanupAdvance,
} from "../../services/environments/environment-cleanup-internal.js";
import {
  getNonDestroyedHostWithStatus,
  requireEnvironment,
  requirePublicProject,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { listRunningThreadsWithIntendedHosts } from "../../services/threads/dispatch-attempt.js";
import { dispatchThreadRenameCommand } from "../../services/threads/thread-commands.js";
import {
  finalizeStoppedThread,
  requestActiveRuntimeThreadStopIfNeeded,
} from "../../services/threads/thread-lifecycle.js";
import { createThreadFromRequest } from "../../services/threads/thread-create.js";
import { createThreadForkFromRequest } from "../../services/threads/thread-fork.js";
import { requireChildThreadsConfirmation } from "../../services/threads/child-thread-confirmation.js";
import {
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import { assertValidParentThread } from "../../services/threads/thread-parent.js";
import { handleThreadOwnershipChange } from "../../services/threads/thread-ownership.js";
import { applyThreadExecutionOverride } from "../../services/threads/thread-execution-override.js";
import { emitPluginThreadDeleted } from "../../services/plugins/plugin-thread-events.js";

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

type ThreadSearchResultGroupResponse = ThreadSearchResponse["active"];

interface BuildThreadSearchGroupResponseArgs {
  group: DbThreadSearchResultGroup;
}

interface BuildThreadSearchResponseArgs {
  active: DbThreadSearchResultGroup;
  archived: DbThreadSearchResultGroup;
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
      ? getNonDestroyedHostWithStatus(deps, environment.hostId)
      : null;
  }
  return response;
}

function countNonWhitespaceChars(value: string): number {
  return value.replaceAll(/\s/gu, "").length;
}

function threadMentionLabel(thread: {
  id: string;
  title: string | null;
  titleFallback: string | null;
}): string {
  if (thread.title && thread.title.trim().length > 0) {
    return thread.title;
  }
  if (thread.titleFallback && thread.titleFallback.trim().length > 0) {
    return thread.titleFallback;
  }
  return `Thread ${thread.id.slice(0, 8)}`;
}

function parseSearchLimitPerGroup(value: string | undefined): number {
  const limit =
    value === undefined
      ? THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT
      : parseOptionalInteger(value, "limitPerGroup");
  if (limit === undefined) {
    return THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT;
  }
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "limitPerGroup must be positive",
    );
  }
  if (limit > THREAD_SEARCH_LIMIT_PER_GROUP_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `limitPerGroup must be at most ${THREAD_SEARCH_LIMIT_PER_GROUP_MAX}`,
    );
  }
  return limit;
}

function requireThreadSection(
  deps: Pick<AppDeps, "db">,
  sectionId: string,
): void {
  if (!getThreadSectionById(deps.db, sectionId)) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }
}

function buildThreadSearchGroupResponse(
  deps: AppDeps,
  args: BuildThreadSearchGroupResponseArgs,
): ThreadSearchResultGroupResponse {
  const threadEntries = toThreadListEntryResponses(deps, {
    threads: args.group.results.map((result) => result.thread),
  });
  const threadEntriesById = new Map(
    threadEntries.map((thread) => [thread.id, thread]),
  );

  return {
    total: args.group.total,
    results: args.group.results.flatMap((result) => {
      const thread = threadEntriesById.get(result.thread.id);
      if (thread === undefined) {
        return [];
      }
      return [{ thread, matches: result.matches }];
    }),
  };
}

function buildThreadSearchResponse(
  deps: AppDeps,
  args: BuildThreadSearchResponseArgs,
): ThreadSearchResponse {
  return {
    active: buildThreadSearchGroupResponse(deps, { group: args.active }),
    archived: buildThreadSearchGroupResponse(deps, { group: args.archived }),
  };
}

export function registerThreadBaseRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threads;

  get(routes.count, (context, query) => {
    if (query.projectId) {
      requirePublicProject(deps.db, query.projectId);
    }
    const result = countThreads(deps.db, {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
      ...(query.providerId !== undefined
        ? { providerId: query.providerId }
        : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.parentThreadId === undefined
        ? {}
        : {
            parent:
              query.parentThreadId === THREAD_COUNT_ROOT_PARENT
                ? { kind: "root" as const }
                : {
                    kind: "id" as const,
                    parentThreadId: query.parentThreadId,
                  },
          }),
      ...(query.groupBy !== undefined ? { groupBy: query.groupBy } : {}),
      includeArchived: query.includeArchived === "true",
      includeHidden: query.includeHidden === "true",
    });
    const response: ThreadCountResponse = {
      total: result.total,
      ...(result.groups !== undefined ? { groups: result.groups } : {}),
    };
    return context.json(response);
  });

  get(routes.running, (context) => {
    return context.json(
      listRunningThreadsWithIntendedHosts(deps) satisfies ThreadRunningResponse,
    );
  });

  get(routes.list, (context, query) => {
    const limit = parseOptionalInteger(query.limit, "limit");
    if (limit !== undefined && limit <= 0) {
      throw new ApiError(400, "invalid_request", "limit must be positive");
    }
    const offset = parseOptionalInteger(query.offset, "offset");
    if (offset !== undefined && offset < 0) {
      throw new ApiError(400, "invalid_request", "offset must be non-negative");
    }
    if (query.projectId) {
      requirePublicProject(deps.db, query.projectId);
    }
    if (query.sectionId && query.unsectioned === "true") {
      throw new ApiError(
        400,
        "invalid_request",
        "sectionId and unsectioned cannot be used together",
      );
    }
    if (query.sectionId) {
      requireThreadSection(deps, query.sectionId);
    }
    const threads = listThreadsWithPendingInteractionState(deps.db, {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.parentThreadId ? { parentThreadId: query.parentThreadId } : {}),
      ...(query.sourceThreadId ? { sourceThreadId: query.sourceThreadId } : {}),
      ...(query.sectionId ? { sectionId: query.sectionId } : {}),
      ...(query.unsectioned === "true" ? { unsectioned: true } : {}),
      ...(query.originKind ? { originKind: query.originKind } : {}),
      ...(query.originPluginId ? { originPluginId: query.originPluginId } : {}),
      includeHidden: query.includeHidden === "true",
      archived:
        query.archived === undefined ? undefined : query.archived === "true",
      hasParent:
        query.hasParent === undefined ? undefined : query.hasParent === "true",
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    return context.json(
      toThreadListEntryResponses(deps, { threads }) satisfies ThreadListEntry[],
    );
  });

  get(routes.search, (context, query) => {
    const searchQuery = query.query.trim();
    if (countNonWhitespaceChars(searchQuery) < 2) {
      throw new ApiError(
        400,
        "invalid_request",
        "query must contain at least two non-whitespace characters",
      );
    }
    const limitPerGroup = parseSearchLimitPerGroup(query.limitPerGroup);
    return context.json(
      buildThreadSearchResponse(deps, {
        ...searchThreadsWithPendingInteractionState(deps.db, {
          query: searchQuery,
          limitPerGroup,
        }),
      }) satisfies ThreadSearchResponse,
    );
  });

  post(routes.resolveMentions, (context, payload) => {
    const uniqueThreadIds = [...new Set(payload.threadIds)];
    const rowsById = new Map(
      listThreadMentionRowsByIds(deps.db, uniqueThreadIds).map((thread) => [
        thread.id,
        thread,
      ]),
    );
    const resolved = uniqueThreadIds.flatMap((threadId) => {
      const thread = rowsById.get(threadId);
      if (thread === undefined) {
        return [];
      }
      return [
        {
          threadId: thread.id,
          projectId: thread.projectId,
          label: threadMentionLabel(thread),
        },
      ];
    });
    return context.json(resolved satisfies ResolveThreadMentionsResponse);
  });

  post(routes.create, async (context, payload) => {
    if (payload.sectionId) {
      requireThreadSection(deps, payload.sectionId);
    }
    const thread = await createThreadFromRequest(deps, {
      ...payload,
      origin: payload.origin,
    });
    return context.json(toThreadResponseFromThread(deps, { thread }), 201);
  });

  post(routes.fork, async (context, payload) => {
    const thread = await createThreadForkFromRequest(deps, payload);
    return context.json(toThreadResponseFromThread(deps, { thread }), 201);
  });

  get(routes.get, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      buildThreadResponse(deps, {
        includes: parseThreadIncludes(query),
        thread,
      }),
    );
  });

  function getThreadChildSummary(threadId: string): ThreadChildSummaryResponse {
    const nonDeletedChildCount = countNonDeletedAssignedChildThreads(deps.db, {
      parentThreadId: threadId,
    });
    return {
      nonDeletedChildCount,
    };
  }

  get(routes.childSummary, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(getThreadChildSummary(thread.id));
  });

  patch(routes.update, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (payload.parentThreadId) {
      assertValidParentThread(deps, {
        childThreadId: thread.id,
        parentThreadId: payload.parentThreadId,
      });
    }

    if ("model" in payload || "reasoningLevel" in payload) {
      await applyThreadExecutionOverride(deps, {
        thread,
        patch: {
          ...("model" in payload ? { model: payload.model } : {}),
          ...("reasoningLevel" in payload
            ? { reasoningLevel: payload.reasoningLevel }
            : {}),
        },
      });
    }

    const metadataUpdate: UpdateThreadInput = {};
    if ("title" in payload) {
      metadataUpdate.title = payload.title;
    }
    const sectionId = payload.sectionId;
    if (sectionId !== undefined) {
      if (sectionId !== null) {
        requireThreadSection(deps, sectionId);
      }
      metadataUpdate.sectionId = sectionId;
    }
    if ("parentThreadId" in payload) {
      metadataUpdate.parentThreadId = payload.parentThreadId;
    }
    if ("visibility" in payload) {
      metadataUpdate.visibility = payload.visibility;
    }
    const updated =
      Object.keys(metadataUpdate).length > 0
        ? updateThread(deps.db, deps.hub, thread.id, metadataUpdate)
        : requirePublicThread(deps.db, thread.id);
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
        dispatchThreadRenameCommand(deps, {
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
      await handleThreadOwnershipChange(deps, {
        previousThread: thread,
        updatedThread: updated,
      });
    }

    return context.json(toThreadResponseFromThread(deps, { thread: updated }));
  });

  del(routes.delete, async (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    requireChildThreadsConfirmation({
      action: "delete",
      confirmed: payload.childThreadsConfirmed,
      deps,
      thread,
    });
    const deletedThread = markThreadDeleted(deps.db, deps.hub, {
      threadId: thread.id,
    });
    if (deletedThread) emitPluginThreadDeleted(deletedThread);
    deps.terminalSessions.closeDeletedThreadTerminals({ threadId: thread.id });
    if (thread.environmentId === null) {
      finalizeStoppedThread(deps, {
        threadId: thread.id,
      });
      return context.json({ ok: true });
    }

    const environment = requireEnvironment(deps.db, thread.environmentId);
    requestActiveRuntimeThreadStopIfNeeded(deps, thread, environment);
    finalizeStoppedThread(deps, {
      threadId: thread.id,
    });
    requestEnvironmentCleanup(deps, {
      environmentId: environment.id,
    });
    requestEnvironmentCleanupAdvance(deps, {
      environmentId: environment.id,
    });
    return context.json({ ok: true });
  });
}
