import { hostDaemonCommandResultReportSchema } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { parseJsonBody } from "../services/validation.js";
import { handleCommandResult } from "./command-results.js";
import { requireActiveSession } from "./session-state.js";

export function registerInternalCommandResultRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  app.post("/session/command-result", async (context) => {
    const payload = await parseJsonBody(
      context,
      hostDaemonCommandResultReportSchema,
    );
    const session = requireActiveSession(deps.db, payload.sessionId);
    const updatedCommand = handleCommandResult(deps, payload);

    if (!updatedCommand || updatedCommand.hostId !== session.hostId) {
      throw new ApiError(404, "command_not_found", "Command not found");
    }

    return context.json({ ok: true });
  });
}
