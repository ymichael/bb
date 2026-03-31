import type { ThreadEvent } from "@bb/domain";
import type { CompactionLifecycleEvent } from "./compaction-lifecycle.js";
import { parseCompactionLifecycleEvent } from "./compaction-lifecycle.js";
import {
  getEventParentToolCallId,
  getEventProviderThreadId,
  getEventTurnId,
} from "./event-decode.js";
import type { EventMeta } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import type { ExecCallPartial } from "./exec-lifecycle.js";
import {
  createExecLifecycleContext,
  parseExecLifecycleEvent,
  parseToolCallLifecycleEvent,
} from "./exec-lifecycle.js";
import type { FileEditPartial } from "./file-edit-parsing.js";
import { parseFileEditFromItemEvent } from "./file-edit-parsing.js";
import type { WebSearchLifecycleEvent } from "./web-search-lifecycle.js";
import { parseWebSearchLifecycleEvent } from "./web-search-lifecycle.js";
import { isExploringCall } from "./tool-call-parsing.js";
import { parseOperationMessage, finalizeOperationMessage } from "./parse-operation-message.js";
import { parseErrorMessage, isDuplicateEventType, isIgnoredItemStartEvent, isIgnoredItemCompletedEvent, appendDebugEvent } from "./parse-error-message.js";
import { isIgnoredNoiseType } from "./timeline-noise-events.js";
import { normalizeSemanticViewMessages } from "./semantic-view-messages.js";
import { parseTaskMessage, shouldSuppressLowValueToolCall } from "./task-message-parsing.js";
import {
  parsePromptInput,
  userMessageSignature,
  shouldRenderThreadStartInput,
  shouldPreservePendingMessages,
  parseUserFromItemEvent,
  parseUserFromClientStart,
  parseManagerUserMessage,
} from "./user-message-parsing.js";
import {
  parseAssistantDeltaText,
  parseAssistantFinalText,
  parseReasoningDeltaText,
  parseReasoningFinalText,
  isTerminalAssistantFlushEvent,
} from "./assistant-buffering.js";
import type {
  ToViewMessagesOptions,
  ViewAssistantReasoningMessage,
  ViewAssistantTextMessage,
  ViewFileEditChange,
  ViewFileEditMessage,
  ViewMessage,
  ViewOperationMessage,
  ViewToolCallMessage,
  ViewToolCallSummary,
  ViewToolExploringMessage,
  ViewToolParsedIntent,
  ViewWebSearchMessage,
} from "@bb/domain";

// --- Projection state machine ---

interface ProjectionState {
  messages: ViewMessage[];
  seenUserKeys: Set<string>;
  openAssistantByTurn: Map<string, ViewAssistantTextMessage>;
  finalizedAssistantTurnKeys: Set<string>;
  openReasoningByTurn: Map<string, ViewAssistantReasoningMessage>;
  finalizedReasoningTurnKeys: Set<string>;
  openCompactionsByKey: Map<string, ViewOperationMessage>;
  finalizedCompactionKeys: Set<string>;
  lastCompletedCompactionKeyByThreadId: Map<string, string>;
  fileEditsByCallId: Map<string, ViewFileEditMessage>;
  delegationParentToolCallIdsByProviderThreadId: Map<string, string>;
  toolActivity: ToolActivityState;
}

type ClientInputEventType =
  | "client/thread/start"
  | "client/turn/requested"
  | "client/turn/start";

type ProjectedUserMessage = Extract<ViewMessage, { kind: "user" }>;

interface ExploringCompatibilityContext {
  turnId?: string;
  source?: string;
  parentToolCallId?: string;
}

interface PendingUserSignatureCounts {
  clientStart: Map<string, number>;
  clientThreadStart: Map<string, number>;
  clientRequested: Map<string, number>;
  provider: Map<string, number>;
}

interface ClientStartEventContext {
  eventType: ClientInputEventType;
  startSource?: string;
  isThreadStart: boolean;
  isTurnRequested: boolean;
  isTurnStart: boolean;
}

interface ProjectedClientUserArgs {
  counts: PendingUserSignatureCounts;
  signature: string;
  context: ClientStartEventContext;
}

interface ProviderUserDeduplicationArgs {
  counts: PendingUserSignatureCounts;
  signature: string;
}

function createProjectionState(): ProjectionState {
  return {
    messages: [],
    seenUserKeys: new Set(),
    openAssistantByTurn: new Map(),
    finalizedAssistantTurnKeys: new Set(),
    openReasoningByTurn: new Map(),
    finalizedReasoningTurnKeys: new Set(),
    openCompactionsByKey: new Map(),
    finalizedCompactionKeys: new Set(),
    lastCompletedCompactionKeyByThreadId: new Map(),
    fileEditsByCallId: new Map(),
    delegationParentToolCallIdsByProviderThreadId: new Map(),
    toolActivity: {
      runningCallsById: new Map(),
      activeCell: null,
      historyCells: [],
      finalizedExecCallIds: new Set(),
      finalizedWebSearchCallIds: new Set(),
    },
  };
}

const PROVIDER_THREAD_DELEGATION_TOOL_NAMES = new Set(["spawnAgent", "resumeAgent"]);
const PROVIDER_THREAD_CHILD_INTERACTION_TOOL_NAMES = new Set([
  "sendInput",
  "wait",
  "closeAgent",
]);

function getToolCallName(decoded: ThreadEvent): string | undefined {
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall"
  ) {
    return undefined;
  }

  return decoded.item.tool;
}

function getToolCallReceiverThreadIds(decoded: ThreadEvent): string[] {
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall"
  ) {
    return [];
  }

  const receiverThreadIds = decoded.item.arguments?.receiverThreadIds;
  if (!Array.isArray(receiverThreadIds)) {
    return [];
  }

  return receiverThreadIds.filter(
    (receiverThreadId): receiverThreadId is string =>
      typeof receiverThreadId === "string" && receiverThreadId.length > 0,
  );
}

interface RunningExecCall extends ViewToolCallSummary {
  threadId: string;
  toolName?: string;
  turnId?: string;
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt: number;
}

interface ToolActivityState {
  runningCallsById: Map<string, RunningExecCall>;
  activeCell: ViewToolExploringMessage | ViewToolCallMessage | ViewWebSearchMessage | null;
  historyCells: Array<ViewToolExploringMessage | ViewToolCallMessage | ViewWebSearchMessage>;
  finalizedExecCallIds: Set<string>;
  finalizedWebSearchCallIds: Set<string>;
}

