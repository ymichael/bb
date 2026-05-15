import path from "node:path";
import { listDrafts } from "@bb/db";
import { FILE_LIST_LIMIT_MAX } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { PROMPT_HISTORY_ENTRY_LIMIT, threadEventTypeSchema } from "@bb/domain";
import {
  promptHistoryQuerySchema,
  threadHostFileContentQuerySchema,
  threadStorageContentQuerySchema,
  threadStorageFilesQuerySchema,
  threadEventWaitQuerySchema,
  threadEventsQuerySchema,
  threadTimelineQuerySchema,
  timelineTurnSummaryDetailsQuerySchema,
  typedRoutes,
  type PublicApiSchema,
  type ThreadComposerBootstrapResponse,
  type ThreadTimelineQuery,
} from "@bb/server-contract";
import type { AppDeps, SandboxWorkSessionDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import {
  requireEnvironment,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { queueCommandAndWait } from "../../services/hosts/command-wait.js";
import {
  createDaemonFileContentResponse,
  remapDaemonFileRouteError,
} from "../../services/hosts/daemon-file-response.js";
import { requireThreadStoragePath } from "../../services/threads/thread-storage.js";
import { toQueuedMessage } from "../../services/threads/drafts.js";
import {
  buildThreadTimeline,
  buildTimelineTurnSummaryDetails,
  resolveThreadTimelineServiceViewMode,
  THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
  THREAD_TIMELINE_SEGMENT_LIMIT_MAX,
  type ThreadTimelinePageKind,
  type ThreadTimelinePageRequest,
} from "../../services/threads/timeline.js";
import {
  findThreadEvent,
  getLastThreadOutput,
  listThreadEventRows,
} from "../../services/threads/thread-data.js";
import { getLastExecutionOptions } from "../../services/threads/thread-events.js";
import { resolveSystemExecutionOptions } from "../../services/system/execution-options.js";
import { listThreadPromptHistory } from "../../services/prompt-history.js";
import {
  parseInteger,
  parseOptionalInteger,
} from "../../services/lib/validation.js";

interface ThreadComposerExecutionOptionsSource {
  archivedAt: number | null;
  environmentId: string | null;
}

interface ShouldResolveThreadComposerExecutionOptionsArgs {
  thread: ThreadComposerExecutionOptionsSource;
}

function shouldResolveThreadComposerExecutionOptions({
  thread,
}: ShouldResolveThreadComposerExecutionOptionsArgs): boolean {
  return thread.archivedAt === null && thread.environmentId !== null;
}

async function buildThreadComposerBootstrapResponse(
  deps: AppDeps,
  threadId: string,
): Promise<ThreadComposerBootstrapResponse> {
  const thread = requirePublicThread(deps.db, threadId);
  const defaultExecutionOptions = getLastExecutionOptions(deps, threadId);
  const composerEnvironmentId = shouldResolveThreadComposerExecutionOptions({
    thread,
  })
    ? thread.environmentId
    : null;
  const executionOptions = composerEnvironmentId
    ? await resolveSystemExecutionOptions(deps, {
        environmentId: composerEnvironmentId,
        providerId: thread.providerId,
      })
    : {
        providers: [],
        models: [],
        selectedOnlyModels: [],
      };
  return {
    defaultExecutionOptions,
    drafts: listDrafts(deps.db, threadId).map((draft) =>
      toQueuedMessage(draft),
    ),
    executionOptions,
    pendingInteractions:
      deps.pendingInteractions.listPendingThreadInteractions(threadId),
    promptHistory: listThreadPromptHistory(deps, {
      threadId,
      limit: PROMPT_HISTORY_ENTRY_LIMIT,
    }),
  };
}

function validateFilePath(filePath: string): void {
  if (
    filePath.startsWith("/") ||
    filePath.split("/").includes("..") ||
    filePath.split("\\").includes("..")
  ) {
    throw new ApiError(400, "invalid_request", "Invalid file path");
  }
}

interface ThreadStorageTarget {
  hostId: string;
  storagePath: string;
}

interface RequireThreadStorageTargetArgs {
  threadId: string;
}

function parseThreadStorageFileListLimit(rawLimit: string | undefined): number {
  const limit = Math.min(
    parseOptionalInteger(rawLimit, "limit") ?? 1000,
    FILE_LIST_LIMIT_MAX,
  );
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "limit must be a positive integer",
    );
  }
  return limit;
}

