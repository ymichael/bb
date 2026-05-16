import { getCommand, type HostDaemonCommandRow } from "@bb/db";
import {
  hostDaemonCommandResultReportSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { ServerAppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { markSandboxActivity } from "../services/hosts/host-lifecycle.js";
import { runWithDaemonCommandWaitForbidden } from "../services/hosts/command-wait-context.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { handleCommandResult } from "./command-results.js";
import { requireAuthorizedActiveSession } from "./session-state.js";

export function registerInternalCommandResultRoutes(
  app: Hono,
  deps: ServerAppDeps,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/command-result",
    hostDaemonCommandResultReportSchema,
    (context, payload) =>
      runWithDaemonCommandWaitForbidden({
        reason: "/session/command-result",
        work: async () => {
          const daemon = getAuthenticatedDaemon(context);
          const session = requireAuthorizedActiveSession(deps.db, {
            hostId: daemon.hostId,
            sessionId: payload.sessionId,
          });
          const command = getCommand(deps.db, payload.commandId);
          if (!command || command.hostId !== session.hostId) {
            throw new ApiError(404, "command_not_found", "Command not found");
          }

          void markSandboxActivity(deps, {
            hostId: session.hostId,
            source: "command-result",
          });
          let updatedCommand: HostDaemonCommandRow | null;
          try {
            updatedCommand = await handleCommandResult(deps, payload);
          } catch (error) {
            deps.logger.error(
              {
                commandId: payload.commandId,
                commandState: command.state,
                err: error,
                reportOk: payload.ok,
                reportType: payload.type,
              },
              "Command result handling failed",
            );
            throw error;
          }

          if (!updatedCommand) {
            throw new ApiError(404, "command_not_found", "Command not found");
          }

          return context.json({
            ok: true,
          });
        },
      }),
  );
}