function hasFinalizedProjectionKey(
  finalizedKeys: Set<string>,
  primaryKey: string,
  fallbackKey: string | undefined,
): boolean {
  return (
    finalizedKeys.has(primaryKey) ||
    (fallbackKey !== undefined && finalizedKeys.has(fallbackKey))
  );
}

function resolveOpenProjectionKey<TMessage>(
  openMessages: Map<string, TMessage>,
  primaryKey: string,
  fallbackKey: string | undefined,
): string {
  if (
    fallbackKey !== undefined &&
    openMessages.has(fallbackKey) &&
    !openMessages.has(primaryKey)
  ) {
    return fallbackKey;
  }
  return primaryKey;
}

function finalizeProjectionKeys(
  finalizedKeys: Set<string>,
  keys: Array<string | undefined>,
): void {
  for (const key of keys) {
    if (!key) continue;
    finalizedKeys.add(key);
  }
}

function getCallStatusRank(
  status: ViewToolCallMessage["status"] | undefined,
): number {
  if (!status) return 0;
  if (status === "pending") return 1;
  if (status === "interrupted") return 2;
  if (status === "completed") return 3;
  if (status === "error") return 4;
  return 0;
}

function mergeCallStatus(
  current: ViewToolCallMessage["status"] | undefined,
  incoming: ViewToolCallMessage["status"] | undefined,
): ViewToolCallMessage["status"] | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  return getCallStatusRank(incoming) >= getCallStatusRank(current)
    ? incoming
    : current;
}

function hasSemanticIntent(intents: ViewToolParsedIntent[]): boolean {
  return intents.some((intent) => intent.type !== "unknown");
}

function chooseParsedIntents(
  existing: ViewToolParsedIntent[],
  incoming: ViewToolParsedIntent[],
): ViewToolParsedIntent[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  if (!hasSemanticIntent(existing) && hasSemanticIntent(incoming)) {
    return incoming;
  }
  if (incoming.length > existing.length) return incoming;
  return existing;
}

function upsertRunningExecCall(
  existing: RunningExecCall | undefined,
  incoming: ExecCallPartial,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
): RunningExecCall {
  if (!existing) {
    return {
      callId: incoming.callId,
      threadId,
      toolName: incoming.toolName,
      command: incoming.command,
      cwd: incoming.cwd,
      parsedCmd: incoming.parsedCmd,
      source: incoming.source,
      subagentType: incoming.subagentType,
      description: incoming.description,
      output: incoming.output,
      exitCode: incoming.exitCode,
      duration: incoming.duration,
      durationMs: incoming.durationMs,
      status: incoming.status ?? "pending",
      turnId,
      parentToolCallId: incoming.parentToolCallId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
    };
  }

  // Merge strategy per field:
  //   "keep first"  — set once from the first event that provides it
  //   "keep longest" — begin events carry partial info, end events carry full info
  //   "keep latest"  — terminal state from the last event wins

  // keep first
  if (incoming.toolName && !existing.toolName) existing.toolName = incoming.toolName;
  if (incoming.cwd && !existing.cwd) existing.cwd = incoming.cwd;
  if (incoming.source && !existing.source) existing.source = incoming.source;
  if (incoming.duration && !existing.duration) existing.duration = incoming.duration;
  if (incoming.durationMs !== undefined && existing.durationMs === undefined) {
    existing.durationMs = incoming.durationMs;
  }
  if (incoming.subagentType && !existing.subagentType) {
    existing.subagentType = incoming.subagentType;
  }
  if (incoming.description && !existing.description) {
    existing.description = incoming.description;
  }
  if (!existing.turnId && turnId) existing.turnId = turnId;
  if (!existing.parentToolCallId && incoming.parentToolCallId) {
    existing.parentToolCallId = incoming.parentToolCallId;
  }

  // keep longest (begin has partial, end has full)
  if (incoming.command && (!existing.command || incoming.command.length > existing.command.length)) {
    existing.command = incoming.command;
  }
  if (incoming.output && incoming.output.length > 0) {
    if (!existing.output || incoming.output.length >= existing.output.length) {
      existing.output = incoming.output;
    }
  }

  // keep latest
  existing.threadId = threadId;
  existing.parsedCmd = chooseParsedIntents(existing.parsedCmd, incoming.parsedCmd);
  if (incoming.exitCode !== undefined) existing.exitCode = incoming.exitCode;
  existing.status = mergeCallStatus(existing.status, incoming.status) ?? "pending";
  existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
  existing.createdAt = Math.max(existing.createdAt, meta.createdAt);

  return existing;
}

function appendExecOutputDelta(
  call: RunningExecCall,
  delta: string | undefined,
): void {
  if (!delta || delta.length === 0) return;
  call.output = `${call.output ?? ""}${delta}`;
}

function getPendingSignatureCount(
  map: Map<string, number>,
  signature: string,
): number {
  return map.get(signature) ?? 0;
}

function incrementPendingSignatureCount(
  map: Map<string, number>,
  signature: string,
): void {
  map.set(signature, getPendingSignatureCount(map, signature) + 1);
}

function decrementPendingSignatureCount(
  map: Map<string, number>,
  signature: string,
): boolean {
  const count = getPendingSignatureCount(map, signature);
  if (count <= 0) {
    return false;
  }
  if (count === 1) {
    map.delete(signature);
    return true;
  }
  map.set(signature, count - 1);
  return true;
}

function getClientStartEventContext(
  eventType: ThreadEvent["type"],
  startSource: string | undefined,
): ClientStartEventContext | null {
  switch (eventType) {
    case "client/thread/start":
      return {
        eventType,
        startSource,
        isThreadStart: true,
        isTurnRequested: false,
        isTurnStart: false,
      };
    case "client/turn/requested":
      return {
        eventType,
        startSource,
        isThreadStart: false,
        isTurnRequested: true,
        isTurnStart: false,
      };
    case "client/turn/start":
      return {
        eventType,
        startSource,
        isThreadStart: false,
        isTurnRequested: false,
        isTurnStart: true,
      };
    default:
      return null;
  }
}

function shouldSkipProjectedClientUser(
  args: ProjectedClientUserArgs,
): boolean {
  const pendingThreadStartCount = getPendingSignatureCount(
    args.counts.clientThreadStart,
    args.signature,
  );
  if (
    args.context.isTurnStart &&
    args.context.startSource === "spawn" &&
    pendingThreadStartCount > 0
  ) {
    return true;
  }

  const pendingRequestedCount = getPendingSignatureCount(
    args.counts.clientRequested,
    args.signature,
  );
  if (args.context.isTurnStart && pendingRequestedCount > 0) {
    return true;
  }

  const pendingProviderCount = getPendingSignatureCount(
    args.counts.provider,
    args.signature,
  );
  if (args.context.isTurnStart && pendingProviderCount > 0) {
    decrementPendingSignatureCount(args.counts.provider, args.signature);
    return true;
  }

  return false;
}

