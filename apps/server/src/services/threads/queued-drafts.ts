import {
  claimDraft,
  claimNextDraft,
  deleteClaimedDraft,
  deleteClaimedDraftInTransaction,
  getDraft,
  getThread,
  listIdleThreadsWithQueuedDrafts,
  queueCommandInTransaction,
  releaseDraftClaim,
  releaseStaleDraftClaims,
  transitionThreadStatusInTransaction,
} from "@bb/db";
import type { Thread, ThreadQueuedMessage } from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { demoteEnvironmentIfPromoted } from "../environments/environment-promotion.js";
import { scheduleAfterDaemonIngressResponse } from "../hosts/command-wait-context.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { toQueuedMessage } from "./drafts.js";
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

interface SendQueuedDraftArgs {
  draftId: string;
  threadId: string;
}

type ClaimedDraft = Exclude<ReturnType<typeof claimDraft>, null>;

interface SendClaimedDraftArgs {
  draft: ClaimedDraft;
  threadId: string;
}

interface SendClaimedDraftForThreadArgs {
  draft: ClaimedDraft;
  thread: Thread;
}

export interface QueuedDraftAutoSendArgs {
  threadId: string;
}

export interface QueuedDraftAutoSendRequestArgs {
  draftId: string;
  threadId: string;
}

const STALE_DRAFT_CLAIM_MS = 5 * 60 * 1000;
const DRAFT_CLAIM_LOST_CODE = "draft_claim_lost";

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    mode: "auto",
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
  };
}

function claimDraftForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedDraftArgs,
): ClaimedDraft {
  const existingDraft = getDraft(deps.db, args.draftId);
  if (!existingDraft || existingDraft.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Draft not found");
  }

  const claimedDraft = claimDraft(deps.db, deps.hub, args.draftId);
  if (claimedDraft) {
    return claimedDraft;
  }

  const latestDraft = getDraft(deps.db, args.draftId);
  if (!latestDraft || latestDraft.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Draft not found");
  }
  throw new ApiError(409, "invalid_request", "Draft is already being sent");
}

function createDraftClaimLostError(): ApiError {
  return new ApiError(
    409,
    DRAFT_CLAIM_LOST_CODE,
    "Draft claim expired before it could be sent",
  );
}

function isDraftClaimLostError(error: unknown): boolean {
  return error instanceof ApiError && error.body.code === DRAFT_CLAIM_LOST_CODE;
}

async function sendClaimedDraft(
  deps: AppDeps,
  args: SendClaimedDraftArgs,
): Promise<ThreadQueuedMessage> {
  const { thread } = requireThreadEnvironment(deps.db, args.threadId);
  return sendClaimedDraftForThread(deps, {
    draft: args.draft,
    thread,
  });
}

async function sendClaimedDraftForIdleProviderThread(
  deps: AppDeps,
  args: SendClaimedDraftForThreadArgs,
): Promise<ThreadQueuedMessage | null> {
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
  const queuedMessage = toQueuedMessage(args.draft);
  ensureThreadCanQueueStartRequest(deps, thread);
  await demoteEnvironmentIfPromoted(deps, { environment });

  const payload = sendQueuedMessagePayload(queuedMessage);
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
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
    environment,
    execution,
    input: payload.input,
    permissionEscalation,
    providerThreadId,
    target: { mode: "start" },
    thread,
  });

  const sent = deps.db.transaction(
    (tx) => {
      const consumed = deleteClaimedDraftInTransaction(tx, {
        id: args.draft.id,
        claimToken: args.draft.claimToken,
      });
      if (!consumed) {
        return false;
      }
      const request = appendClientTurnEventInTransaction(tx, {
        environmentId: environment.id,
        execution,
        initiator: "user",
        input: payload.input,
        requestMethod: "turn/start",
        source: "tell",
        target: { kind: "new-turn" },
        threadId: thread.id,
        type: "client/turn/requested",
      });
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
    throw createDraftClaimLostError();
  }

  deps.hub.notifyThread(thread.id, [
    "events-appended",
    "queue-changed",
    "status-changed",
  ]);
  deps.hub.notifyCommand(environment.hostId);
  return queuedMessage;
}

