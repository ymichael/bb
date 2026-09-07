import {
  claimQueuedThreadMessageGroup,
  claimNextQueuedThreadMessageGroup,
  createQueuedThreadMessageInTransaction,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getQueuedThreadMessage,
  getEnvironment,
  getThread,
  isOrdinaryTurnEndQueuedMessage,
  isThreadQueueAutoSendPaused,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
  type DbQueryConnection,
  type QueuedThreadMessageGroupClaimPolicy,
  type QueuedThreadMessageGroupEligibility,
} from "@bb/db";
import { queuedMessageSystemNoticeSchema } from "@bb/domain";
import type {
  PromptInput,
  QueuedMessageWaitingOn,
  Thread,
  ThreadQueuedMessage,
  ThreadTurnInitiator,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  SendMessageRequest,
  SendQueuedMessageMode,
} from "@bb/server-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import { isCommandTimeoutError } from "../lib/error-log-fields.js";
import {
  parseStoredQueuedThreadMessageWaitingOn,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "./thread-commands.js";
import { resolvePluginMentionContextInputs } from "../plugins/plugin-mentions.js";
import {
  prependDeferredFirstTurnContext,
  requireDeferredFirstTurnContextCurrent,
  resolveDeferredFirstTurnContext,
} from "./deferred-first-turn-context.js";
import { appendClientTurnEventInTransaction } from "./thread-events.js";
import {
  getActiveTurnId,
  getLastProviderThreadId,
  isManualCompactionActive,
} from "./thread-events.js";
import { recoverThreadModelOverride } from "./thread-execution-override.js";
import { requireReadyThreadEnvironment } from "./thread-turn-dispatch.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { hasMessageDispatchHooks } from "./dispatch-hooks.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { deliverParentSystemMessage } from "./parent-system-messages.js";
import { settleQueueRowDispatched } from "./queue-waits.js";
import { recordQueuedMessageDrainFailure } from "./queue-drain-failure.js";
import {
  ensureThreadIsWritable,
  formatAgentThreadInput,
  groupedInputForRuntime,
  resolveMessageSenderThreadId,
} from "./thread-send.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { applyLoggedEnvironmentLifecycleEvent } from "../environments/lifecycle-outcome.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import { validatePromptAttachmentReferences } from "../projects/attachments.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  ThreadContextClearInProgressError,
  withThreadSendGuard,
} from "./thread-context-mutation-guard.js";

interface SendQueuedMessageArgs {
  claimPolicy: QueuedThreadMessageGroupClaimPolicy;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
  threadId: string;
}

type ClaimedQueuedMessage = Exclude<
  ReturnType<typeof claimQueuedThreadMessageGroup>,
  null
>[number];

interface SendClaimedQueuedMessageArgs {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  /** True for an explicit "send now"; false for an ordinary drain. */
  sendNow: boolean;
  threadId: string;
}

interface SendClaimedQueuedMessageForThreadArgs {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  sendNow: boolean;
  thread: Thread;
}

export function createAutomaticQueuedMessageGroupEligibility(
  deps: Pick<AppDeps, "db">,
  args: { now: number; thread: Thread },
): QueuedThreadMessageGroupEligibility {
  const activeTurnId = getActiveTurnId(deps, args.thread.id);
  return (group) =>
    group.every((member) => {
      if (member.failureReason !== null) return false;
      const waitingOn = parseStoredQueuedThreadMessageWaitingOn(member);
      switch (waitingOn?.kind) {
        case undefined:
        case "plugin":
          return true;
        case "time":
          return member.sendAt !== null && member.sendAt <= args.now;
        case "thread-busy":
          return (
            args.thread.status === "idle" || args.thread.status === "pending"
          );
        case "turn-starting":
          return (
            args.thread.status === "idle" ||
            (args.thread.status === "active" && activeTurnId !== null)
          );
        case "provisioning":
        case "host-offline":
        case "interaction":
          return false;
      }
    });
}

async function requireReadyQueuedMessageEnvironment(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
) {
  const environment = await requireThreadCommandEnvironment(deps, { thread });
  if (environment.status === "retiring") {
    applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId: environment.id,
      event: { type: "retire.cancelled" },
    });
  }
  return requireReadyThreadEnvironment(
    getEnvironment(deps.db, environment.id) ?? environment,
  );
}

export interface CreateQueuedMessageForThreadArgs {
  payload: CreateQueuedMessageRequest;
  thread: Thread;
}

