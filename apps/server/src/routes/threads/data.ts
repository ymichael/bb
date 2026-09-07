import path from "node:path";
import {
  getAppSettings,
  getLatestThreadSequence,
  getLatestStoredConversationOutlineSequence,
  listQueuedThreadMessages,
} from "@bb/db";
import type { Hono } from "hono";
import {
  PROMPT_HISTORY_ENTRY_LIMIT,
  threadEventTypeSchema,
  type ThreadEventType,
} from "@bb/domain";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
  type ThreadConversationOutlineResponse,
  type ThreadTimelineQuery,
} from "@bb/server-contract";
import type {
  AppDeps,
  LoggedWorkSessionDeps,
  WorkSessionDeps,
} from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import {
  requireEnvironment,
  requirePublicThread,
  requireReadyEnvironment,
} from "../../services/lib/entity-lookup.js";
import {
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../../services/lib/lifecycle-api-errors.js";
import { callHostRetryableOnlineRpc } from "../../services/hosts/online-rpc.js";
import {
  createDaemonFileContentResponse,
  type DaemonFileReadResult,
  remapDaemonFileRouteError,
} from "../../services/hosts/daemon-file-response.js";
import { requireThreadStoragePath } from "../../services/threads/thread-storage.js";
import { toThreadQueuedMessage } from "../../services/threads/thread-queued-messages.js";
import {
  buildThreadConversationOutlineProjectionKey,
  buildThreadTimelineWithProfile,
  buildTimelineTurnSummaryDetails,
  loadThreadConversationOutline,
  THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT,
  THREAD_TIMELINE_SEGMENT_LIMIT_MAX,
} from "../../services/threads/timeline.js";
import type {
  ThreadTimelinePageKind,
  ThreadTimelinePageRequest,
} from "../../services/threads/timeline-pagination.js";
import { createSlowThreadTimelineBuildLogger } from "../../services/threads/timeline-build-log.js";
import {
  buildThreadTimelineCacheKey,
  buildThreadTimelineParamsKey,
  createThreadTimelineCache,
} from "../../services/threads/timeline-cache.js";
import { createTimelineLatestRowsCache } from "../../services/threads/timeline-latest-rows-cache.js";
import {
  DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  truncateTimelineResponseOutputs,
} from "../../services/threads/timeline-output-truncation.js";
import { previewTimelineResponseOutputs } from "../../services/threads/timeline-output-preview.js";
import { computeTimelineRowDelta } from "@bb/server-contract";
import {
  findThreadEvent,
  getLastThreadOutput,
  listThreadEventRows,
} from "../../services/threads/thread-data.js";
import { listThreadPromptHistory } from "../../services/prompt-history.js";
import { tryResolveExistingThreadExecutionPlan } from "../../services/threads/thread-execution-plan.js";
import {
  parseBoundedPositiveOptionalInteger,
  parseInteger,
  parseOptionalInteger,
} from "../../services/lib/validation.js";
import { resolveProviderPlanCommand } from "../../services/providers/provider-plan-command.js";
import { parsePathKindInclusion } from "../path-list-inclusion.js";
import { parseFileListLimit } from "../file-list-query.js";
import { parseSafeRelativeRoutePath } from "../relative-route-path.js";

function resolveThreadProviderDisplayName(
  deps: Pick<AppDeps, "providerRegistry">,
  providerId: string,
): string | undefined {
  return deps.providerRegistry.get(providerId)?.info.displayName;
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

const RAW_FILE_NO_STORE_CACHE_CONTROL = "no-store";
const RAW_FILE_HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const RAW_FILE_CONTENT_TYPE_OPTIONS = "nosniff";
const HTML_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_HTML_PREVIEW_CSP = "sandbox allow-scripts";

function parseThreadEventTypes(
  value: string | undefined,
): ThreadEventType[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((type) => {
    const parsed = threadEventTypeSchema.safeParse(type);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_request", "Invalid event type");
    }
    return parsed.data;
  });
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
  deps: WorkSessionDeps,
  args: RequireThreadStorageTargetArgs,
): Promise<ThreadStorageTarget> {
  const thread = requirePublicThread(deps.db, args.threadId);
  if (!thread.environmentId) {
    throwThreadEnvironmentUnavailable(
      threadEnvironmentUnavailableDetails("never_attached", null),
    );
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

function isHtmlPreviewPath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(".html");
}

function assertHtmlPreviewSize(relativePath: string, sizeBytes: number): void {
  if (isHtmlPreviewPath(relativePath) && sizeBytes > HTML_PREVIEW_MAX_BYTES) {
    throw new ApiError(
      413,
      "file_too_large",
      "HTML preview exceeds the 5 MB limit",
      false,
    );
  }
}

function createRawFilePreviewResponse(
  result: DaemonFileReadResult,
  relativePath: string,
): Response {
  assertHtmlPreviewSize(relativePath, result.sizeBytes);
  const headers = new Headers({
    "cache-control": RAW_FILE_NO_STORE_CACHE_CONTROL,
    "x-content-type-options": RAW_FILE_CONTENT_TYPE_OPTIONS,
  });
  if (isHtmlPreviewPath(relativePath)) {
    headers.set("content-security-policy", GENERIC_HTML_PREVIEW_CSP);
    headers.set("content-type", RAW_FILE_HTML_CONTENT_TYPE);
  }
  return createDaemonFileContentResponse(result, { headers });
}

async function serveThreadStorageRawFile(
  deps: LoggedWorkSessionDeps,
  threadId: string,
  rawPath: string,
): Promise<Response> {
  const filePath = parseSafeRelativeRoutePath(rawPath);
  const target = await requireThreadStorageTarget(deps, { threadId });

  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file",
        path: path.join(target.storagePath, filePath.relativePath),
        rootPath: target.storagePath,
      },
    });
    return createRawFilePreviewResponse(result, filePath.relativePath);
  } catch (error) {
    return remapDaemonFileRouteError(error);
  }
}

