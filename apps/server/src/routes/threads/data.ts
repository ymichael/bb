import path from "node:path";
import { listDrafts } from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { threadEventTypeSchema } from "@bb/domain";
import {
  threadStorageContentQuerySchema,
  threadStorageFilesQuerySchema,
  threadEventWaitQuerySchema,
  threadEventsQuerySchema,
  threadTimelineQuerySchema,
  timelineToolDetailsQuerySchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import {
  requireEnvironment,
  requirePublicThread,
} from "../../services/entity-lookup.js";
import { queueCommandAndWait } from "../../services/command-wait.js";
import {
  createDaemonFileContentResponse,
  remapDaemonFileRouteError,
} from "../../services/daemon-file-response.js";
import { requireThreadStoragePath } from "../../services/thread-storage.js";
import { toQueuedMessage } from "../../services/drafts.js";
import { buildThreadTimeline, buildTimelineToolDetails } from "../../services/timeline.js";
import {
  findThreadEvent,
  getLastThreadOutput,
  listThreadEventRows,
} from "../../services/thread-data.js";
import { getLastExecutionOptions } from "../../services/thread-events.js";
import { parseOptionalInteger } from "../../services/validation.js";

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
  const limit = Math.min(parseOptionalInteger(rawLimit, "limit") ?? 1000, 10000);
  if (limit <= 0) {
    throw new ApiError(400, "invalid_request", "limit must be a positive integer");
  }
  return limit;
}

function requireThreadStorageTarget(
  deps: Pick<AppDeps, "db">,
  args: RequireThreadStorageTargetArgs,
): ThreadStorageTarget {
  const thread = requirePublicThread(deps.db, args.threadId);
  if (!thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  const environment = requireEnvironment(deps.db, thread.environmentId);
  return {
    hostId: environment.hostId,
    storagePath: requireThreadStoragePath(deps, {
      hostId: environment.hostId,
      threadId: thread.id,
    }),
  };
}

export function registerThreadDataRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/threads/:id/timeline", threadTimelineQuerySchema, (context, query) =>
    context.json(
      buildThreadTimeline(deps.db, requirePublicThread(deps.db, context.req.param("id")), {
        includeManagerDebugView: query.includeManagerDebugView === "true",
        includeToolGroupMessages: query.includeToolGroupMessages === "true",
      }),
    ),
  );

  get("/threads/:id/timeline/tool-details", timelineToolDetailsQuerySchema, (context, query) =>
    context.json(
      buildTimelineToolDetails(
        deps.db,
        requirePublicThread(deps.db, context.req.param("id")),
        {
          sourceSeqStart: parseOptionalInteger(query.sourceSeqStart, "sourceSeqStart") ?? 0,
          sourceSeqEnd: parseOptionalInteger(query.sourceSeqEnd, "sourceSeqEnd") ?? 0,
          includeManagerDebugView: query.includeManagerDebugView === "true",
        },
      ),
    ),
  );

  get("/threads/:id/output", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json({ output: getLastThreadOutput(deps.db, context.req.param("id")) });
  });

  get("/threads/:id/drafts", (context) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);
    return context.json(listDrafts(deps.db, threadId).map((draft) => toQueuedMessage(draft)));
  });

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

  get("/threads/:id/events/wait", threadEventWaitQuerySchema, async (context, query) => {
    const threadId = context.req.param("id");
    requirePublicThread(deps.db, threadId);

    const afterSeq = parseOptionalInteger(query.afterSeq, "afterSeq");
    const waitMs = Math.min(parseOptionalInteger(query.waitMs, "waitMs") ?? 30_000, 60_000);
    const parsedEventType = threadEventTypeSchema.safeParse(query.type);
    if (!parsedEventType.success) {
      throw new ApiError(400, "invalid_request", "Invalid event type");
    }
    const eventType = parsedEventType.data;

    const findMatch = () => findThreadEvent(deps.db, { threadId, type: eventType, afterSeq });

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

  get("/threads/:id/default-execution-options", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    return context.json(getLastExecutionOptions(deps, context.req.param("id")));
  });

  get(
    "/threads/:id/thread-storage/files",
    threadStorageFilesQuerySchema,
    async (context, query) => {
      const target = requireThreadStorageTarget(deps, {
        threadId: context.req.param("id"),
      });
      const limit = parseThreadStorageFileListLimit(query.limit);

      try {
        const rawResult = await queueCommandAndWait(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.list_files",
            path: target.storagePath,
            ...(query.query ? { query: query.query } : {}),
            limit,
          },
        });
        const result = hostDaemonCommandResultSchemaByType["host.list_files"].parse(rawResult);
        return context.json({ files: result.files, truncated: result.truncated });
      } catch (error) {
        if (error instanceof ApiError && error.body.code === "ENOENT") {
          return context.json({ files: [], truncated: false });
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
      const target = requireThreadStorageTarget(deps, {
        threadId: context.req.param("id"),
      });

      try {
        const rawResult = await queueCommandAndWait(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "host.read_file",
            path: path.join(target.storagePath, query.path),
            rootPath: target.storagePath,
          },
        });
        return createDaemonFileContentResponse(
          hostDaemonCommandResultSchemaByType["host.read_file"].parse(rawResult),
        );
      } catch (error) {
        return remapDaemonFileRouteError(error);
      }
    },
  );
}
