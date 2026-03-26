import { and, eq, inArray } from "drizzle-orm";
import {
  environments,
  getHighWaterMarks,
  getThread,
  insertEvents,
  threads,
  transitionThreadStatus,
  updateThread,
} from "@bb/db";
import {
  hostDaemonEventBatchRequestSchema,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { parseJsonBody } from "../services/validation.js";
import { applyTurnCompletedEvent } from "./turn-completed-events.js";
import { requireActiveSession } from "./session-state.js";

function resolveProviderIdentifiers(
  event: HostDaemonEventEnvelope["event"],
): { providerThreadId: string | null; turnId: string | null } {
  switch (event.type) {
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/thread-title/updated":
    case "system/operation":
    case "system/provisioning":
      return { providerThreadId: null, turnId: null };
    case "thread/identity":
    case "thread/name/updated":
    case "thread/compacted":
    case "warning":
      return { providerThreadId: event.providerThreadId, turnId: null };
    case "turn/started":
    case "turn/completed":
    case "item/started":
    case "item/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "thread/tokenUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
      return {
        providerThreadId: event.providerThreadId,
        turnId: event.turnId,
      };
    case "error":
      return {
        providerThreadId: event.providerThreadId,
        turnId: event.turnId ?? null,
      };
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unsupported event type: ${_exhaustive}`);
    }
  }
}

function toStoredEvent(envelope: HostDaemonEventEnvelope) {
  const { type, threadId, ...data } = envelope.event;
  return {
    threadId: envelope.threadId,
    environmentId: envelope.environmentId,
    ...resolveProviderIdentifiers(envelope.event),
    sequence: envelope.sequence,
    type,
    data: JSON.stringify(data),
  };
}

function applyEventEffects(
  deps: Pick<AppDeps, "db" | "hub">,
  events: HostDaemonEventEnvelope[],
): void {
  for (const entry of events) {
    const event = entry.event;
    if (event.type === "turn/started") {
      const thread = getThread(deps.db, event.threadId);
      if (!thread) {
        continue;
      }
      try {
        if (thread.status === "idle" || thread.status === "error") {
          transitionThreadStatus(deps.db, deps.hub, thread.id, "active");
        }
      } catch {
        // Ignore invalid transitions caused by concurrent lifecycle changes.
      }
      continue;
    }

    if (event.type === "turn/completed") {
      applyTurnCompletedEvent(deps, event);
      continue;
    }

    if (event.type === "thread/name/updated") {
      updateThread(deps.db, deps.hub, event.threadId, {
        title: event.threadName,
      });
    }
  }
}

function validateEventBatchOwnership(
  deps: Pick<AppDeps, "db">,
  args: {
    hostId: string;
    events: HostDaemonEventEnvelope[];
  },
): void {
  const threadIds = [...new Set(args.events.map((entry) => entry.threadId))];
  if (threadIds.length === 0) {
    return;
  }

  const ownedThreadIds = deps.db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        inArray(threads.id, threadIds),
        eq(environments.hostId, args.hostId),
      ),
    )
    .all();

  if (ownedThreadIds.length !== threadIds.length) {
    throw new ApiError(
      403,
      "invalid_request",
      "Event batch contains threads that do not belong to the session host",
    );
  }
}

export function registerInternalEventRoutes(app: Hono, deps: AppDeps): void {
  app.post("/session/events", async (context) => {
    const payload = await parseJsonBody(
      context,
      hostDaemonEventBatchRequestSchema,
    );
    const session = requireActiveSession(deps.db, payload.sessionId);
    validateEventBatchOwnership(deps, {
      hostId: session.hostId,
      events: payload.events,
    });

    insertEvents(
      deps.db,
      deps.hub,
      payload.events.map((entry) => toStoredEvent(entry)),
    );

    applyEventEffects(deps, payload.events);

    return context.json({
      threadHighWaterMarks: getHighWaterMarks(
        deps.db,
        payload.events.map((event) => event.threadId),
      ),
    });
  });
}