function recordProjectedClientUser(
  args: ProjectedClientUserArgs,
): void {
  incrementPendingSignatureCount(args.counts.clientStart, args.signature);
  if (args.context.isThreadStart) {
    incrementPendingSignatureCount(args.counts.clientThreadStart, args.signature);
  }
  if (args.context.isTurnRequested) {
    incrementPendingSignatureCount(args.counts.clientRequested, args.signature);
  }
}

function consumePendingClientStartUser(
  args: ProviderUserDeduplicationArgs,
): boolean {
  const consumedClientStart = decrementPendingSignatureCount(
    args.counts.clientStart,
    args.signature,
  );
  if (!consumedClientStart) {
    return false;
  }

  decrementPendingSignatureCount(args.counts.clientThreadStart, args.signature);
  return true;
}

function buildUserMessageKey(message: ProjectedUserMessage): string {
  return `${message.turnId ?? message.id}:${message.text}`;
}

function areExploringCallsCompatible(
  a: ExploringCompatibilityContext,
  b: ExploringCompatibilityContext,
): boolean {
  const sameTurn = a.turnId === b.turnId;
  const sameSource = (a.source ?? "agent") === (b.source ?? "agent");
  const sameParent = (a.parentToolCallId ?? null) === (b.parentToolCallId ?? null);
  return sameTurn && sameSource && sameParent;
}

function syncExploringStatus(cell: ViewToolExploringMessage): void {
  cell.status = cell.calls.some((call) => call.status === "pending")
    ? "pending"
    : "completed";
}

function findCallInActiveCell(
  activeCell: ToolActivityState["activeCell"],
  callId: string,
): ViewToolCallSummary | ViewToolCallMessage | null {
  if (!activeCell) return null;
  if (activeCell.kind === "tool-call" && activeCell.callId === callId) {
    return activeCell;
  }
  if (activeCell.kind !== "tool-exploring") return null;
  return activeCell.calls.find((call) => call.callId === callId) ?? null;
}

function findCallInHistoryCells(
  state: ProjectionState,
  callId: string,
):
  | {
      cell: ViewToolExploringMessage | ViewToolCallMessage;
      call: ViewToolCallSummary | ViewToolCallMessage;
    }
  | null {
  for (let index = state.toolActivity.historyCells.length - 1; index >= 0; index -= 1) {
    const cell = state.toolActivity.historyCells[index];
    if (!cell || cell.kind === "web-search") continue;

    const call = findCallInActiveCell(cell, callId);
    if (!call) continue;

    return {
      cell,
      call,
    };
  }

  return null;
}

function mergeCallSummary(
  target: ViewToolCallSummary | ViewToolCallMessage,
  incoming: ExecCallPartial,
  {
    appendOutput,
  }: {
    appendOutput?: boolean;
  } = {},
): void {
  if (incoming.command && (!target.command || incoming.command.length > target.command.length)) {
    target.command = incoming.command;
  }
  if (incoming.cwd && !target.cwd) target.cwd = incoming.cwd;
  target.parsedCmd = chooseParsedIntents(target.parsedCmd ?? [], incoming.parsedCmd);
  if (incoming.source && !target.source) target.source = incoming.source;
  if (incoming.output && incoming.output.length > 0) {
    if (appendOutput) {
      target.output = `${target.output ?? ""}${incoming.output}`;
    } else if (!target.output || incoming.output.length >= target.output.length) {
      target.output = incoming.output;
    }
  }
  if (incoming.exitCode !== undefined) target.exitCode = incoming.exitCode;
  if (incoming.duration && !target.duration) target.duration = incoming.duration;
  if (incoming.durationMs !== undefined && target.durationMs === undefined) {
    target.durationMs = incoming.durationMs;
  }
  if (incoming.subagentType && !target.subagentType) {
    target.subagentType = incoming.subagentType;
  }
  if (incoming.description && !target.description) {
    target.description = incoming.description;
  }
  target.status = mergeCallStatus(target.status, incoming.status) ?? target.status;
}

function flushActiveToolCell(state: ProjectionState): void {
  const active = state.toolActivity.activeCell;
  if (!active) return;

  if (active.kind === "tool-exploring") {
    syncExploringStatus(active);
    for (const call of active.calls) {
      if (call.status !== "pending") {
        state.toolActivity.finalizedExecCallIds.add(call.callId);
      }
    }
  } else if (active.kind === "tool-call" && active.status !== "pending") {
    state.toolActivity.finalizedExecCallIds.add(active.callId);
  }

  state.toolActivity.historyCells.push(active);
  state.messages.push(active);
  state.toolActivity.activeCell = null;
}

function flushToolActivityBeforeNonToolMessage(state: ProjectionState): void {
  flushActiveToolCell(state);
}

function createToolCallMessage(
  call: RunningExecCall,
): ViewToolCallMessage {
  return {
    kind: "tool-call",
    id: messageId(call.threadId, "tool", call.callId),
    threadId: call.threadId,
    sourceSeqStart: call.sourceSeqStart,
    sourceSeqEnd: call.sourceSeqEnd,
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    ...(call.turnId ? { turnId: call.turnId } : {}),
    ...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}),
    toolName: call.toolName ?? "exec_command",
    callId: call.callId,
    command: call.command,
    cwd: call.cwd,
    parsedCmd: call.parsedCmd,
    source: call.source,
    subagentType: call.subagentType,
    description: call.description,
    output: call.output,
    exitCode: call.exitCode,
    duration: call.duration,
    durationMs: call.durationMs,
    status: call.status,
  };
}

function createExploringMessage(
  call: RunningExecCall,
): ViewToolExploringMessage {
  return {
    kind: "tool-exploring",
    id: messageId(
      call.threadId,
      "tool-exploring",
      `${call.callId}:${call.sourceSeqStart}`,
    ),
    threadId: call.threadId,
    sourceSeqStart: call.sourceSeqStart,
    sourceSeqEnd: call.sourceSeqEnd,
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    ...(call.turnId ? { turnId: call.turnId } : {}),
    ...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}),
    status: call.status === "pending" ? "pending" : "completed",
    calls: [call],
  };
}

