import {
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { requireAuthorizedActiveSession } from "./session-state.js";

export function registerInternalInteractiveRequestRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/interactive-request",
    hostDaemonInteractiveRequestSchema,
    async (context, payload) => {
      const daemon = getAuthenticatedDaemon(context);
      const session = requireAuthorizedActiveSession(deps.db, {
        hostId: daemon.hostId,
        sessionId: payload.sessionId,
      });

      const { environment } = requireThreadEnvironment(
        deps.db,
        payload.interaction.threadId,
      );
      if (environment.hostId !== session.hostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Thread does not belong to the session host",
        );
      }

      const registered = deps.pendingInteractions.registerPendingInteraction(
        payload.interaction,
      );
      if (registered.outcome === "rejected") {
        return context.json({
          outcome: "rejected",
          reason: registered.reason,
        });
      }

      const outcome = await deps.pendingInteractions.waitForTerminalState({
        interactionId: registered.interaction.id,
        signal: context.req.raw.signal,
        abortReason: "Daemon request ended while awaiting user interaction",
      });

      switch (outcome.outcome) {
        case "resolved":
          return context.json({
            outcome: "resolved",
            resolution: outcome.resolution,
          });
        case "interrupted":
        case "expired":
          return context.json({
            outcome: outcome.outcome,
            reason: outcome.reason,
          });
      }
    },
  );

  post(
    "/session/interactive-request/interrupt",
    hostDaemonInteractiveInterruptRequestSchema,
    (context, payload) => {
      const daemon = getAuthenticatedDaemon(context);
      const session = requireAuthorizedActiveSession(deps.db, {
        hostId: daemon.hostId,
        sessionId: payload.sessionId,
      });

      const interruptibleThreadIds: string[] = [];
      for (const threadId of payload.threadIds) {
        let environmentHostId: string;
        try {
          const { environment } = requireThreadEnvironment(deps.db, threadId);
          environmentHostId = environment.hostId;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            continue;
          }
          throw error;
        }
        if (environmentHostId !== session.hostId) {
          throw new ApiError(
            403,
            "invalid_request",
            "Thread does not belong to the session host",
          );
        }
        interruptibleThreadIds.push(threadId);
      }

      const interrupted = deps.pendingInteractions.interruptPendingInteractionsForThreads({
        providerId: payload.providerId,
        threadIds: interruptibleThreadIds,
        reason: payload.reason,
      });

      return context.json({
        ok: true,
        interactionIds: interrupted.map((interaction) => interaction.id),
      });
    },
  );
}