function admitQueuedMessage(
  db: DbQueryConnection,
  thread: Thread,
): { providerThreadId: string | null } {
  ensureThreadIsWritable(thread);
  const providerThreadId = getLastProviderThreadId({ db }, thread.id);
  if (thread.environmentId === null) {
    if (providerThreadId !== null) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    return { providerThreadId };
  }
  const environment = getEnvironment(db, thread.environmentId);
  const goneDetails = environment
    ? goneThreadEnvironmentDetails(environment)
    : null;
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }
  return { providerThreadId };
}

export async function createQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const { payload, thread } = args;
  ensureThreadIsWritable(thread);
  await validatePromptAttachmentReferences({
    dataDir: deps.config.dataDir,
    input: payload.input,
    projectId: thread.projectId,
  });
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });
  const { currentThread, providerThreadId, queuedMessage } =
    deps.db.transaction(
      (tx) => {
        const currentThread = getThread(tx, thread.id);
        if (!currentThread) {
          throw new ApiError(404, "thread_not_found", "Thread not found");
        }
        const { providerThreadId } = admitQueuedMessage(tx, currentThread);
        const queuedMessage = createQueuedThreadMessageInTransaction(tx, {
          threadId: thread.id,
          content: payload.input,
          senderThreadId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          permissionMode: execution.permissionMode,
          serviceTier: execution.serviceTier,
          // An explicit "queue this" is a message waiting for the running turn
          // to end, which is exactly `thread-busy`. Naming it rather than
          // leaving the wait null keeps every row on one vocabulary, and the
          // idle drain treats the two identically anyway.
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        });
        return { currentThread, providerThreadId, queuedMessage };
      },
      { behavior: "immediate" },
    );
  deps.hub.notifyThread(thread.id, ["queue-changed"]);
  if (senderThreadId === null && payload.input.length > 0) {
    deps.telemetry.capture({
      name: "user_message_sent",
      properties: {
        is_child_thread: thread.parentThreadId !== null,
        message_source: "queued_message",
        provider: thread.providerId,
      },
    });
  }
  if (currentThread.status === "idle" && providerThreadId !== null) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
  }
  return toThreadQueuedMessage(queuedMessage);
}

function isQueuedMessageAutoSendCandidate(
  thread: Thread | null,
): thread is Thread {
  return (
    thread !== null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.status !== "stopping"
  );
}

interface FormatQueuedMessageInputForSenderArgs {
  input: PromptInput[];
  senderThreadId: string | null;
}

const STALE_QUEUED_MESSAGE_CLAIM_MS = 5 * 60 * 1000;
const QUEUED_MESSAGE_CLAIM_LOST_CODE = "queued_message_claim_lost";
const QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE = "queued_message_auto_send_paused";
const activeQueuedMessageClaimTokens = new Set<string>();

function respectsManualStopPause(
  args: SendClaimedQueuedMessageForThreadArgs,
): boolean {
  return (
    args.mode === "auto" &&
    !args.sendNow &&
    args.queuedMessages.some(isOrdinaryTurnEndQueuedMessage)
  );
}

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
  mode: SendQueuedMessageMode,
  senderThreadId: string | null,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    mode,
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
    ...(senderThreadId !== null ? { senderThreadId } : {}),
  };
}

function formatQueuedMessageInputForSender(
  args: FormatQueuedMessageInputForSenderArgs,
): PromptInput[] {
  if (args.senderThreadId === null) {
    return args.input;
  }
  return formatAgentThreadInput({
    input: args.input,
    senderThreadId: args.senderThreadId,
  });
}

function releaseQueuedMessageClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  queuedMessages: readonly ClaimedQueuedMessage[],
): void {
  for (const queuedMessage of queuedMessages) {
    releaseQueuedMessageClaim(deps.db, deps.hub, {
      id: queuedMessage.id,
      claimToken: queuedMessage.claimToken,
    });
  }
}

async function withActiveQueuedMessageClaims<T>(
  queuedMessages: readonly ClaimedQueuedMessage[],
  task: () => Promise<T>,
): Promise<T> {
  for (const queuedMessage of queuedMessages) {
    activeQueuedMessageClaimTokens.add(queuedMessage.claimToken);
  }
  try {
    return await task();
  } finally {
    for (const queuedMessage of queuedMessages) {
      activeQueuedMessageClaimTokens.delete(queuedMessage.claimToken);
    }
  }
}

function claimQueuedThreadMessageForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedMessageArgs,
): ClaimedQueuedMessage[] {
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

  const claimedQueuedMessages = claimQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.queuedMessageId,
    args.claimPolicy,
  );
  if (claimedQueuedMessages) {
    return claimedQueuedMessages;
  }
  if (args.claimPolicy.kind === "automatic") return [];

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