function parseThreadTimelineSegmentLimit(
  defaultLimit: number,
  rawLimit: string | undefined,
): number {
  const limit = parseOptionalInteger(rawLimit, "segmentLimit") ?? defaultLimit;
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "segmentLimit must be a positive integer",
    );
  }
  if (limit > THREAD_TIMELINE_SEGMENT_LIMIT_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `segmentLimit must be less than or equal to ${THREAD_TIMELINE_SEGMENT_LIMIT_MAX}`,
    );
  }
  return limit;
}

function parseThreadTimelinePage(
  query: ThreadTimelineQuery,
): ThreadTimelinePageRequest {
  const hasBeforeAnchorSeq = query.beforeAnchorSeq !== undefined;
  const kind: ThreadTimelinePageKind = hasBeforeAnchorSeq ? "older" : "latest";
  const segmentLimit = parseThreadTimelineSegmentLimit(
    THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
    query.segmentLimit,
  );

  if (kind === "latest") {
    return {
      kind,
      segmentLimit,
    };
  }

  if (
    query.beforeAnchorSeq === undefined ||
    query.beforeAnchorId === undefined
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "beforeAnchorSeq and beforeAnchorId must be provided together",
    );
  }

  return {
    beforeCursor: {
      anchorSeq: parseInteger(query.beforeAnchorSeq, "beforeAnchorSeq"),
      anchorId: query.beforeAnchorId,
    },
    kind,
    segmentLimit,
  };
}

