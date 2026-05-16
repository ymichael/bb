import {
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import { hasStoredTurnStarted } from "@bb/db";
import { isUserQuestionPendingInteractionPayload } from "@bb/domain";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import { runWithDaemonCommandWaitForbidden } from "../services/hosts/command-wait-context.js";
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
    (context, payload) =>
      runWithDaemonCommandWaitForbidden({
        reason: "/session/interactive-request",
        work: async () => {
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

          if (
            isUserQuestionPendingInteractionPayload(
              payload.interaction.payload,
            ) &&
            !deps.config.featureFlags.askUserQuestion
          ) {
            return context.json({
              outcome: "rejected",
              reason: "Ask User Question feature is disabled",
            });
          }

          // Daemons must flush provider turn events before every interactive
          // registration attempt. This precondition keeps the server from
          // accepting turn-scoped interaction state before turn/started exists.
          const turnStarted = hasStoredTurnStarted(deps.db, {
            threadId: payload.interaction.threadId,
            turnId: payload.interaction.turnId,
          });
          if (!turnStarted) {
            deps.logger.warn(
              {
                providerId: payload.interaction.providerId,
                providerRequestId: payload.interaction.providerRequestId,
                providerThreadId: payload.interaction.providerThreadId,
                threadId: payload.interaction.threadId,
                turnId: payload.interaction.turnId,
              },
              "interactive request arrived before turn/started; asking daemon to retry",
            );
            throw new ApiError(
              503,
              "turn_start_not_ready",
              "Turn start has not been stored yet; retry interactive request registration",
              true,
            );
          }

          const registered =
            deps.pendingInteractions.registerPendingInteraction({
              interaction: payload.interaction,
              sessionId: payload.sessionId,
            });
          if (registered.outcome === "rejected") {
            return context.json({
              outcome: "rejected",
              reason: registered.reason,
            });
          }

          return context.json({
            outcome: registered.outcome,
            interactionId: registered.interaction.id,
            status: registered.interaction.status,
          });
        },
      }),
  );

  post(
    "/session/interactive-request/interrupt",
    hostDaemonInteractiveInterruptRequestSchema,
    (context, payload) =>
      runWithDaemonCommandWaitForbidden({
        reason: "/session/interactive-request/interrupt",
        work: () => {
          const daemon = getAuthenticatedDaemon(context);
          const session = requireAuthorizedActiveSession(deps.db, {
            hostId: daemon.hostId,
            sessionId: payload.sessionId,
          });

          const interruptibleThreadIds: string[] = [];
          for (const threadId of payload.threadIds) {
            let environmentHostId: string;
            try {
              const { environment } = requireThreadEnvironment(
                deps.db,
                threadId,
              );
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

          const interrupted =
            deps.pendingInteractions.interruptPendingInteractionsForThreads({
              providerId: payload.providerId,
              threadIds: interruptibleThreadIds,
              reason: payload.reason,
            });

          return context.json({
            ok: true,
            interactionIds: interrupted.map((interaction) => interaction.id),
          });
        },
      }),
  );
}