async function serveThreadWorktreeRawFile(
  deps: LoggedWorkSessionDeps,
  threadId: string,
  rawPath: string,
): Promise<Response> {
  const filePath = parseSafeRelativeRoutePath(rawPath);
  const thread = requirePublicThread(deps.db, threadId);
  if (!thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  const environment = requireReadyEnvironment(deps.db, thread.environmentId);

  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file",
        path: path.join(environment.path, filePath.relativePath),
        rootPath: environment.path,
      },
    });
    return createRawFilePreviewResponse(result, filePath.relativePath);
  } catch (error) {
    return remapDaemonFileRouteError(error);
  }
}

export function registerThreadDataRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threads;
  const timelineCache = createThreadTimelineCache();
  const timelineLatestRowsCache = createTimelineLatestRowsCache();
  const slowTimelineBuildLogger = createSlowThreadTimelineBuildLogger({
    logger: deps.logger,
  });
  const conversationOutlineCache = new Map<
    string,
    ThreadConversationOutlineResponse["items"]
  >();
  const CONVERSATION_OUTLINE_CACHE_MAX_ENTRIES = 128;

  get(routes.timeline, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const page = parseThreadTimelinePage(query);
    const includeNestedRows = query.includeNestedRows === "true";
    const summaryOnly = query.summaryOnly === "true";
    const maxSeq = getLatestThreadSequence(deps.db, { threadId: thread.id });
    const providerDisplayName = resolveThreadProviderDisplayName(
      deps,
      thread.providerId,
    );
    const includeProviderUnhandledOperations =
      deps.config.isDevelopment ||
      getAppSettings(deps.db).showUnhandledProviderEvents;
    const eventBudget = deps.config.featureFlags.timelineWindowEventBudget;
    const keyArgs = {
      threadId: thread.id,
      status: thread.status,
      environmentId: thread.environmentId,
      providerDisplayName,
      page,
      includeNestedRows,
      summaryOnly,
      includeProviderUnhandledOperations,
    };
    const full = timelineCache.getOrBuild(
      buildThreadTimelineCacheKey({ ...keyArgs, maxSeq }),
      () => {
        const { profile, response } = buildThreadTimelineWithProfile(
          deps.db,
          thread,
          {
            eventBudget,
            includeProviderUnhandledOperations,
            includeNestedRows,
            maxInlineOutputChars: DEFAULT_MAX_INLINE_OUTPUT_CHARS,
            maxSeq,
            page,
            providerDisplayName,
            planCommand: resolveProviderPlanCommand(
              deps.providerRegistry,
              thread.providerId,
            ),
            summaryOnly,
          },
        );
        slowTimelineBuildLogger.log({ profile, threadId: thread.id });
        const truncated = truncateTimelineResponseOutputs(
          response,
          DEFAULT_MAX_INLINE_OUTPUT_CHARS,
        );
        return includeNestedRows
          ? truncated
          : previewTimelineResponseOutputs(truncated);
      },
    );

    const afterSequence = parseOptionalInteger(
      query.afterSequence,
      "afterSequence",
    );
    const paramsKey = buildThreadTimelineParamsKey(keyArgs);
    const previous =
      afterSequence === undefined
        ? undefined
        : timelineLatestRowsCache.get(paramsKey, afterSequence);
    const delta =
      previous === undefined
        ? undefined
        : computeTimelineRowDelta(previous.rows, full.rows);
    timelineLatestRowsCache.set(paramsKey, { maxSeq, rows: full.rows });

    return context.json(
      delta === undefined ? full : { ...full, rows: [], delta },
    );
  });

  get(routes.conversationOutline, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const maxSeq = getLatestThreadSequence(deps.db, { threadId: thread.id });
    const outlineSequence = getLatestStoredConversationOutlineSequence(
      deps.db,
      { threadId: thread.id },
    );
    const providerDisplayName = resolveThreadProviderDisplayName(
      deps,
      thread.providerId,
    );
    const cacheKey = JSON.stringify([
      thread.id,
      buildThreadConversationOutlineProjectionKey(
        thread,
        outlineSequence,
        providerDisplayName,
      ),
    ]);
    const cached = conversationOutlineCache.get(cacheKey);
    if (cached !== undefined) {
      conversationOutlineCache.delete(cacheKey);
      conversationOutlineCache.set(cacheKey, cached);
      return context.json({ items: cached, maxSeq });
    }
    const response = loadThreadConversationOutline(deps.db, thread, {
      maxSeq,
      outlineSequence,
      ...(providerDisplayName === undefined ? {} : { providerDisplayName }),
    });
    conversationOutlineCache.set(cacheKey, response.items);
    while (
      conversationOutlineCache.size > CONVERSATION_OUTLINE_CACHE_MAX_ENTRIES
    ) {
      const oldest = conversationOutlineCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      conversationOutlineCache.delete(oldest);
    }
    return context.json(response);
  });

  get(routes.timelineTurnSummaryDetails, (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const includeProviderUnhandledOperations =
      deps.config.isDevelopment ||
      getAppSettings(deps.db).showUnhandledProviderEvents;
    return context.json(
      buildTimelineTurnSummaryDetails(deps.db, thread, {
        includeProviderUnhandledOperations,
        providerDisplayName: resolveThreadProviderDisplayName(
          deps,
          thread.providerId,
        ),
        turnId: query.turnId,
        sourceSeqStart: parseInteger(query.sourceSeqStart, "sourceSeqStart"),
        sourceSeqEnd: parseInteger(query.sourceSeqEnd, "sourceSeqEnd"),
      }),
    );
  });

  get(routes.output, (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json({
      output: getLastThreadOutput(deps.db, context.req.param("id")),
    });
  });

  get(routes.queuedMessages, (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    return context.json(
      listQueuedThreadMessages(deps.db, threadId).map(toThreadQueuedMessage),
    );
  });

  get(routes.promptHistory, (context, query) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_ENTRY_LIMIT,
      max: PROMPT_HISTORY_ENTRY_LIMIT,
      name: "limit",
      value: query.limit,
    });

    return context.json(
      listThreadPromptHistory(deps, {
        threadId,
        limit,
      }),
    );
  });

  get(routes.events, (context, query) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      listThreadEventRows(deps.db, {
        threadId: context.req.param("id"),
        afterSeq: parseOptionalInteger(query.afterSeq, "afterSeq"),
        beforeSeq: parseOptionalInteger(query.beforeSeq, "beforeSeq"),
        limit: parseOptionalInteger(query.limit, "limit") ?? 100,
        order: query.order,
        types: parseThreadEventTypes(query.types),
      }),
    );
  });

  get(routes.eventWait, async (context, query) => {
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
  });

  get(routes.defaultExecutionOptions, async (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    return context.json(
      (
        await tryResolveExistingThreadExecutionPlan(deps, {
          executionSource: "client/turn/requested",
          input: {},
          threadId,
        })
      )?.resolvedExecution ?? null,
    );
  });

  get(routes.worktreeFile, async (context) =>
    serveThreadWorktreeRawFile(
      deps,
      context.req.param("id"),
      context.req.param("filePath"),
    ),
  );

  get(routes.storageFiles, async (context, query) => {
    const target = await requireThreadStorageTarget(deps, {
      threadId: context.req.param("id"),
    });
    const limit = parseFileListLimit(query.limit);

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
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
  });

  get(routes.storageLocation, async (context) => {
    const target = await requireThreadStorageTarget(deps, {
      threadId: context.req.param("id"),
    });
    return context.json({
      hostId: target.hostId,
      storageRootPath: target.storagePath,
    });
  });

  get(routes.storageFile, async (context) =>
    serveThreadStorageRawFile(
      deps,
      context.req.param("id"),
      context.req.param("filePath"),
    ),
  );

  get(routes.storagePaths, async (context, query) => {
    const target = await requireThreadStorageTarget(deps, {
      threadId: context.req.param("id"),
    });
    const limit = parseFileListLimit(query.limit);
    const inclusion = parsePathKindInclusion({
      includeFiles: query.includeFiles,
      includeDirectories: query.includeDirectories,
    });

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_paths",
          path: target.storagePath,
          ...(query.query ? { query: query.query } : {}),
          limit,
          includeFiles: inclusion.includeFiles,
          includeDirectories: inclusion.includeDirectories,
        },
      });
      return context.json({
        paths: result.paths,
        truncated: result.truncated,
        storageRootPath: target.storagePath,
      });
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "ENOENT") {
        return context.json({
          paths: [],
          truncated: false,
          storageRootPath: target.storagePath,
        });
      }
      throw error;
    }
  });

  get(routes.storageContent, async (context, query) => {
    validateFilePath(query.path);
    const target = await requireThreadStorageTarget(deps, {
      threadId: context.req.param("id"),
    });

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.read_file",
          path: path.join(target.storagePath, query.path),
          rootPath: target.storagePath,
        },
      });
      return createDaemonFileContentResponse(result, {
        ifNoneMatch: context.req.header("if-none-match"),
      });
    } catch (error) {
      return remapDaemonFileRouteError(error);
    }
  });

  get(routes.hostFileContent, async (context, query) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    if (!thread.environmentId) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    const environment = requireEnvironment(deps.db, thread.environmentId);

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: environment.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.read_file",
          path: query.path,
        },
      });
      return createDaemonFileContentResponse(result, {
        ifNoneMatch: context.req.header("if-none-match"),
      });
    } catch (error) {
      return remapDaemonFileRouteError(error);
    }
  });
}
