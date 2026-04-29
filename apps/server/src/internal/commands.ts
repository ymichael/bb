import { fetchCommands } from "@bb/db";
import {
  hostDaemonCommandSchema,
  hostDaemonCommandsQuerySchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { markSandboxActivity } from "../services/hosts/host-lifecycle.js";
import { runWithDaemonCommandWaitForbidden } from "../services/hosts/command-wait-context.js";
import { parseInteger } from "../services/lib/validation.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { requireAuthorizedActiveSession } from "./session-state.js";

export function registerInternalCommandRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<HostDaemonInternalSchema>(app);

  get("/session/commands", hostDaemonCommandsQuerySchema, (context, query) =>
    runWithDaemonCommandWaitForbidden({
      reason: "/session/commands",
      work: async () => {
        const daemon = getAuthenticatedDaemon(context);
        const session = requireAuthorizedActiveSession(deps.db, {
          hostId: daemon.hostId,
          sessionId: query.sessionId,
        });
        const waitMs = parseInteger(query.waitMs, "waitMs");
        const fetchPending = () =>
          fetchCommands(deps.db, deps.hub, {
            hostId: session.hostId,
            limit: parseInteger(query.limit, "limit"),
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

        void markSandboxActivity(deps, {
          hostId: session.hostId,
          source: "commands",
        });

        return context.json({
          commands: commands.map((command) => ({
            id: command.id,
            cursor: command.cursor,
            command: hostDaemonCommandSchema.parse(JSON.parse(command.payload)),
          })),
        });
      },
    }),
  );
}