async function requireThreadStorageTarget(
  deps: SandboxWorkSessionDeps,
  args: RequireThreadStorageTargetArgs,
): Promise<ThreadStorageTarget> {
  const thread = requirePublicThread(deps.db, args.threadId);
  if (!thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  const environment = requireEnvironment(deps.db, thread.environmentId);
  return {
    hostId: environment.hostId,
    storagePath: await requireThreadStoragePath(deps, {
      hostId: environment.hostId,
      threadId: thread.id,
    }),
  };
}

export function registerThreadDataRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/threads/:id/timeline", threadTimelineQuerySchema, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      buildThreadTimeline(deps.db, thread, {
        isDevelopment: deps.config.isDevelopment,
        timelineViewMode: resolveThreadTimelineServiceViewMode({
          managerTimelineView: query.managerTimelineView,
          thread,
        }),
        includeNestedRows: query.includeNestedRows === "true",
        page: parseThreadTimelinePage(query),
        summaryOnly: query.summaryOnly === "true",
      }),
    );
  });

  get(
    "/threads/:id/timeline/turn-summary-details",
    timelineTurnSummaryDetailsQuerySchema,
    (context, query) => {
      const thread = requirePublicThread(deps.db, context.req.param("id"));
      return context.json(
        buildTimelineTurnSummaryDetails(deps.db, thread, {
          isDevelopment: deps.config.isDevelopment,
          turnId: query.turnId,
          sourceSeqStart: parseInteger(query.sourceSeqStart, "sourceSeqStart"),
          sourceSeqEnd: parseInteger(query.sourceSeqEnd, "sourceSeqEnd"),
          timelineViewMode: resolveThreadTimelineServiceViewMode({
            managerTimelineView: query.managerTimelineView,
            thread,
          }),
        }),
      );
    },
  );

  get("/threads/:id/output", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json({
      output: getLastThreadOutput(deps.db, context.req.param("id")),
    });
  });

  get("/threads/:id/composer-bootstrap", async (context) =>
    context.json(
      await buildThreadComposerBootstrapResponse(deps, context.req.param("id")),
    ),
  );

  get("/threads/:id/drafts", (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    return context.json(
      listDrafts(deps.db, threadId).map((draft) => toQueuedMessage(draft)),
    );
  });

  get(
    "/threads/:id/prompt-history",
    promptHistoryQuerySchema,
    (context, query) => {
      const threadId = context.req.param("id");
      requirePublicThread(deps.db, threadId);
      const limit = Math.min(
        parseOptionalInteger(query.limit, "limit") ??
          PROMPT_HISTORY_ENTRY_LIMIT,
        PROMPT_HISTORY_ENTRY_LIMIT,
      );
      if (limit <= 0) {
        throw new ApiError(
          400,
          "invalid_request",
          "limit must be a positive integer",
        );
      }

      return context.json(
        listThreadPromptHistory(deps, {
          threadId,
          limit,
        }),
      );
    },
  );

  get("/threads/:id/events", threadEventsQuerySchema, (context, query) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      listThreadEventRows(deps.db, {
        threadId: context.req.param("id"),
        afterSeq: parseOptionalInteger(query.afterSeq, "afterSeq"),
        limit: parseOptionalInteger(query.limit, "limit") ?? 100,
      }),
    );
  });

  get(
    "/threads/:id/events/wait",
    threadEventWaitQuerySchema,
    async (context, query) => {
      const threadId = context.req.param("id");
      requirePublicThread(deps.db, threadId);

      const afterSeq = parseOptionalInteger(query.afterSeq, "afterSeq");
      const waitMs = Math.min(
        parseOptionalInteger(query.waitMs, "waitMs") ?? 30_000,
        60_000,
      );
      const parsedEventType = threadEventTypeSchema.safeParse(query.type);
      if (!parsedEventType.success) {
        throw new ApiError(400, "invalid_request", "Invalid event type");
      }
      const eventType = parsedEventType.data;

      const findMatch = () =>
        findThreadEvent(deps.db, { threadId, type: eventType, afterSeq });

      const deadline = Date.now() + waitMs;
      let match = findMatch();
      while (!match) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const waiter = deps.hub.registerThreadEventWaiter(threadId, remaining);
        match = findMatch();
        if (match) {
          waiter.cancel();
          break;
        }
        await waiter.promise;
        match = findMatch();
      }

      if (!match) {
        return new Response(null, { status: 204 });
      }

      return context.json(match);
    },
  );

  get("/threads/:id/default-execution-options", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json(getLastExecutionOptions(deps, context.req.param("id")));
  });

  get(
    "/threads/:id/thread-storage/files",
    threadStorageFilesQuerySchema,
    async (context, query) => {
      const target = await requireThreadStorageTarget(deps, {
        threadId: context.req.param("id"),
      });
      const limit = parseThreadStorageFileListLimit(query.limit);

      try {
        const result = await queueCommandAndWait(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.list_files",
            path: target.storagePath,
            ...(query.query ? { query: query.query } : {}),
            limit,
          },
        });
        return context.json({
          files: result.files,
          truncated: result.truncated,
          storageRootPath: target.storagePath,
        });
      } catch (error) {
        if (error instanceof ApiError && error.body.code === "ENOENT") {
          return context.json({
            files: [],
            truncated: false,
            storageRootPath: target.storagePath,
          });
        }
        throw error;
      }
    },
  );

  get(
    "/threads/:id/thread-storage/content",
    threadStorageContentQuerySchema,
    async (context, query) => {
      validateFilePath(query.path);
      const target = await requireThreadStorageTarget(deps, {
        threadId: context.req.param("id"),
      });

      try {
        const result = await queueCommandAndWait(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.read_file",
            path: path.join(target.storagePath, query.path),
            rootPath: target.storagePath,
          },
        });
        return createDaemonFileContentResponse(result);
      } catch (error) {
        return remapDaemonFileRouteError(error);
      }
    },
  );

  get(
    "/threads/:id/host-files/content",
    threadHostFileContentQuerySchema,
    async (context, query) => {
      const thread = requirePublicThread(deps.db, context.req.param("id"));
      if (!thread.environmentId) {
        throw new ApiError(409, "invalid_request", "Thread has no environment");
      }
      const environment = requireEnvironment(deps.db, thread.environmentId);

      try {
        const result = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.read_file",
            path: query.path,
          },
        });
        return createDaemonFileContentResponse(result);
      } catch (error) {
        return remapDaemonFileRouteError(error);
      }
    },
  );
}
