import {
  claimQueuedThreadMessage,
  claimNextQueuedThreadMessage,
  deleteClaimedQueuedThreadMessage,
  deleteClaimedQueuedThreadMessageInTransaction,
  getQueuedThreadMessage,
  getThread,
  listIdleThreadsWithQueuedMessages,
  queueCommandInTransaction,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
  transitionThreadStatusInTransaction,
} from "@bb/db";
import type { Thread, ThreadQueuedMessage } from "@bb/domain";
import type {
  SendMessageRequest,
  SendQueuedMessageMode,
} from "@bb/server-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { scheduleAfterDaemonIngressResponse } from "../hosts/command-wait-context.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import {
  requireEnvironment,
  requireThreadEnvironment,
} from "../lib/entity-lookup.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  ensureThreadNativeArchiveSettled,
  prepareTurnSubmitCommandPayload,
} from "./thread-commands.js";
import { appendClientTurnEventInTransaction } from "./thread-events.js";
import { getLastProviderThreadId } from "./thread-events.js";
import { ensureThreadCanQueueStartRequest } from "./thread-lifecycle.js";
import { requireReadyThreadEnvironment } from "./thread-turn-dispatch.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { sendThreadMessage } from "./thread-send.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";
import {
  prependManagerPreferencesSystemMessageIfChanged,
  recordManagerDynamicFileDeliveryInTransaction,
  withManagerPreferencesDeliveryLock,
} from "./manager-dynamic-file-delivery.js";

interface SendQueuedMessageArgs {
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
  threadId: string;
}

type ClaimedQueuedMessage = Exclude<
  ReturnType<typeof claimQueuedThreadMessage>,
  null
>;

interface SendClaimedQueuedMessageArgs {
  mode: SendQueuedMessageMode;
  queuedMessage: ClaimedQueuedMessage;
  threadId: string;
}

interface SendClaimedQueuedMessageForThreadArgs {
  mode: SendQueuedMessageMode;
  queuedMessage: ClaimedQueuedMessage;
  thread: Thread;
}

export interface QueuedMessageAutoSendArgs {
  threadId: string;
}

export interface QueuedMessageAutoSendRequestArgs {
  queuedMessageId: string;
  threadId: string;
}

const STALE_QUEUED_MESSAGE_CLAIM_MS = 5 * 60 * 1000;
const QUEUED_MESSAGE_CLAIM_LOST_CODE = "queued_message_claim_lost";

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
  mode: SendQueuedMessageMode,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    mode,
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
  };
}

function claimQueuedThreadMessageForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedMessageArgs,
): ClaimedQueuedMessage {
  const existingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (
    !existingQueuedMessage ||
    existingQueuedMessage.threadId !== args.threadId
  ) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  const claimedQueuedMessage = claimQueuedThreadMessage(
    deps.db,
    deps.hub,
    args.queuedMessageId,
  );
  if (claimedQueuedMessage) {
    return claimedQueuedMessage;
  }

  const latestQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (!latestQueuedMessage || latestQueuedMessage.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }
  throw new ApiError(
    409,
    "invalid_request",
    "Queued message is already being sent",
  );
}

function createQueuedMessageClaimLostError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_CLAIM_LOST_CODE,
    "Queued message claim expired before it could be sent",
  );
}

function isQueuedMessageClaimLostError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_CLAIM_LOST_CODE
  );
}

async function sendClaimedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const { thread } = requireThreadEnvironment(deps.db, args.threadId);
  return sendClaimedQueuedMessageForThread(deps, {
    mode: args.mode,
    queuedMessage: args.queuedMessage,
    thread,
  });
}