function createQueuedMessageAutoSendPausedError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
    "Queued message auto-send was paused by a manual stop",
  );
}

function isQueuedMessageAutoSendPausedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE
  );
}

async function sendClaimedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return sendClaimedQueuedMessageForThread(deps, {
    mode: args.mode,
    queuedMessages: args.queuedMessages,
    sendNow: args.sendNow,
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
  // This fast path dispatches straight to the daemon, bypassing the dispatch
  // checkpoint. With a hook installed the drain takes the general path instead,
  // so there is exactly one place a turn is decided about. With none (the
  // overwhelming case) this check is a boolean and the drain is byte-for-byte
  // what it was before the queue carried waits: the row it claims is already
  // known drainable, so every core wait it could hit has been answered by the
  // claim query itself.
  if (hasMessageDispatchHooks()) {
    return null;
  }

  const thread = args.thread;
  if (thread.status !== "idle") {
    return null;
  }
  const providerThreadId = getLastProviderThreadId(deps, thread.id);
  if (!providerThreadId) {
    return null;
  }

  const environment = await requireReadyQueuedMessageEnvironment(deps, thread);
  const queuedMessages = args.queuedMessages.map(toThreadQueuedMessage);
  const queuedMessage = queuedMessages[0]!;

  const senderThreadId = args.queuedMessages[0]!.senderThreadId;
  let inputGroups = args.queuedMessages.map((claimedQueuedMessage) =>
    formatQueuedMessageInputForSender({
      input: toThreadQueuedMessage(claimedQueuedMessage).content,
      senderThreadId: claimedQueuedMessage.senderThreadId,
    }),
  );
  let input = groupedInputForRuntime(inputGroups);
  const pluginMentionContext = await resolvePluginMentionContextInputs(input);
  if (pluginMentionContext.length > 0) {
    input = [...input, ...pluginMentionContext];
    const lastGroup = inputGroups[inputGroups.length - 1]!;
    inputGroups = [
      ...inputGroups.slice(0, -1),
      [...lastGroup, ...pluginMentionContext],
    ];
  }
  const deferredFirstTurnContext = resolveDeferredFirstTurnContext(
    deps.db,
    thread.id,
  );
  ({ input, inputGroups } = prependDeferredFirstTurnContext(
    { input, inputGroups },
    deferredFirstTurnContext,
  ));
  const payload = sendQueuedMessagePayload(
    { ...queuedMessage, content: input },
    args.mode,
    senderThreadId,
  );
  const initiator: ThreadTurnInitiator =
    senderThreadId === null ? "user" : "agent";
  // A retry row's model is provenance — the failed attempt's tuple, replayed —
  // not a model the user picked for this row, so it must not become the
  // thread's sticky override the way a composed queued message's choice does.
  if (initiator === "user" && queuedMessage.payload.kind !== "retry") {
    await recoverThreadModelOverride(deps, {
      model: payload.model,
      modelSource: "explicit",
      thread,
    });
  }
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  const permissionEscalation = resolvePermissionEscalation({
    initiator,
  });
  await ensureHostSessionReadyForWork(deps, {
    hostId: environment.hostId,
  });
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
    environment,
    execution,
    input,
    ...(inputGroups.length > 1 ? { inputGroups } : {}),
    permissionEscalation,
    providerThreadId,
    target: { mode: "start" },
    thread,
  });

  const { activeThread, command } = deps.db.transaction(
    (tx) => {
      if (
        respectsManualStopPause(args) &&
        isThreadQueueAutoSendPaused(tx, thread.id)
      ) {
        throw createQueuedMessageAutoSendPausedError();
      }
      if (deferredFirstTurnContext) {
        requireDeferredFirstTurnContextCurrent(tx, {
          requestSequence: deferredFirstTurnContext.requestSequence,
          threadId: thread.id,
        });
      }
      const consumed = deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
        queuedMessages: args.queuedMessages,
      });
      if (!consumed) {
        throw createQueuedMessageClaimLostError();
      }
      const request = appendClientTurnEventInTransaction(tx, {
        environmentId: thread.environmentId,
        execution,
        initiator,
        input,
        ...(inputGroups.length > 1 ? { inputGroups } : {}),
        requestMethod: "turn/start",
        senderThreadId,
        source: "tell",
        target: { kind: "new-turn" },
        threadId: thread.id,
        type: "client/turn/requested",
      });
      recordAcceptedPromptHistoryEntry(
        { db: tx },
        {
          thread,
          input,
          initiator,
          target: { kind: "new-turn" },
          requestSequence: request.sequence,
        },
      );
      const command = addRequestIdToTurnSubmitCommandPayload({
        requestId: request.requestId,
        preparedCommand,
      });
      const outcome = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, logger: deps.logger },
        { event: { type: "run.started" }, threadId: thread.id },
      );
      if (!outcome.applied) {
        throw createQueuedMessageClaimLostError();
      }
      return { activeThread: outcome.thread, command };
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(
    thread.id,
    ["events-appended", "queue-changed", "status-changed"],
    {
      eventTypes: ["client/turn/requested"],
      ...buildThreadStatusChangeMetadata(deps, activeThread),
    },
  );
  startLiveHostCommand(deps, {
    command,
    hostId: environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: thread.id },
        "Live queued message command failed",
      );
    },
  });
  settleQueueRowDispatched({ row: args.queuedMessages[0]! });
  return queuedMessage;
}

