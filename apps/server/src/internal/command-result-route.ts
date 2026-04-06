import { eq } from "drizzle-orm";
import { hostDaemonCommands } from "@bb/db";
import {
  hostDaemonCommandResultReportSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { handleCommandResult } from "./command-results.js";
import { requireAuthorizedActiveSession } from "./session-state.js";

export function registerInternalCommandResultRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post("/session/command-result", hostDaemonCommandResultReportSchema, async (context, payload) => {
    const daemon = getAuthenticatedDaemon(context);
    const session = requireAuthorizedActiveSession(deps.db, {
      hostId: daemon.hostId,
      sessionId: payload.sessionId,
    });
    const command = deps.db
      .select()
      .from(hostDaemonCommands)
      .where(eq(hostDaemonCommands.id, payload.commandId))
      .get();
    if (!command || command.hostId !== session.hostId) {
      throw new ApiError(404, "command_not_found", "Command not found");
    }
    const updatedCommand = await handleCommandResult(deps, payload);

    if (!updatedCommand) {
      throw new ApiError(404, "command_not_found", "Command not found");
    }

    return context.json({ ok: true });
  });
}