function onExecBegin(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ExecCallPartial,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(incoming.callId);
  const call = upsertRunningExecCall(existingRunning, incoming, meta, threadId, turnId);
  state.toolActivity.runningCallsById.set(call.callId, call);

  const existingInActive = findCallInActiveCell(state.toolActivity.activeCell, call.callId);
  if (existingInActive) {
    mergeCallSummary(existingInActive, call);
    if (state.toolActivity.activeCell?.kind === "tool-exploring") {
      state.toolActivity.activeCell.sourceSeqEnd = Math.max(
        state.toolActivity.activeCell.sourceSeqEnd,
        call.sourceSeqEnd,
      );
      state.toolActivity.activeCell.createdAt = Math.max(
        state.toolActivity.activeCell.createdAt,
        call.createdAt,
      );
      syncExploringStatus(state.toolActivity.activeCell);
    }
    return;
  }

  const exploring = isExploringCall(call);
  const active = state.toolActivity.activeCell;

  if (exploring && active?.kind === "tool-exploring") {
    const lastCall = active.calls[active.calls.length - 1];
    if (lastCall && areExploringCallsCompatible(lastCall, call)) {
      active.calls.push(call);
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, call.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, call.createdAt);
      syncExploringStatus(active);
      return;
    }
  }

  flushActiveToolCell(state);

  if (exploring) {
    state.toolActivity.activeCell = createExploringMessage(call);
    return;
  }

  state.toolActivity.activeCell = createToolCallMessage(call);
}

function onExecOutput(
  state: ProjectionState,
  meta: EventMeta,
  incoming: ExecCallPartial,
  appendOutput?: boolean,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(incoming.callId);
  if (existingRunning) {
    if (appendOutput) {
      appendExecOutputDelta(existingRunning, incoming.output);
    } else {
      mergeCallSummary(existingRunning, incoming, { appendOutput });
    }
    existingRunning.sourceSeqEnd = Math.max(existingRunning.sourceSeqEnd, meta.seq);
    existingRunning.createdAt = Math.max(existingRunning.createdAt, meta.createdAt);
  }

  const activeCall = findCallInActiveCell(state.toolActivity.activeCell, incoming.callId);
  if (activeCall) {
    mergeCallSummary(activeCall, incoming, { appendOutput });
    if (state.toolActivity.activeCell?.kind === "tool-exploring") {
      state.toolActivity.activeCell.sourceSeqEnd = Math.max(
        state.toolActivity.activeCell.sourceSeqEnd,
        meta.seq,
      );
      state.toolActivity.activeCell.createdAt = Math.max(
        state.toolActivity.activeCell.createdAt,
        meta.createdAt,
      );
    } else if (state.toolActivity.activeCell?.kind === "tool-call") {
      state.toolActivity.activeCell.sourceSeqEnd = Math.max(
        state.toolActivity.activeCell.sourceSeqEnd,
        meta.seq,
      );
      state.toolActivity.activeCell.createdAt = Math.max(
        state.toolActivity.activeCell.createdAt,
        meta.createdAt,
      );
    }
  }

  const historyMatch = findCallInHistoryCells(state, incoming.callId);
  if (!historyMatch) return;

  mergeCallSummary(historyMatch.call, incoming, { appendOutput });
  historyMatch.cell.sourceSeqEnd = Math.max(historyMatch.cell.sourceSeqEnd, meta.seq);
  historyMatch.cell.createdAt = Math.max(historyMatch.cell.createdAt, meta.createdAt);

  if (historyMatch.cell.kind === "tool-exploring") {
    syncExploringStatus(historyMatch.cell);
  } else if (historyMatch.cell.kind === "tool-call") {
    historyMatch.cell.status =
      mergeCallStatus(historyMatch.cell.status, incoming.status) ??
      historyMatch.cell.status;
  }
}

function onExecEnd(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ExecCallPartial,
): void {
  const running = state.toolActivity.runningCallsById.get(incoming.callId);
  const merged = upsertRunningExecCall(running, incoming, meta, threadId, turnId);
  state.toolActivity.runningCallsById.delete(incoming.callId);

  const active = state.toolActivity.activeCell;
  const existingInActive = findCallInActiveCell(active, incoming.callId);
  if (existingInActive) {
    mergeCallSummary(existingInActive, merged);
    if (active?.kind === "tool-exploring") {
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, merged.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, merged.createdAt);
      syncExploringStatus(active);
      state.toolActivity.finalizedExecCallIds.add(incoming.callId);
      return;
    }

    if (active?.kind === "tool-call") {
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, merged.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, merged.createdAt);
      active.status = mergeCallStatus(active.status, merged.status) ?? active.status;
      active.output = merged.output ?? active.output;
      active.exitCode = merged.exitCode ?? active.exitCode;
      active.duration = merged.duration ?? active.duration;
      active.durationMs = merged.durationMs ?? active.durationMs;
      state.toolActivity.finalizedExecCallIds.add(incoming.callId);
      flushActiveToolCell(state);
      return;
    }
  }

  if (state.toolActivity.finalizedExecCallIds.has(incoming.callId)) {
    return;
  }

  const historyMatch = findCallInHistoryCells(state, incoming.callId);
  if (historyMatch) {
    mergeCallSummary(historyMatch.call, merged);
    historyMatch.cell.sourceSeqEnd = Math.max(
      historyMatch.cell.sourceSeqEnd,
      merged.sourceSeqEnd,
    );
    historyMatch.cell.createdAt = Math.max(
      historyMatch.cell.createdAt,
      merged.createdAt,
    );

    if (historyMatch.cell.kind === "tool-exploring") {
      syncExploringStatus(historyMatch.cell);
    } else {
      historyMatch.cell.status =
        mergeCallStatus(historyMatch.cell.status, merged.status) ??
        historyMatch.cell.status;
      historyMatch.cell.output = merged.output ?? historyMatch.cell.output;
      historyMatch.cell.exitCode = merged.exitCode ?? historyMatch.cell.exitCode;
      historyMatch.cell.duration = merged.duration ?? historyMatch.cell.duration;
      historyMatch.cell.durationMs = merged.durationMs ?? historyMatch.cell.durationMs;
    }

    state.toolActivity.finalizedExecCallIds.add(incoming.callId);
    return;
  }

  flushActiveToolCell(state);

  if (isExploringCall(merged)) {
    const exploringMessage = createExploringMessage(merged);
    syncExploringStatus(exploringMessage);
    state.toolActivity.activeCell = exploringMessage;
    flushActiveToolCell(state);
    return;
  }

  const toolCall = createToolCallMessage(merged);
  toolCall.status = mergeCallStatus(toolCall.status, incoming.status) ?? toolCall.status;
  state.toolActivity.activeCell = toolCall;
  flushActiveToolCell(state);
}

