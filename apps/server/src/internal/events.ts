import { getHighWaterMarks, insertEvents } from "@bb/db";
import { hostDaemonEventBatchRequestSchema } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { parseJsonBody } from "../services/validation.js";
import { handleTurnCompletedEvents } from "./turn-completed-events.js";
import { requireActiveSession } from "./session-state.js";

export function registerInternalEventRoutes(app: Hono, deps: AppDeps): void {
  app.post("/session/events", async (context) => {
    const payload = await parseJsonBody(
      context,
      hostDaemonEventBatchRequestSchema,
    );
    requireActiveSession(deps.db, payload.sessionId);

    insertEvents(
      deps.db,
      deps.hub,
      payload.events.map((entry) => {
        const { type, threadId, ...data } = entry.event;
        return {
          threadId: entry.threadId,
          environmentId: entry.environmentId,
          providerThreadId:
            "providerThreadId" in entry.event &&
            typeof entry.event.providerThreadId === "string"
              ? entry.event.providerThreadId
              : null,
          turnId:
            "turnId" in entry.event && typeof entry.event.turnId === "string"
              ? entry.event.turnId
              : null,
          sequence: entry.sequence,
          type,
          data: JSON.stringify(data),
        };
      }),
    );

    handleTurnCompletedEvents(
      deps,
      [...new Set(payload.events.map((event) => event.threadId))],
    );

    return context.json({
      threadHighWaterMarks: getHighWaterMarks(
        deps.db,
        payload.events.map((event) => event.threadId),
      ),
    });
  });
}
