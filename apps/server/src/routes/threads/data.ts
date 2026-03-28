import type { Environment } from "@bb/domain";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import {
  threadEventsQuerySchema,
  threadTimelineQuerySchema,
  threadWorkspaceFileQuerySchema,
  threadWorkspaceFilesQuerySchema,
  timelineToolDetailsQuerySchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import {
  requireThreadEnvironment,
  requireThread,
} from "../../services/entity-lookup.js";
import { queueCommandAndWait } from "../../services/command-wait.js";
import { buildThreadTimeline, buildTimelineToolDetails } from "../../services/timeline.js";
import {
  getLastThreadOutput,
  listThreadEventRows,
} from "../../services/thread-data.js";
import { getLastExecutionOptions } from "../../services/thread-events.js";
import { parseOptionalInteger } from "../../services/validation.js";

function requireReadyWorkspaceEnvironment(environment: Environment): Environment & {
  path: string;
  status: "ready";
} {
  if (environment.status !== "ready" || !environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  return {
    ...environment,
    path: environment.path,
    status: "ready" as const,
  };
}

export function registerThreadDataRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/threads/:id/timeline", threadTimelineQuerySchema, (context, query) =>
    context.json(
      buildThreadTimeline(deps.db, requireThread(deps.db, context.req.param("id")), {
        limit: parseOptionalInteger(query.limit, "limit"),
        includeManagerDebugView: query.includeManagerDebugView === "true",
        includeToolGroupMessages: query.includeToolGroupMessages === "true",
      }),
    ),
  );

  get("/threads/:id/timeline/tool-details", timelineToolDetailsQuerySchema, (context, query) =>
    context.json(
      buildTimelineToolDetails(
        deps.db,
        requireThread(deps.db, context.req.param("id")),
        {
          sourceSeqStart: parseOptionalInteger(query.sourceSeqStart, "sourceSeqStart") ?? 0,
          sourceSeqEnd: parseOptionalInteger(query.sourceSeqEnd, "sourceSeqEnd") ?? 0,
          includeManagerDebugView: query.includeManagerDebugView === "true",
        },
      ),
    ),
  );

  get("/threads/:id/output", (context) =>
    context.json({ output: getLastThreadOutput(deps.db, context.req.param("id")) }),
  );

  get("/threads/:id/events", threadEventsQuerySchema, (context, query) =>
    context.json(
      listThreadEventRows(deps.db, {
        threadId: context.req.param("id"),
        afterSeq: parseOptionalInteger(query.afterSeq, "afterSeq"),
        limit: parseOptionalInteger(query.limit, "limit"),
      }),
    ),
  );

  get("/threads/:id/default-execution-options", (context) =>
    context.json(getLastExecutionOptions(deps, context.req.param("id"))),
  );

  get("/threads/:id/workspace/files", threadWorkspaceFilesQuerySchema, async (context, query) => {
    const { environment } = requireThreadEnvironment(deps.db, context.req.param("id"));
    const readyEnvironment = requireReadyWorkspaceEnvironment(environment);
    const rawResult = await queueCommandAndWait(deps, {
      hostId: readyEnvironment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.list_files",
        environmentId: readyEnvironment.id,
        environmentStatus: readyEnvironment.status,
        workspacePath: readyEnvironment.path,
        ...(query.query ? { query: query.query } : {}),
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.list_files"].parse(rawResult).files,
    );
  });

  get("/threads/:id/workspace/file", threadWorkspaceFileQuerySchema, async (context, query) => {
    const { environment } = requireThreadEnvironment(deps.db, context.req.param("id"));
    const readyEnvironment = requireReadyWorkspaceEnvironment(environment);
    const rawResult = await queueCommandAndWait(deps, {
      hostId: readyEnvironment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.read_file",
        environmentId: readyEnvironment.id,
        environmentStatus: readyEnvironment.status,
        workspacePath: readyEnvironment.path,
        path: query.path,
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.read_file"].parse(rawResult),
    );
  });
}