function onWebSearchBegin(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebSearchLifecycleEvent,
): void {
  if (state.toolActivity.finalizedWebSearchCallIds.has(payload.callId)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (active?.kind === "web-search" && active.callId === payload.callId) {
    active.sourceSeqEnd = Math.max(active.sourceSeqEnd, meta.seq);
    active.createdAt = Math.max(active.createdAt, meta.createdAt);
    if (payload.query) active.query = payload.query;
    if (payload.action) active.action = payload.action;
    if (payload.output) active.output = payload.output;
    return;
  }

  flushActiveToolCell(state);
  state.toolActivity.activeCell = {
    kind: "web-search",
    id: messageId(threadId, "web-search", payload.callId),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    ...(payload.parentToolCallId ? { parentToolCallId: payload.parentToolCallId } : {}),
    callId: payload.callId,
    query: payload.query,
    action: payload.action,
    output: payload.output,
    status: "pending",
  };
}

function onWebSearchEnd(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebSearchLifecycleEvent,
): void {
  if (state.toolActivity.finalizedWebSearchCallIds.has(payload.callId)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (active?.kind === "web-search" && active.callId === payload.callId) {
    active.sourceSeqEnd = Math.max(active.sourceSeqEnd, meta.seq);
    active.createdAt = Math.max(active.createdAt, meta.createdAt);
    if (payload.query) active.query = payload.query;
    if (payload.action) active.action = payload.action;
    if (payload.output) active.output = payload.output;
    active.status = "completed";
    flushActiveToolCell(state);
    state.toolActivity.finalizedWebSearchCallIds.add(payload.callId);
    return;
  }

  flushActiveToolCell(state);

  state.messages.push({
    kind: "web-search",
    id: messageId(threadId, "web-search", `${payload.callId}:${meta.seq}`),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    ...(payload.parentToolCallId ? { parentToolCallId: payload.parentToolCallId } : {}),
    callId: payload.callId,
    query: payload.query,
    action: payload.action,
    output: payload.output,
    status: "completed",
  });
  state.toolActivity.finalizedWebSearchCallIds.add(payload.callId);
}

function mergeFileChanges(
  existing: ViewFileEditChange[],
  incoming: ViewFileEditChange[],
): ViewFileEditChange[] {
  const byPath = new Map<string, ViewFileEditChange>();

  for (const change of existing) {
    byPath.set(change.path, { ...change });
  }

  for (const change of incoming) {
    const prev = byPath.get(change.path);
    if (!prev) {
      byPath.set(change.path, { ...change });
      continue;
    }

    byPath.set(change.path, {
      path: change.path,
      kind: change.kind ?? prev.kind,
      movePath: change.movePath ?? prev.movePath,
      diff: change.diff ?? prev.diff,
    });
  }

  return [...byPath.values()];
}

function upsertFileEdit(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  partial: FileEditPartial,
): void {
  const existing = state.fileEditsByCallId.get(partial.callId);

  if (!existing) {
    const message: ViewFileEditMessage = {
      kind: "file-edit",
      id: messageId(threadId, "file-edit", partial.callId),
      threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      ...(turnId ? { turnId } : {}),
      ...(partial.parentToolCallId ? { parentToolCallId: partial.parentToolCallId } : {}),
      callId: partial.callId,
      changes: partial.changes ?? [],
      stdout: partial.stdout,
      stderr: partial.stderr,
      status: partial.status ?? "pending",
    };
    state.fileEditsByCallId.set(partial.callId, message);
    state.messages.push(message);
    return;
  }

  existing.sourceSeqEnd = meta.seq;
  existing.createdAt = meta.createdAt;

  if (!existing.turnId && turnId) existing.turnId = turnId;
  if (!existing.parentToolCallId && partial.parentToolCallId) {
    existing.parentToolCallId = partial.parentToolCallId;
  }

  if (partial.changes && partial.changes.length > 0) {
    existing.changes = mergeFileChanges(existing.changes, partial.changes);
  }

  if (partial.stdout) {
    if (partial.appendStdout) {
      existing.stdout = `${existing.stdout ?? ""}${partial.stdout}`;
    } else {
      existing.stdout = partial.stdout;
    }
  }

  if (partial.stderr) {
    existing.stderr = partial.stderr;
  }

  if (partial.status) {
    if (partial.status === "error") {
      existing.status = "error";
    } else if (existing.status === "pending" || existing.status === "interrupted") {
      existing.status = partial.status;
    } else if (existing.status !== "error" && partial.status === "completed") {
      existing.status = "completed";
    }
  }
}

function onCompactionBegin(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
): void {
  if (state.finalizedCompactionKeys.has(payload.key)) {
    return;
  }

  const existing = state.openCompactionsByKey.get(payload.key);
  if (existing) {
    existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
    existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
    existing.status = "pending";
    existing.title = "Context compacting...";
    existing.detail = payload.detail ?? existing.detail;
    return;
  }

  const message: ViewOperationMessage = {
    kind: "operation",
    id: messageId(threadId, "op", `compaction:${payload.key}`),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    opType: "compaction",
    title: "Context compacting...",
    detail: payload.detail,
    status: "pending",
  };
  state.openCompactionsByKey.set(payload.key, message);
  state.messages.push(message);
}

function onCompactionEnd(
  state: ProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: CompactionLifecycleEvent,
): void {
  const existing = state.openCompactionsByKey.get(payload.key);
  if (existing) {
    existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
    existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
    existing.status = "completed";
    existing.title = "Context compacted";
    existing.detail = payload.detail ?? existing.detail;
    state.openCompactionsByKey.delete(payload.key);
    state.finalizedCompactionKeys.add(payload.key);
    state.lastCompletedCompactionKeyByThreadId.set(threadId, payload.key);
    return;
  }

  if (state.finalizedCompactionKeys.has(payload.key)) {
    return;
  }

  state.messages.push({
    kind: "operation",
    id: messageId(threadId, "op", `compaction:${payload.key}`),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    opType: "compaction",
    title: "Context compacted",
    detail: payload.detail,
    status: "completed",
  });
  state.finalizedCompactionKeys.add(payload.key);
  state.lastCompletedCompactionKeyByThreadId.set(threadId, payload.key);
}

function resolveProjectedCompactionEvent(
  state: ProjectionState,
  decoded: ThreadEvent,
  payload: CompactionLifecycleEvent,
): CompactionLifecycleEvent {
  if (
    decoded.type === "thread/compacted" &&
    getEventTurnId(decoded) === undefined
  ) {
    if (state.openCompactionsByKey.size === 1) {
      const [onlyOpenKey] = state.openCompactionsByKey.keys();
      if (onlyOpenKey) {
        return {
          ...payload,
          key: onlyOpenKey,
        };
      }
    }
    const lastCompletedKey = state.lastCompletedCompactionKeyByThreadId.get(
      decoded.threadId,
    );
    if (lastCompletedKey) {
      return {
        ...payload,
        key: lastCompletedKey,
      };
    }
  }
  return payload;
}

function flushBufferedAssistantMessages(state: ProjectionState): void {
  if (state.openAssistantByTurn.size === 0) {
    return;
  }

  const pendingAssistants = Array.from(state.openAssistantByTurn.entries()).sort(
    (left, right) =>
      left[1].sourceSeqStart - right[1].sourceSeqStart ||
      left[1].sourceSeqEnd - right[1].sourceSeqEnd ||
      left[1].createdAt - right[1].createdAt,
  );

  flushToolActivityBeforeNonToolMessage(state);
  for (const [turnKey, assistant] of pendingAssistants) {
    if (assistant.status === "streaming") {
      assistant.status = "completed";
    }
    state.messages.push(assistant);
    state.finalizedAssistantTurnKeys.add(turnKey);
  }
  state.openAssistantByTurn.clear();
}

function finalizePendingMessages(
  state: ProjectionState,
  options: ToViewMessagesOptions | undefined,
): void {
  const shouldPreservePending = shouldPreservePendingMessages(options?.threadStatus);
  const shouldFinalizeBufferedAssistants =
    options?.threadStatus !== undefined && !shouldPreservePending;
  if (shouldPreservePending) {
    flushActiveToolCell(state);
    return;
  }

  for (const call of state.toolActivity.runningCallsById.values()) {
    call.status = mergeCallStatus(call.status, "interrupted") ?? "interrupted";
    if (!call.output) {
      call.output = "Tool execution interrupted";
    }

    const activeCall = findCallInActiveCell(state.toolActivity.activeCell, call.callId);
    if (activeCall) {
      mergeCallSummary(activeCall, {
        ...call,
        parsedCmd: call.parsedCmd,
      });
      continue;
    }

    const historyMatch = findCallInHistoryCells(state, call.callId);
    if (historyMatch) {
      mergeCallSummary(historyMatch.call, {
        ...call,
        parsedCmd: call.parsedCmd,
      });
      if (historyMatch.cell.kind === "tool-exploring") {
        syncExploringStatus(historyMatch.cell);
      }
      continue;
    }

    state.messages.push(createToolCallMessage(call));
  }
  state.toolActivity.runningCallsById.clear();

  if (state.toolActivity.activeCell?.kind === "tool-call") {
    if (state.toolActivity.activeCell.status === "pending") {
      state.toolActivity.activeCell.status = "interrupted";
      if (!state.toolActivity.activeCell.output) {
        state.toolActivity.activeCell.output = "Tool execution interrupted";
      }
    }
  } else if (state.toolActivity.activeCell?.kind === "tool-exploring") {
    for (const call of state.toolActivity.activeCell.calls) {
      if (call.status === "pending") {
        call.status = "interrupted";
        if (!call.output) {
          call.output = "Tool execution interrupted";
        }
      }
    }
    syncExploringStatus(state.toolActivity.activeCell);
  } else if (state.toolActivity.activeCell?.kind === "web-search") {
    state.toolActivity.activeCell.status = "completed";
  }

  for (const fileEdit of state.fileEditsByCallId.values()) {
    if (fileEdit.status === "pending") {
      fileEdit.status = "interrupted";
    }
  }

  if (shouldFinalizeBufferedAssistants) {
    flushBufferedAssistantMessages(state);
  }

  for (const reasoning of state.openReasoningByTurn.values()) {
    if (reasoning.status === "streaming") {
      reasoning.status = "completed";
    }
  }
  state.openReasoningByTurn.clear();

  for (const message of state.messages) {
    if (message.kind !== "operation") continue;
    finalizeOperationMessage(message, options);
  }

  flushActiveToolCell(state);
}

// --- Main entry point ---

/** A typed thread event paired with its row metadata. */
export interface ThreadEventWithMeta {
  event: ThreadEvent;
  meta: EventMeta;
}

export function toViewMessages(
  events: ThreadEventWithMeta[] | undefined,
  options?: ToViewMessagesOptions,
): ViewMessage[] {
  if (!events || events.length === 0) return [];

  const state = createProjectionState();
  const includeDebugRawEvents = options?.includeDebugRawEvents ?? false;
  const includeInternalSystemMessages =
    options?.includeInternalSystemMessages ?? false;

  let areEventsOrdered = true;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].meta.seq > events[index].meta.seq) {
      areEventsOrdered = false;
      break;
    }
  }
  const orderedEvents = areEventsOrdered
    ? events
    : [...events].sort((a, b) => a.meta.seq - b.meta.seq);
  const pendingUserSignatureCounts: PendingUserSignatureCounts = {
    clientStart: new Map(),
    clientThreadStart: new Map(),
    clientRequested: new Map(),
    provider: new Map(),
  };
  const execLifecycleContext = createExecLifecycleContext();

  for (const { event: decoded, meta } of orderedEvents) {
    const eventType = decoded.type;
    const eventTurnId = getEventTurnId(decoded);
    const eventProviderThreadId = getEventProviderThreadId(decoded);
    const explicitEventParentToolCallId = getEventParentToolCallId(decoded);
    const eventParentToolCallId =
      explicitEventParentToolCallId ??
      (eventProviderThreadId
        ? state.delegationParentToolCallIdsByProviderThreadId.get(eventProviderThreadId)
        : undefined);

    if (eventType === "turn/completed") {
      pendingUserSignatureCounts.clientStart.clear();
      pendingUserSignatureCounts.clientThreadStart.clear();
      pendingUserSignatureCounts.clientRequested.clear();
      pendingUserSignatureCounts.provider.clear();
    }

    if (state.openAssistantByTurn.size > 0 && isTerminalAssistantFlushEvent(eventType)) {
      flushBufferedAssistantMessages(state);
    }

    if (
      decoded.type === "client/thread/start" ||
      decoded.type === "client/turn/requested" ||
      decoded.type === "client/turn/start"
    ) {
      if (
        decoded.initiator === "system" &&
        !includeInternalSystemMessages
      ) {
        const parsedInput = parsePromptInput(decoded.input);
        if (parsedInput && shouldRenderThreadStartInput(options?.threadStatus)) {
          const signature = userMessageSignature({
            text: parsedInput.text,
            webImages: parsedInput.webImages,
            localImages: parsedInput.localImages,
            localFiles: parsedInput.localFiles,
          });
          const clientStartContext = getClientStartEventContext(
            decoded.type,
            decoded.source,
          );
          if (
            clientStartContext &&
            shouldSkipProjectedClientUser({
              counts: pendingUserSignatureCounts,
              signature,
              context: clientStartContext,
            })
          ) {
            continue;
          }
          if (clientStartContext) {
            recordProjectedClientUser({
              counts: pendingUserSignatureCounts,
              signature,
              context: clientStartContext,
            });
          }
        }
        continue;
      }
    }

    const userFromClientThreadStart = parseUserFromClientStart(
      decoded,
      meta,
      options,
    );
    if (userFromClientThreadStart) {
      const signature = userMessageSignature({
        text: userFromClientThreadStart.text,
        webImages: userFromClientThreadStart.attachments?.webImages ?? 0,
        localImages: userFromClientThreadStart.attachments?.localImages ?? 0,
        localFiles: userFromClientThreadStart.attachments?.localFiles ?? 0,
      });
      const clientStartContext = getClientStartEventContext(
        decoded.type,
        (
          decoded.type === "client/thread/start" ||
          decoded.type === "client/turn/requested" ||
          decoded.type === "client/turn/start"
        )
          ? decoded.source
          : undefined,
      );
      if (
        clientStartContext &&
        shouldSkipProjectedClientUser({
          counts: pendingUserSignatureCounts,
          signature,
          context: clientStartContext,
        })
      ) {
        continue;
      }
      const key = buildUserMessageKey(userFromClientThreadStart);
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        if (clientStartContext) {
          recordProjectedClientUser({
            counts: pendingUserSignatureCounts,
            signature,
            context: clientStartContext,
          });
        }
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(userFromClientThreadStart);
      }
      continue;
    }

    const managerUserMessage = parseManagerUserMessage(decoded, meta);
    if (managerUserMessage) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(managerUserMessage);
      continue;
    }

    const userMessage = parseUserFromItemEvent(decoded, meta);
    if (userMessage) {
      const signature = userMessageSignature({
        text: userMessage.text,
        webImages: userMessage.attachments?.webImages ?? 0,
        localImages: userMessage.attachments?.localImages ?? 0,
        localFiles: userMessage.attachments?.localFiles ?? 0,
      });
      if (consumePendingClientStartUser({
        counts: pendingUserSignatureCounts,
        signature,
      })) {
        state.seenUserKeys.add(buildUserMessageKey(userMessage));
        continue;
      }
      const key = buildUserMessageKey(userMessage);
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        incrementPendingSignatureCount(
          pendingUserSignatureCounts.provider,
          signature,
        );
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(userMessage);
      }
      continue;
    }

    // Extract itemId from decoded for delta/final event grouping
    const decodedItemId = (decoded.type === "item/agentMessage/delta" ||
      decoded.type === "item/reasoning/summaryTextDelta" ||
      decoded.type === "item/reasoning/textDelta")
      ? decoded.itemId
      : (decoded.type === "item/completed" && (decoded.item.type === "agentMessage" || decoded.item.type === "reasoning"))
        ? decoded.item.id
        : undefined;

    const assistantDelta = options?.threadType === "manager"
      ? null
      : parseAssistantDeltaText(decoded);
    if (assistantDelta) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      if (
        hasFinalizedProjectionKey(
          state.finalizedAssistantTurnKeys,
          primaryTurnKey,
          fallbackTurnKey,
        )
      ) {
        continue;
      }

      const turnKey = resolveOpenProjectionKey(
        state.openAssistantByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      let existing = state.openAssistantByTurn.get(turnKey);
      if (existing?.status === "completed") {
        continue;
      }
      if (!existing) {
        existing = {
          kind: "assistant-text",
          id: messageId(decoded.threadId, "assistant", turnKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: assistantDelta,
          status: "streaming",
        };
        state.openAssistantByTurn.set(turnKey, existing);
      } else {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text += assistantDelta;
      }
      continue;
    }

    const assistantFinal = options?.threadType === "manager"
      ? null
      : parseAssistantFinalText(decoded);
    if (assistantFinal) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      if (
        hasFinalizedProjectionKey(
          state.finalizedAssistantTurnKeys,
          primaryTurnKey,
          fallbackTurnKey,
        )
      ) {
        continue;
      }
      const turnKey = resolveOpenProjectionKey(
        state.openAssistantByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      const existing = state.openAssistantByTurn.get(turnKey);

      if (existing) {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text = assistantFinal;
        existing.status = "completed";
        state.openAssistantByTurn.delete(turnKey);
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(existing);
        finalizeProjectionKeys(state.finalizedAssistantTurnKeys, [
          primaryTurnKey,
        ]);
      } else {
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push({
          kind: "assistant-text",
          id: messageId(decoded.threadId, "assistant", `${primaryTurnKey}:${meta.seq}`),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: assistantFinal,
          status: "completed",
        });
        finalizeProjectionKeys(state.finalizedAssistantTurnKeys, [
          primaryTurnKey,
        ]);
      }
      continue;
    }

    const reasoningDelta = options?.threadType === "manager"
      ? null
      : parseReasoningDeltaText(decoded);
    if (reasoningDelta) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      if (
        hasFinalizedProjectionKey(
          state.finalizedReasoningTurnKeys,
          primaryTurnKey,
          fallbackTurnKey,
        )
      ) {
        continue;
      }

      const turnKey = resolveOpenProjectionKey(
        state.openReasoningByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      let existing = state.openReasoningByTurn.get(turnKey);
      if (!existing) {
        existing = {
          kind: "assistant-reasoning",
          id: messageId(decoded.threadId, "reasoning", turnKey),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: reasoningDelta,
          status: "streaming",
        };
        state.openReasoningByTurn.set(turnKey, existing);
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(existing);
      } else {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text += reasoningDelta;
      }
      continue;
    }

    const reasoningFinal = options?.threadType === "manager"
      ? null
      : parseReasoningFinalText(decoded);
    if (reasoningFinal) {
      const turnKeyPrefix = eventParentToolCallId
        ? `parent:${eventParentToolCallId}:`
        : "";
      const primaryTurnKey = `${turnKeyPrefix}${decodedItemId ?? eventTurnId ?? `seq-${meta.seq}`}`;
      const fallbackTurnKey =
        decodedItemId && eventTurnId
          ? `${turnKeyPrefix}${eventTurnId}`
          : undefined;
      const turnKey = resolveOpenProjectionKey(
        state.openReasoningByTurn,
        primaryTurnKey,
        fallbackTurnKey,
      );
      const existing = state.openReasoningByTurn.get(turnKey);

      if (existing) {
        existing.sourceSeqEnd = meta.seq;
        existing.createdAt = meta.createdAt;
        if (!existing.parentToolCallId && eventParentToolCallId) {
          existing.parentToolCallId = eventParentToolCallId;
        }
        existing.text = reasoningFinal;
        existing.status = "completed";
        state.openReasoningByTurn.delete(turnKey);
        finalizeProjectionKeys(state.finalizedReasoningTurnKeys, [
          primaryTurnKey,
        ]);
      } else {
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push({
          kind: "assistant-reasoning",
          id: messageId(decoded.threadId, "reasoning", `${primaryTurnKey}:${meta.seq}`),
          threadId: decoded.threadId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          createdAt: meta.createdAt,
          startedAt: meta.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          ...(eventParentToolCallId
            ? { parentToolCallId: eventParentToolCallId }
            : {}),
          text: reasoningFinal,
          status: "completed",
        });
        finalizeProjectionKeys(state.finalizedReasoningTurnKeys, [
          primaryTurnKey,
        ]);
      }
      continue;
    }

    const execEvent = parseExecLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
      execLifecycleContext,
    );
    if (execEvent) {
      if (execEvent.kind === "begin") {
        onExecBegin(state, meta, decoded.threadId, eventTurnId, execEvent.call);
      } else if (execEvent.kind === "output") {
        onExecOutput(state, meta, execEvent.call, execEvent.appendOutput);
      } else {
        onExecEnd(state, meta, decoded.threadId, eventTurnId, execEvent.call);
      }
      continue;
    }

    const taskMessage = parseTaskMessage(decoded, meta, eventParentToolCallId);
    if (taskMessage) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(taskMessage);
      continue;
    }

    if (shouldSuppressLowValueToolCall(decoded)) {
      continue;
    }

    const toolCallEvent = parseToolCallLifecycleEvent(
      decoded,
      meta,
      eventParentToolCallId,
      execLifecycleContext,
    );
    if (toolCallEvent) {
      const toolCallName = getToolCallName(decoded);
      const toolCallReceiverThreadIds = getToolCallReceiverThreadIds(decoded);
      if (
        !toolCallEvent.call.parentToolCallId &&
        toolCallName &&
        PROVIDER_THREAD_CHILD_INTERACTION_TOOL_NAMES.has(toolCallName)
      ) {
        const inferredParentToolCallId = toolCallReceiverThreadIds
          .map((receiverThreadId) =>
            state.delegationParentToolCallIdsByProviderThreadId.get(receiverThreadId),
          )
          .find((parentToolCallId): parentToolCallId is string =>
            typeof parentToolCallId === "string" && parentToolCallId.length > 0,
          );
        if (inferredParentToolCallId) {
          toolCallEvent.call.parentToolCallId = inferredParentToolCallId;
        }
      }
      if (
        toolCallName &&
        PROVIDER_THREAD_DELEGATION_TOOL_NAMES.has(toolCallName)
      ) {
        for (const receiverThreadId of toolCallReceiverThreadIds) {
          state.delegationParentToolCallIdsByProviderThreadId.set(
            receiverThreadId,
            toolCallEvent.call.callId,
          );
        }
      }
      if (toolCallEvent.kind === "begin") {
        onExecBegin(state, meta, decoded.threadId, eventTurnId, toolCallEvent.call);
      } else if (toolCallEvent.kind === "output") {
        onExecOutput(state, meta, toolCallEvent.call, toolCallEvent.appendOutput);
      } else {
        onExecEnd(state, meta, decoded.threadId, eventTurnId, toolCallEvent.call);
      }
      continue;
    }

    const webSearchEvent = parseWebSearchLifecycleEvent(
      decoded,
      eventParentToolCallId,
    );
    if (webSearchEvent) {
      if (webSearchEvent.kind === "begin") {
        onWebSearchBegin(state, meta, decoded.threadId, eventTurnId, webSearchEvent);
      } else {
        onWebSearchEnd(state, meta, decoded.threadId, eventTurnId, webSearchEvent);
      }
      continue;
    }

    const fileEdit = parseFileEditFromItemEvent(decoded, eventParentToolCallId);
    if (fileEdit) {
      flushToolActivityBeforeNonToolMessage(state);
      upsertFileEdit(state, meta, decoded.threadId, eventTurnId, fileEdit);
      continue;
    }

    const compactionEvent = parseCompactionLifecycleEvent(decoded, meta);
    if (compactionEvent) {
      flushToolActivityBeforeNonToolMessage(state);
      const projectedCompactionEvent = resolveProjectedCompactionEvent(
        state,
        decoded,
        compactionEvent,
      );
      if (projectedCompactionEvent.kind === "begin") {
        onCompactionBegin(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          projectedCompactionEvent,
        );
      } else {
        onCompactionEnd(
          state,
          meta,
          decoded.threadId,
          eventTurnId,
          projectedCompactionEvent,
        );
      }
      continue;
    }

    const operation = parseOperationMessage(decoded, meta, {
      includeOptionalOperations: options?.includeOptionalOperations,
    });
    if (operation) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(operation);
      continue;
    }

    const error = parseErrorMessage(decoded, meta);
    if (error) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(error);
      continue;
    }

    if (includeDebugRawEvents) {
      const debugReason = isDuplicateEventType(eventType)
        ? "duplicate-event"
        : (isIgnoredNoiseType(eventType) ||
            isIgnoredItemStartEvent(decoded) ||
            isIgnoredItemCompletedEvent(decoded))
          ? "ignored-noise"
          : "unhandled";

      if (debugReason !== "unhandled") {
        continue;
      }

      flushToolActivityBeforeNonToolMessage(state);
      appendDebugEvent(
        state.messages,
        decoded,
        meta,
        debugReason,
      );
    }
  }

  finalizePendingMessages(state, options);
  return normalizeSemanticViewMessages(state.messages);
}