async function sendClaimedDraftForThread(
  deps: AppDeps,
  args: SendClaimedDraftForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const sent = await sendClaimedDraftForIdleProviderThread(deps, args);
  if (sent) {
    return sent;
  }

  const draft = args.draft;
  const queuedMessage = toQueuedMessage(draft);
  if (!args.thread.environmentId) {
    throw new ApiError(409, "invalid_request", "Thread has no environment");
  }
  const environment = requireEnvironment(deps.db, args.thread.environmentId);
  await sendThreadMessage(deps, {
    environment,
    payload: sendQueuedMessagePayload(queuedMessage),
    thread: args.thread,
    trigger: "auto-dispatch",
  });
  const deleted = deleteClaimedDraft(deps.db, deps.hub, {
    id: draft.id,
    claimToken: draft.claimToken,
  });
  if (!deleted) {
    throw createDraftClaimLostError();
  }
  return queuedMessage;
}

export async function sendQueuedDraft(
  deps: AppDeps,
  args: SendQueuedDraftArgs,
): Promise<ThreadQueuedMessage> {
  const draft = claimDraftForSend(deps, args);
  try {
    return await sendClaimedDraft(deps, {
      draft,
      threadId: args.threadId,
    });
  } catch (error) {
    releaseDraftClaim(deps.db, deps.hub, {
      id: draft.id,
      claimToken: draft.claimToken,
    });
    throw error;
  }
}

export async function sendNextQueuedDraftIfPresent(
  deps: AppDeps,
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

  const nextDraft = claimNextDraft(deps.db, deps.hub, args.threadId);
  if (!nextDraft) {
    return false;
  }

  try {
    await sendClaimedDraftForThread(deps, {
      draft: nextDraft,
      thread,
    });
  } catch (error) {
    releaseDraftClaim(deps.db, deps.hub, {
      id: nextDraft.id,
      claimToken: nextDraft.claimToken,
    });
    if (isDraftClaimLostError(error)) {
      return false;
    }
    deps.logger.warn(
      {
        draftId: nextDraft.id,
        err: error,
        threadId: args.threadId,
      },
      "Queued draft auto-send failed",
    );
    throw error;
  }
  return true;
}

export async function runQueuedDraftAutoSendForThread(
  deps: AppDeps,
  args: QueuedDraftAutoSendArgs,
): Promise<void> {
  await deps.lifecycleDedupers.queuedDraftAutoSend.run(
    args.threadId,
    async () => {
      await sendNextQueuedDraftIfPresent(deps, {
        threadId: args.threadId,
      });
    },
  );
}

export function requestQueuedDraftAutoSendForThread(
  deps: AppDeps,
  args: QueuedDraftAutoSendRequestArgs,
): void {
  scheduleAfterDaemonIngressResponse({
    context: {
      draftId: args.draftId,
      threadId: args.threadId,
    },
    logger: deps.logger,
    name: "Queued draft auto-send request",
    work: () =>
      runQueuedDraftAutoSendForThread(deps, {
        threadId: args.threadId,
      }),
  });
}

export async function runQueuedDraftAutoSendSweep(
  deps: AppDeps,
): Promise<void> {
  releaseStaleDraftClaims(deps.db, deps.hub, {
    claimedBefore: Date.now() - STALE_DRAFT_CLAIM_MS,
  });

  for (const candidate of listIdleThreadsWithQueuedDrafts(deps.db)) {
    try {
      await runQueuedDraftAutoSendForThread(deps, {
        threadId: candidate.threadId,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          threadId: candidate.threadId,
        },
        "Queued draft auto-send sweep failed",
      );
    }
  }
}
