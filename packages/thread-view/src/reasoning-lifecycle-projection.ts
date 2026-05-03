import type { ActiveThinking } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type { BuildEventProjectionMessagesOptions } from "./event-projection-types.js";
import { finalizeProjectionKey } from "./assistant-stream-projection.js";
import {
  createVisibleTextBuffer,
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
  startedAt: number;
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
  openReasoningLifecyclesByKey: Map<string, ActiveThinkingLifecycle>;
  reasoningTextBuffersByKey: Map<string, VisibleTextBuffer>;
}

interface ReasoningLifecycleHostState
  extends ReasoningProjectionState,
    ReasoningTurnLifecycleState {}

interface UpsertReasoningLifecycleArgs {
  identity: BufferedTextInstanceIdentity | null;
  meta: EventMeta;
  state: ReasoningLifecycleHostState;
}

export function createReasoningProjectionState(): ReasoningProjectionState {
  return {
    openReasoningLifecyclesByKey: new Map(),
    reasoningTextBuffersByKey: new Map(),
    finalizedReasoningKeys: new Set(),
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
    startedAt: args.meta.createdAt,
    turnId: args.identity.turnId,
    updatedAt: args.meta.createdAt,
    updatedSeq: args.meta.seq,
  });
}

export function trackReasoningTurn(
  state: ReasoningTurnLifecycleState,
  identity: BufferedTextInstanceIdentity | null,
): void {
  if (!identity || state.closedTurnIds.has(identity.turnId)) {
    return;
  }
  state.openTurnIds.add(identity.turnId);
}

export function finalizeReasoningLifecycle(
  state: ReasoningProjectionState,
  identity: BufferedTextInstanceIdentity | null,
): void {
  if (!identity) {
    return;
  }

  const messageKey = createBufferedTextInstanceKey(identity);
  state.openReasoningLifecyclesByKey.delete(messageKey);
  state.finalizedReasoningKeys.add(messageKey);
}

export function finalizeOpenReasoningLifecycles(
  state: ReasoningProjectionState,
): void {
  for (const messageKey of state.openReasoningLifecyclesByKey.keys()) {
    state.finalizedReasoningKeys.add(messageKey);
  }
  state.openReasoningLifecyclesByKey.clear();
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

export function finalizeReasoningTextBuffer(
  state: ReasoningProjectionState,
  messageKey: string,
): void {
  state.reasoningTextBuffersByKey.delete(messageKey);
  finalizeProjectionKey(state.finalizedReasoningKeys, messageKey);
}
