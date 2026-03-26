import { fetchCommands } from "@bb/db";
import { hostDaemonCommandSchema, hostDaemonCommandsQuerySchema } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { requireActiveSession } from "./session-state.js";

function parseOptionalInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerInternalCommandRoutes(app: Hono, deps: AppDeps): void {
  app.get("/session/commands", async (context) => {
    const query = hostDaemonCommandsQuerySchema.parse(context.req.query());
    const session = requireActiveSession(deps.db, query.sessionId);
    const waitMs = parseOptionalInteger(query.waitMs, 0);
    const fetchPending = () =>
      fetchCommands(deps.db, deps.hub, {
        hostId: session.hostId,
        afterCursor: parseOptionalInteger(query.afterCursor, 0),
        limit: parseOptionalInteger(query.limit, 100),
      });

    let commands = fetchPending();
    if (commands.length === 0 && waitMs > 0) {
      await deps.hub.waitForCommands(session.hostId, waitMs);
      commands = fetchPending();
    }

    if (commands.length === 0) {
      if (waitMs > 0) {
        return new Response(null, { status: 204 });
      }
      return context.json({ commands: [] });
    }

    return context.json({
      commands: commands.map((command) => ({
        id: command.id,
        cursor: command.cursor,
        command: hostDaemonCommandSchema.parse(JSON.parse(command.payload)),
      })),
    });
  });
}