/**
 * Delivers a claimed row that is one of core's own system notices.
 *
 * Such a row is not a user dispatch and does not go through the checkpoint:
 * it is an `initiator: "system"` turn with its own taxonomy and its own
 * dispatch path, and the only reason it was on the queue at all is that the
 * queue is where a blocked dispatch waits. Null when the row is an ordinary
 * message, which is every row but these.
 */
async function sendClaimedSystemNotice(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage | null> {
  const lead = args.queuedMessages[0]!;
  if (lead.systemNotice === null) {
    return null;
  }
  const notice = queuedMessageSystemNoticeSchema.parse(
    JSON.parse(lead.systemNotice),
  );
  const queuedMessage = toThreadQueuedMessage(lead);
  const delivered = await deliverParentSystemMessage(deps, {
    input: queuedMessage.content,
    parentThread: args.thread,
    systemMessageKind: notice.kind,
    systemMessageSubject: notice.subject,
  });
  if (!delivered) {
    // The thread changed under the drain. Leave the row claimed-and-released
    // by the caller's error path rather than consuming a notice nobody got.
    throw createQueuedMessageClaimLostError();
  }
  const consumed = deps.db.transaction(
    (tx) =>
      deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
        queuedMessages: args.queuedMessages,
      }),
    { behavior: "immediate" },
  );
  if (!consumed) {
    throw createQueuedMessageClaimLostError();
  }
  settleQueueRowDispatched({ row: lead });
  return queuedMessage;
}

/**
 * Re-attempts a claimed group through the dispatch checkpoint.
 *
 * The drain is nothing but a re-attempt: the same checkpoint runs, so a row
 * whose wait cleared but whose thread went busy in the meantime simply queues
 * again on the new reason rather than dispatching into a running turn. The
 * claim the caller already won is handed to the attempt, which either consumes
 * it inside the dispatch transaction (exactly once) or gives it back.
 */
async function sendClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const notice = await sendClaimedSystemNotice(deps, args);
  if (notice) {
    return notice;
  }
  const sent = await withThreadSendGuard(args.thread.id, () =>
    sendClaimedQueuedMessageForIdleProviderThread(deps, args),
  );
  if (sent) {
    return sent;
  }

  const queuedMessages = args.queuedMessages.map(toThreadQueuedMessage);
  const queuedMessage = queuedMessages[0]!;
  const inputGroups = queuedMessages.map(
    (queuedMessage) => queuedMessage.content,
  );
  const input = groupedInputForRuntime(inputGroups);
  const lead = args.queuedMessages[0]!;
  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: {
      ...sendQueuedMessagePayload(
        { ...queuedMessage, content: input },
        args.mode,
        lead.senderThreadId,
      ),
      ...(inputGroups.length > 1 ? { inputGroups } : {}),
    },
    source: {
      kind: "drain",
      claimed: args.queuedMessages,
      respectManualStopPause: respectsManualStopPause(args),
      sendNow: args.sendNow,
    },
    queuePayload: queuedMessage.payload,
    ...(queuedMessage.payload.kind === "retry"
      ? {
          retryOf: {
            requestId: queuedMessage.payload.retryOfTurnRequestId,
            attempt: queuedMessage.payload.attempt,
          },
        }
      : {}),
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "auto-dispatch",
  });
  if (args.sendNow && args.mode !== "steer" && outcome.kind === "queued") {
    // "Send now" overrides every plugin wait and the row's own schedule, but
    // not a core wait — those guard invariants rather than express a policy.
    // The row is back on the queue with its new reason; say so rather than
    // returning a success the caller would read as "it went".
    throw new ApiError(
      409,
      "queued_message_still_waiting",
      `This message cannot be sent yet: ${describeCoreWait(outcome.entry.waitingOn)}.`,
    );
  }
  return queuedMessage;
}

