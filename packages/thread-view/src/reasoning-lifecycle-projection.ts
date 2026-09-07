import type { ActiveThinking } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionMessage,
  EventProjectionOperationMessage,
} from "./event-projection-types.js";
import { durationToCompactString, messageId } from "./format-helpers.js";
import { eventProjectionMessageTurnScopeFields } from "./message-scope.js";
import {
  createVisibleTextBuffer,
  getVisibleTextBufferFullText,
  getVisibleTextBufferText,
  type VisibleTextBuffer,
} from "./visible-text-buffer.js";
import {
  createBufferedTextInstanceKey,
  type BufferedTextInstanceIdentity,
} from "./buffered-text-identity.js";

interface ActiveThinkingLifecycle {
  itemId: string;
  messageKey: string;
  parentToolCallId: string | null;
  sourceSeqStart: number;
  startedAt: number;
  threadId: string;
  turnId: string;
  updatedAt: number;
  updatedSeq: number;
}

interface ReasoningTurnLifecycleState {
  closedTurnIds: Set<string>;
  openTurnIds: Set<string>;
}

export interface ReasoningProjectionState {
  finalizedReasoningKeys: Set<string>;
  reasoningMessagesAwaitingCompletion: Map<
    string,
    EventProjectionOperationMessage
  >;
  openReasoningLifecyclesByKey: Map<string, ActiveThinkingLifecycle>;
  reasoningTextBuffersByKey: Map<string, VisibleTextBuffer>;
}

interface ReasoningLifecycleHostState
  extends ReasoningProjectionState, ReasoningTurnLifecycleState {
  messages: EventProjectionMessage[];
}

interface UpsertReasoningLifecycleArgs {
  identity: BufferedTextInstanceIdentity | null;
  meta: EventMeta;
  parentToolCallId: string | undefined;
  state: ReasoningLifecycleHostState;
  threadId: string;
}

type ReasoningCompletionStatus = Extract<
  EventProjectionOperationMessage["status"],
  "completed" | "interrupted"
>;

const MAX_REASONING_DETAIL_CHARS = 32_000;
const REASONING_DETAIL_TRUNCATION_SUFFIX_TAIL = " more characters truncated]";

function truncateReasoningDetail(detail: string): string {
  if (detail.length <= MAX_REASONING_DETAIL_CHARS) {
    return detail;
  }
  const dropped = detail.length - MAX_REASONING_DETAIL_CHARS;
  return `${detail.slice(0, MAX_REASONING_DETAIL_CHARS)}\n…[${dropped.toLocaleString("en-US")}${REASONING_DETAIL_TRUNCATION_SUFFIX_TAIL}`;
}

interface FinalizeReasoningLifecycleArgs {
  identity: BufferedTextInstanceIdentity | null;
  meta: EventMeta;
  state: ReasoningLifecycleHostState;
  status: ReasoningCompletionStatus;
  text: string | null;
}

interface FinalizeOpenReasoningLifecyclesArgs {
  meta: EventMeta;
  state: ReasoningLifecycleHostState;
  status: ReasoningCompletionStatus;
}

interface FinalizeOpenReasoningLifecyclesForTurnArgs extends FinalizeOpenReasoningLifecyclesArgs {
  turnId: string;
}

export function createReasoningProjectionState(): ReasoningProjectionState {
  return {
    openReasoningLifecyclesByKey: new Map(),
    reasoningTextBuffersByKey: new Map(),
    finalizedReasoningKeys: new Set(),
    reasoningMessagesAwaitingCompletion: new Map(),
  };
}

function isNewerActiveThinkingLifecycle(
  candidate: ActiveThinkingLifecycle,
  current: ActiveThinkingLifecycle,
): boolean {
  if (candidate.updatedSeq !== current.updatedSeq) {
    return candidate.updatedSeq > current.updatedSeq;
  }
  return candidate.updatedAt > current.updatedAt;
}

function findLatestActiveThinkingLifecycle(
  openLifecycles: ReadonlyMap<string, ActiveThinkingLifecycle>,
): ActiveThinkingLifecycle | null {
  let latestLifecycle: ActiveThinkingLifecycle | null = null;
  for (const lifecycle of openLifecycles.values()) {
    if (
      latestLifecycle === null ||
      isNewerActiveThinkingLifecycle(lifecycle, latestLifecycle)
    ) {
      latestLifecycle = lifecycle;
    }
  }
  return latestLifecycle;
}

function getActiveThinkingText(
  state: ReasoningProjectionState,
  messageKey: string,
): string {
  const buffer = state.reasoningTextBuffersByKey.get(messageKey);
  return (buffer ? getVisibleTextBufferText(buffer) : undefined) ?? "";
}

export function buildProjectionActiveThinking(
  state: ReasoningProjectionState,
  threadStatus: BuildEventProjectionMessagesOptions["threadStatus"],
): ActiveThinking | null {
  if (threadStatus !== "active") {
    return null;
  }

  const latestLifecycle = findLatestActiveThinkingLifecycle(
    state.openReasoningLifecyclesByKey,
  );
  if (!latestLifecycle) {
    return null;
  }

  return {
    id: latestLifecycle.itemId,
    text: getActiveThinkingText(state, latestLifecycle.messageKey),
    startedAt: latestLifecycle.startedAt,
    updatedAt: latestLifecycle.updatedAt,
  };
}