async function sendClaimedQueuedMessageForIdleProviderThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage | null> {
  if (args.mode !== "auto") {
    return null;
  }

  const thread = args.thread;
  if (thread.status !== "idle") {
    return null;
  }
  if (!thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }

  const providerThreadId = getLastProviderThreadId(deps, thread.id);
  if (!providerThreadId) {
    return null;
  }

  const environment = requireReadyThreadEnvironment(
    requireEnvironment(deps.db, thread.environmentId),
  );
  ensureThreadNativeArchiveSettled(deps, { environment, thread });
  const queuedMessage = toThreadQueuedMessage(args.queuedMessage);
  ensureThreadCanQueueStartRequest(deps, thread);

  const payload = sendQueuedMessagePayload(queuedMessage, args.mode);
  const execution = await buildExecutionOptions(
    deps,
    payload,
    { threadId: thread.id },
    "client/turn/requested",
  );
  const permissionEscalation = resolvePermissionEscalation({
    initiator: "user",
    thread,
  });
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: environment.hostId,
  });
  return await withManagerPreferencesDeliveryLock({ thread }, async () => {
    const preparedInput = await prependManagerPreferencesSystemMessageIfChanged(
      deps,
      {
        hostId: environment.hostId,
        input: payload.input,
        mode: "change-detection",
        thread,
      },
    );
    const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
      environment,
      execution,
      input: preparedInput.input,
      permissionEscalation,
      providerThreadId,
      target: { mode: "start" },
      thread,
    });

    const sent = deps.db.transaction(
      (tx) => {
        const consumed = deleteClaimedQueuedThreadMessageInTransaction(tx, {
          id: args.queuedMessage.id,
          claimToken: args.queuedMessage.claimToken,
        });
        if (!consumed) {
          return false;
        }
        const request = appendClientTurnEventInTransaction(tx, {
          environmentId: environment.id,
          execution,
          initiator: "user",
          input: preparedInput.input,
          requestMethod: "turn/start",
          senderThreadId: null,
          source: "tell",
          target: { kind: "new-turn" },
          threadId: thread.id,
          type: "client/turn/requested",
        });
        recordAcceptedPromptHistoryEntry(
          { db: tx },
          {
            thread,
            input: preparedInput.input,
            initiator: "user",
            target: { kind: "new-turn" },
            requestSequence: request.sequence,
          },
        );
        recordManagerDynamicFileDeliveryInTransaction(
          tx,
          preparedInput.stateUpdate,
        );
        const command = addRequestIdToTurnSubmitCommandPayload({
          requestId: request.requestId,
          preparedCommand,
        });
        queueCommandInTransaction(tx, {
          hostId: environment.hostId,
          sessionId: session.id,
          type: command.type,
          payload: JSON.stringify(command),
        });
        transitionThreadStatusInTransaction(tx, {
          id: thread.id,
          newStatus: "active",
        });
        return true;
      },
      { behavior: "immediate" },
    );
    if (!sent) {
      throw createQueuedMessageClaimLostError();
    }

    deps.hub.notifyThread(
      thread.id,
      ["events-appended", "queue-changed", "status-changed"],
      {
        eventTypes: ["client/turn/requested"],
      },
    );
    deps.hub.notifyCommand(environment.hostId);
    return queuedMessage;
  });
}

async function sendClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const sent = await sendClaimedQueuedMessageForIdleProviderThread(deps, args);
  if (sent) {
    return sent;
  }

  const queuedMessage = toThreadQueuedMessage(args.queuedMessage);
  if (!args.thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  const environment = requireEnvironment(deps.db, args.thread.environmentId);
  await sendThreadMessage(deps, {
    environment,
    payload: sendQueuedMessagePayload(queuedMessage, args.mode),
    thread: args.thread,
    trigger: "auto-dispatch",
  });
  const deleted = deleteClaimedQueuedThreadMessage(deps.db, deps.hub, {
    id: args.queuedMessage.id,
    claimToken: args.queuedMessage.claimToken,
  });
  if (!deleted) {
    throw createQueuedMessageClaimLostError();
  }
  return queuedMessage;
}

export async function sendQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const queuedMessage = claimQueuedThreadMessageForSend(deps, args);
  try {
    return await sendClaimedQueuedMessage(deps, {
      mode: args.mode,
      queuedMessage,
      threadId: args.threadId,
    });
  } catch (error) {
    releaseQueuedMessageClaim(deps.db, deps.hub, {
      id: queuedMessage.id,
      claimToken: queuedMessage.claimToken,
    });
    throw error;
  }
}

export async function sendNextQueuedMessageIfPresent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): Promise<boolean> {
  const thread = getThread(deps.db, args.threadId);
  if (
    !thread ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.stopRequestedAt !== null
  ) {
    return false;
  }

  const nextQueuedMessage = claimNextQueuedThreadMessage(
    deps.db,
    deps.hub,
    args.threadId,
  );
  if (!nextQueuedMessage) {
    return false;
  }

  try {
    await sendClaimedQueuedMessageForThread(deps, {
      mode: "auto",
      queuedMessage: nextQueuedMessage,
      thread,
    });
  } catch (error) {
    releaseQueuedMessageClaim(deps.db, deps.hub, {
      id: nextQueuedMessage.id,
      claimToken: nextQueuedMessage.claimToken,
    });
    if (isQueuedMessageClaimLostError(error)) {
      return false;
    }
    deps.logger.warn(
      {
        queuedMessageId: nextQueuedMessage.id,
        err: error,
        threadId: args.threadId,
      },
      "Queued message auto-send failed",
    );
    throw error;
  }
  return true;
}

export async function runQueuedMessageAutoSendForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageAutoSendArgs,
): Promise<void> {
  await deps.lifecycleDedupers.queuedMessageAutoSend.run(
    args.threadId,
    async () => {
      await sendNextQueuedMessageIfPresent(deps, {
        threadId: args.threadId,
      });
    },
  );
}

export function requestQueuedMessageAutoSendForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageAutoSendRequestArgs,
): void {
  scheduleAfterDaemonIngressResponse({
    context: {
      queuedMessageId: args.queuedMessageId,
      threadId: args.threadId,
    },
    logger: deps.logger,
    name: "Queued message auto-send request",
    work: () =>
      runQueuedMessageAutoSendForThread(deps, {
        threadId: args.threadId,
      }),
  });
}

export async function runQueuedMessageAutoSendSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: Date.now() - STALE_QUEUED_MESSAGE_CLAIM_MS,
  });

  for (const candidate of listIdleThreadsWithQueuedMessages(deps.db)) {
    try {
      await runQueuedMessageAutoSendForThread(deps, {
        threadId: candidate.threadId,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          threadId: candidate.threadId,
        },
        "Queued message auto-send sweep failed",
      );
    }
  }
}
