import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import {
  requireThread,
  requireThreadEnvironment,
} from "../../services/entity-lookup.js";
import { queueCommandAndWait } from "../../services/command-wait.js";
import { buildThreadTimeline, buildTimelineToolDetails } from "../../services/timeline.js";
import {
  getLastThreadOutput,
  listThreadEventRows,
} from "../../services/thread-data.js";
import { getLastExecutionOptions } from "../../services/thread-events.js";
import { parseOptionalInteger } from "../../services/validation.js";

export function registerThreadDataRoutes(app: Hono, deps: AppDeps): void {
  app.get("/threads/:id/timeline", (context) =>
    context.json(
      buildThreadTimeline(deps.db, requireThread(deps.db, context.req.param("id")), {
        limit: parseOptionalInteger(context.req.query("limit"), "limit"),
        includeManagerDebugView: context.req.query("includeManagerDebugView") === "true",
        includeToolGroupMessages: context.req.query("includeToolGroupMessages") === "true",
      }),
    ),
  );

  app.get("/threads/:id/timeline/tool-details", (context) =>
    context.json(
      buildTimelineToolDetails(
        deps.db,
        requireThread(deps.db, context.req.param("id")),
        {
          sourceSeqStart: parseOptionalInteger(context.req.query("sourceSeqStart"), "sourceSeqStart") ?? 0,
          sourceSeqEnd: parseOptionalInteger(context.req.query("sourceSeqEnd"), "sourceSeqEnd") ?? 0,
          includeManagerDebugView: context.req.query("includeManagerDebugView") === "true",
        },
      ),
    ),
  );

  app.get("/threads/:id/output", (context) =>
    context.json({ output: getLastThreadOutput(deps.db, context.req.param("id")) }),
  );

  app.get("/threads/:id/events", (context) =>
    context.json(
      listThreadEventRows(deps.db, {
        threadId: context.req.param("id"),
        afterSeq: parseOptionalInteger(context.req.query("afterSeq"), "afterSeq"),
        limit: parseOptionalInteger(context.req.query("limit"), "limit"),
      }),
    ),
  );

  app.get("/threads/:id/default-execution-options", (context) =>
    context.json(getLastExecutionOptions(deps, context.req.param("id"))),
  );

  app.get("/threads/:id/workspace/files", async (context) => {
    const { environment } = requireThreadEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.list_files",
        environmentId: environment.id,
        ...(context.req.query("query") ? { query: context.req.query("query") } : {}),
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.list_files"].parse(rawResult).files,
    );
  });

  app.get("/threads/:id/workspace/file", async (context) => {
    const { environment } = requireThreadEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.read_file",
        environmentId: environment.id,
        path: context.req.query("path") ?? "",
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.read_file"].parse(rawResult),
    );
  });
}