export function upsertReasoningLifecycle(
  args: UpsertReasoningLifecycleArgs,
): void {
  if (!args.identity) {
    return;
  }

  const messageKey = createBufferedTextInstanceKey(args.identity);
  if (args.state.closedTurnIds.has(args.identity.turnId)) {
    return;
  }
  if (args.state.finalizedReasoningKeys.has(messageKey)) {
    return;
  }

  args.state.openTurnIds.add(args.identity.turnId);

  const existingLifecycle =
    args.state.openReasoningLifecyclesByKey.get(messageKey);
  if (existingLifecycle) {
    existingLifecycle.updatedAt = args.meta.createdAt;
    existingLifecycle.updatedSeq = args.meta.seq;
    return;
  }

  args.state.openReasoningLifecyclesByKey.set(messageKey, {
    itemId: args.identity.itemId,
    messageKey,
    parentToolCallId: args.parentToolCallId ?? null,
    sourceSeqStart: args.meta.seq,
    startedAt: args.meta.createdAt,
    threadId: args.threadId,
    turnId: args.identity.turnId,
    updatedAt: args.meta.createdAt,
    updatedSeq: args.meta.seq,
  });
}

function finalizeReasoningLifecycleByKey(
  args: FinalizeOpenReasoningLifecyclesArgs & { messageKey: string },
): EventProjectionOperationMessage | null {
  const lifecycle = args.state.openReasoningLifecyclesByKey.get(
    args.messageKey,
  );
  const buffer = args.state.reasoningTextBuffersByKey.get(args.messageKey);
  args.state.openReasoningLifecyclesByKey.delete(args.messageKey);
  args.state.reasoningTextBuffersByKey.delete(args.messageKey);
  args.state.finalizedReasoningKeys.add(args.messageKey);
  if (!lifecycle || !buffer) {
    return null;
  }

  const detail = getVisibleTextBufferFullText(buffer);
  if (detail.trim().length === 0) {
    return null;
  }

  const message: EventProjectionOperationMessage = {
    kind: "operation",
    id: messageId(
      lifecycle.threadId,
      "op",
      `reasoning:${lifecycle.messageKey}`,
    ),
    threadId: lifecycle.threadId,
    sourceSeqStart: lifecycle.sourceSeqStart,
    sourceSeqEnd: args.meta.seq,
    createdAt: args.meta.createdAt,
    startedAt: lifecycle.startedAt,
    completedAt: args.meta.createdAt,
    ...eventProjectionMessageTurnScopeFields(lifecycle.turnId),
    ...(lifecycle.parentToolCallId
      ? { parentToolCallId: lifecycle.parentToolCallId }
      : {}),
    opType: "operation",
    title: `Thought for ${durationToCompactString(
      args.meta.createdAt - lifecycle.startedAt,
    )}`,
    detail: truncateReasoningDetail(detail),
    status: args.status,
  };
  args.state.messages.push(message);
  return message;
}

export function finalizeReasoningLifecycle(
  args: FinalizeReasoningLifecycleArgs,
): void {
  if (!args.identity) {
    return;
  }

  const messageKey = createBufferedTextInstanceKey(args.identity);
  const message =
    args.state.reasoningMessagesAwaitingCompletion.get(messageKey);
  if (message) {
    args.state.reasoningMessagesAwaitingCompletion.delete(messageKey);
    message.sourceSeqEnd = args.meta.seq;
    if (args.text?.trim()) {
      message.detail = truncateReasoningDetail(args.text);
    }
    return;
  }

  finalizeReasoningLifecycleByKey({
    meta: args.meta,
    state: args.state,
    status: args.status,
    messageKey,
  });
}

function finalizeReasoningWithoutCompletion(
  args: FinalizeOpenReasoningLifecyclesArgs & { messageKey: string },
): void {
  const message = finalizeReasoningLifecycleByKey(args);
  if (message) {
    args.state.reasoningMessagesAwaitingCompletion.set(
      args.messageKey,
      message,
    );
  }
}

export function finalizeOpenReasoningLifecycles(
  args: FinalizeOpenReasoningLifecyclesArgs,
): void {
  for (const messageKey of args.state.openReasoningLifecyclesByKey.keys()) {
    finalizeReasoningWithoutCompletion({ ...args, messageKey });
  }
}

export function finalizeOpenReasoningLifecyclesForTurn(
  args: FinalizeOpenReasoningLifecyclesForTurnArgs,
): void {
  for (const [messageKey, lifecycle] of args.state
    .openReasoningLifecyclesByKey) {
    if (lifecycle.turnId !== args.turnId) {
      continue;
    }
    finalizeReasoningWithoutCompletion({ ...args, messageKey });
  }
}

export function getReasoningTextBuffer(
  state: ReasoningProjectionState,
  messageKey: string,
): VisibleTextBuffer {
  const buffer =
    state.reasoningTextBuffersByKey.get(messageKey) ??
    createVisibleTextBuffer();
  state.reasoningTextBuffersByKey.set(messageKey, buffer);
  return buffer;
}

export function isReasoningProjectionKeyFinalized(
  state: ReasoningProjectionState,
  messageKey: string,
): boolean {
  return state.finalizedReasoningKeys.has(messageKey);
}