/** The user-facing half of a core wait, for a refused "Send now". */
function describeCoreWait(waitingOn: QueuedMessageWaitingOn | null): string {
  switch (waitingOn?.kind) {
    case "provisioning":
      return "the thread's workspace is still being prepared";
    case "host-offline":
      return `the "${waitingOn.hostName}" host is not connected`;
    case "interaction":
      return "the thread is waiting for you to answer a pending interaction";
    case "turn-starting":
      return "the current turn is still starting";
    case "plugin":
      return `it is waiting on the "${waitingOn.pluginId}" plugin`;
    case "time":
    case "thread-busy":
    case undefined:
      return "the thread is already running a turn";
  }
}

export async function sendQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const sendNow = args.claimPolicy.kind === "explicit-send";
  const queuedMessages = claimQueuedThreadMessageForSend(deps, args);
  if (queuedMessages.length === 0) {
    const existing = getQueuedThreadMessage(deps.db, args.queuedMessageId);
    if (!existing)
      throw new ApiError(404, "invalid_request", "Queued message not found");
    return toThreadQueuedMessage(existing);
  }
  const thread = getThread(deps.db, args.threadId);
  if (
    thread &&
    (isManualCompactionActive(deps, thread) ||
      (args.mode === "auto" &&
        !sendNow &&
        queuedMessages.some(isOrdinaryTurnEndQueuedMessage) &&
        isThreadQueueAutoSendPaused(deps.db, thread.id)))
  ) {
    releaseQueuedMessageClaims(deps, queuedMessages);
    return toThreadQueuedMessage(queuedMessages[0]!);
  }
  try {
    return await withActiveQueuedMessageClaims(queuedMessages, () =>
      sendClaimedQueuedMessage(deps, {
        mode: args.mode,
        queuedMessages,
        sendNow,
        threadId: args.threadId,
      }),
    );
  } catch (error) {
    releaseQueuedMessageClaims(deps, queuedMessages);
    if (
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return toThreadQueuedMessage(queuedMessages[0]!);
    }
    throw error;
  }
}

export async function sendQueuedMessageNow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    mode: SendQueuedMessageMode;
    queuedMessageId: string;
    threadId: string;
  },
): Promise<
  | { delivery: "sent" }
  | { delivery: "queued"; queuedMessage: ThreadQueuedMessage }
> {
  await sendQueuedMessage(deps, {
    claimPolicy: { kind: "explicit-send" },
    mode: args.mode,
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });
  const remainingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  return remainingQueuedMessage
    ? {
        delivery: "queued",
        queuedMessage: toThreadQueuedMessage(remainingQueuedMessage),
      }
    : { delivery: "sent" };
}

export async function sendNextQueuedMessageIfPresent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): Promise<boolean> {
  const initialThread = getThread(deps.db, args.threadId);
  if (!isQueuedMessageAutoSendCandidate(initialThread)) {
    return false;
  }

  const nextQueuedMessages = claimNextQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.threadId,
    createAutomaticQueuedMessageGroupEligibility(deps, {
      now: Date.now(),
      thread: initialThread,
    }),
  );
  if (!nextQueuedMessages) {
    return false;
  }

  const thread = getThread(deps.db, args.threadId);
  if (
    !isQueuedMessageAutoSendCandidate(thread) ||
    isManualCompactionActive(deps, thread)
  ) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);
    return false;
  }

  try {
    await withActiveQueuedMessageClaims(nextQueuedMessages, () =>
      sendClaimedQueuedMessageForThread(deps, {
        mode: "auto",
        queuedMessages: nextQueuedMessages,
        sendNow: false,
        thread,
      }),
    );
  } catch (error) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);
    if (
      isQueuedMessageClaimLostError(error) ||
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return false;
    }
    // Nobody is listening to this attempt, so the row itself has to carry what
    // happened — either as a `host-offline` wait it can recover from, or as a
    // failure reason the queued row renders. A host timeout is excluded: the
    // command is still in flight, so the attempt has not failed yet.
    if (!isCommandTimeoutError(error)) {
      recordQueuedMessageDrainFailure(deps, {
        error,
        row: nextQueuedMessages[0]!,
        thread,
      });
    }
    throw error;
  }
  return true;
}

export function releaseStaleQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): void {
  releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now - STALE_QUEUED_MESSAGE_CLAIM_MS,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}
