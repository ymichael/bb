import {
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import { formatPendingInteractionSubjectDetailLines } from "@bb/core-ui";
import type { PendingInteraction } from "@bb/domain";
import {
  isApprovalPendingInteractionPayload,
  isPluginExtensionInteractionRequestPayload,
  isUserQuestionPendingInteractionPayload,
  parseExtensionKind,
} from "@bb/domain";
import { getThread, hasStoredTurnStarted } from "@bb/db";
import { isParentNotifiableChildThread } from "../services/threads/thread-parent.js";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { deferAfterResponse } from "../services/lib/response-deferral.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import { queueChildThreadNeedsAttentionNotificationBestEffort } from "../services/threads/child-thread-notifications.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

interface RequestChildThreadNeedsAttentionNotificationArgs {
  blockerSummary: string | null;
  childThreadId: string;
}

const CHILD_THREAD_BLOCKER_SUMMARY_MAX_LINES = 4;
const CHILD_THREAD_BLOCKER_SUMMARY_MAX_CHARS = 700;
const CHILD_THREAD_BLOCKER_SUMMARY_TRUNCATION_MARKER =
  "\n[... summary truncated ...]";

function pendingInteractionBlockerLabel(
  interaction: PendingInteraction,
): string {
  if (isUserQuestionPendingInteractionPayload(interaction.payload)) {
    return "user question";
  }
  if (isPluginExtensionInteractionRequestPayload(interaction.payload)) {
    return `${parseExtensionKind(interaction.payload.kind).pluginId} request`;
  }
  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return "plugin request";
  }
  switch (interaction.payload.subject.kind) {
    case "command":
      return "command approval";
    case "file_change":
      return "file-change approval";
    case "permission_grant":
      return "permission grant";
    case "plan":
      return "plan review";
    case "tool_use":
      return "tool-use approval";
    default: {
      const exhaustiveCheck: never = interaction.payload.subject;
      return exhaustiveCheck;
    }
  }
}

function truncateChildThreadBlockerSummary(summary: string): string {
  if (summary.length <= CHILD_THREAD_BLOCKER_SUMMARY_MAX_CHARS) {
    return summary;
  }
  const retainedLength = Math.max(
    0,
    CHILD_THREAD_BLOCKER_SUMMARY_MAX_CHARS -
      CHILD_THREAD_BLOCKER_SUMMARY_TRUNCATION_MARKER.length,
  );
  return `${summary.slice(0, retainedLength).trimEnd()}${CHILD_THREAD_BLOCKER_SUMMARY_TRUNCATION_MARKER}`;
}

function pluginFormTitleLines(interaction: PendingInteraction): string[] {
  const { payload } = interaction;
  return isApprovalPendingInteractionPayload(payload) ||
    isUserQuestionPendingInteractionPayload(payload)
    ? []
    : [payload.title];
}

export function buildChildThreadBlockerSummary(
  interaction: PendingInteraction,
): string | null {
  const detailLines = formatPendingInteractionSubjectDetailLines(interaction);
  const details = (
    detailLines.length > 0 ? detailLines : pluginFormTitleLines(interaction)
  )
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, CHILD_THREAD_BLOCKER_SUMMARY_MAX_LINES);
  if (details.length === 0) {
    return null;
  }
  return truncateChildThreadBlockerSummary(
    [
      `Blocked on ${pendingInteractionBlockerLabel(interaction)}:`,
      ...details,
    ].join("\n"),
  );
}

function requestChildThreadNeedsAttentionNotification(
  deps: AppDeps,
  args: RequestChildThreadNeedsAttentionNotificationArgs,
): void {
  const childThread = getThread(deps.db, args.childThreadId);
  if (!childThread || !isParentNotifiableChildThread(childThread)) {
    return;
  }
  const parentThreadId = childThread.parentThreadId;

  deferAfterResponse({
    config: deps.config,
    context: {
      childThreadId: childThread.id,
      parentThreadId,
    },
    logger: deps.logger,
    name: "Child thread needs-attention notification",
    work: () =>
      queueChildThreadNeedsAttentionNotificationBestEffort(deps, {
        blockerSummary: args.blockerSummary,
        childThread,
        parentThreadId,
      }),
  });
}

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
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
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

      const registered = deps.pendingInteractions.registerPendingInteraction({
        interaction: payload.interaction,
      });
      if (registered.outcome === "rejected") {
        return context.json({
          outcome: "rejected",
          reason: registered.reason,
        });
      }
      if (registered.outcome === "created") {
        requestChildThreadNeedsAttentionNotification(deps, {
          blockerSummary: buildChildThreadBlockerSummary(
            registered.interaction,
          ),
          childThreadId: registered.interaction.threadId,
        });
      }

      return context.json({
        outcome: registered.outcome,
        interactionId: registered.interaction.id,
        status: registered.interaction.status,
      });
    },
  );

  post(
    "/session/interactive-request/interrupt",
    hostDaemonInteractiveInterruptRequestSchema,
    (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
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
  );
}
