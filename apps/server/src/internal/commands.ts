import { fetchCommands } from "@bb/db";
import {
  hostDaemonCommandSchema,
  hostDaemonCommandsQuerySchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { requireActiveSession } from "./session-state.js";

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected integer string, received ${value}`);
  }
  return parsed;
}

export function registerInternalCommandRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<HostDaemonInternalSchema>(app);

  get("/session/commands", hostDaemonCommandsQuerySchema, async (context, query) => {
    const session = requireActiveSession(deps.db, query.sessionId);
    const waitMs = parseInteger(query.waitMs);
    const fetchPending = () =>
      fetchCommands(deps.db, deps.hub, {
        hostId: session.hostId,
        afterCursor: parseInteger(query.afterCursor),
        limit: parseInteger(query.limit),
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
