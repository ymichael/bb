import type {
  JsonObject,
  ThreadEventScope,
  ViewApprovalLifecycleStatus,
  ViewCommandMessage,
  ViewDelegationMessage,
  ViewWebFetchMessage,
  ViewMessage,
  ViewProjection,
  ViewToolCallMessage,
  ViewToolParsedIntent,
  ViewWebSearchMessage,
} from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type { ExecCallUpdate, ExecMessageKind } from "./exec-lifecycle.js";
import { messageId } from "./format-helpers.js";
import {
  areThreadEventScopesEqual,
  viewMessageThreadScopeFields,
  viewMessageTurnScopeFields,
} from "./message-scope.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  flushVisibleTextBuffer,
  getVisibleTextBufferFullLength,
  getVisibleTextBufferText,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./visible-text-buffer.js";
import type { WebActivityLifecycleEvent } from "./web-activity-lifecycle.js";

type ViewProviderExecutionMessage =
  | ViewCommandMessage
  | ViewToolCallMessage
  | ViewDelegationMessage;
type ViewWebActivityMessage = ViewWebSearchMessage | ViewWebFetchMessage;
type WebActivityKind = ViewWebActivityMessage["kind"];
type InterruptibleToolMessage =
  | ViewProviderExecutionMessage
  | ViewWebActivityMessage;
type InterruptibleToolCall = Pick<
  ViewProviderExecutionMessage,
  "output" | "status"
>;
interface ExecDelegationMetadata {
  subagentType?: string;
  description?: string;
}
interface MutableExecCallSummary extends ExecDelegationMetadata {
  callId: string;
  command: string;
  toolArgs: JsonObject | null;
  cwd: string | null;
  parsedIntents: ViewToolParsedIntent[];
  source: string | null;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  approvalStatus: ViewApprovalLifecycleStatus | null;
  status: ViewProviderExecutionMessage["status"];
}
type MutableExecSummary = MutableExecCallSummary | ViewProviderExecutionMessage;
type CommandExecutionMetadataTarget =
  | MutableExecCallSummary
  | ViewCommandMessage;
type ToolCallMetadataTarget = MutableExecCallSummary | ViewToolCallMessage;
type ParsedIntentMetadataTarget =
  | MutableExecCallSummary
  | ViewCommandMessage
  | ViewToolCallMessage;
type DelegationMetadataTarget = MutableExecCallSummary | ViewDelegationMessage;
type MaybeProviderExecutionMessage =
  | ViewMessage
  | ViewProviderExecutionMessage
  | ViewWebActivityMessage
  | null;

type ApprovalStatusDelta =
  | { kind: "keep" }
  | { kind: "set"; value: ViewApprovalLifecycleStatus | null };

export interface ToolActivityProjectionState {
  messages: ViewMessage[];
  toolActivity: ToolActivityState;
}

interface RunningExecCall extends MutableExecCallSummary {
  threadId: string;
  scope: ThreadEventScope;
  messageKind: ExecMessageKind;
  toolName?: string;
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt: number;
  outputBuffer: VisibleTextBuffer;
}

export interface ToolActivityState {
  runningCallsById: Map<string, RunningExecCall>;
  activeCell: ViewProviderExecutionMessage | ViewWebActivityMessage | null;
  historyCells: Array<ViewProviderExecutionMessage | ViewWebActivityMessage>;
  finalizedExecCallIds: Set<string>;
  finalizedWebActivityCallIds: Set<string>;
}

interface MergeCallSummaryOptions {
  appendOutput?: boolean;
  replaceOutput?: boolean;
  visibleOutput?: string;
}

export interface InterruptPendingToolActivityArgs {
  turnIds?: ReadonlySet<string>;
}

export function createToolActivityState(): ToolActivityState {
  return {
    runningCallsById: new Map(),
    activeCell: null,
    historyCells: [],
    finalizedExecCallIds: new Set(),
    finalizedWebActivityCallIds: new Set(),
  };
}

function emptyViewProjection(): ViewProjection {
  return {
    entries: [],
    state: {
      activeThinking: null,
    },
  };
}

function isProviderExecutionMessage(
  message: MaybeProviderExecutionMessage,
): message is ViewProviderExecutionMessage {
  return (
    message?.kind === "command" ||
    message?.kind === "tool-call" ||
    message?.kind === "delegation"
  );
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

export function buildApprovalStatusDelta(
  incoming: ViewApprovalLifecycleStatus | null | undefined,
  incomingStatus: ViewToolCallMessage["status"] | undefined,
): ApprovalStatusDelta {
  if (incoming !== undefined) {
    return { kind: "set", value: incoming };
  }
  if (incomingStatus !== undefined) {
    return { kind: "set", value: null };
  }
  return { kind: "keep" };
}

export function applyApprovalStatusDelta(
  current: ViewApprovalLifecycleStatus | null,
  delta: ApprovalStatusDelta,
): ViewApprovalLifecycleStatus | null {
  switch (delta.kind) {
    case "keep":
      return current;
    case "set":
      return delta.value;
  }
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

function isTerminalToolCallStatus(
  status: ViewToolCallMessage["status"] | undefined,
): boolean {
  return status !== undefined && status !== "pending";
}

function syncRunningCallVisibleOutput(call: RunningExecCall): void {
  call.output = getVisibleTextBufferText(call.outputBuffer) ?? "";
}

function setRunningCallOutput(
  call: RunningExecCall,
  text: string,
  flushTrailingPartial: boolean,
): void {
  setVisibleTextBuffer(call.outputBuffer, text, flushTrailingPartial);
  syncRunningCallVisibleOutput(call);
}

function upsertRunningExecCall(
  existing: RunningExecCall | undefined,
  incoming: ExecCallUpdate,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
): RunningExecCall {
  const scopeFields = turnId
    ? viewMessageTurnScopeFields(turnId)
    : viewMessageThreadScopeFields();
  if (!existing) {
    const outputBuffer = createVisibleTextBuffer();
    if (incoming.output && incoming.output.length > 0) {
      setVisibleTextBuffer(
        outputBuffer,
        incoming.output,
        isTerminalToolCallStatus(incoming.status),
      );
    }

    return {
      callId: incoming.callId,
      threadId,
      messageKind: incoming.messageKind ?? "tool-call",
      toolName: incoming.toolName,
      command: incoming.command ?? "",
      toolArgs: incoming.toolArgs ?? null,
      cwd: incoming.cwd ?? null,
      parsedIntents: incoming.parsedIntents,
      source: incoming.source ?? null,
      scope: scopeFields.scope,
      subagentType: incoming.subagentType,
      description: incoming.description,
      output: getVisibleTextBufferText(outputBuffer) ?? "",
      exitCode: incoming.exitCode ?? null,
      durationMs: incoming.durationMs ?? null,
      approvalStatus: incoming.approvalStatus ?? null,
      status: incoming.status ?? "pending",
      parentToolCallId: incoming.parentToolCallId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      outputBuffer,
    };
  }

  // Merge strategy per field:
  //   "keep first"  — set once from the first event that provides it
  //   "keep longest" — begin events carry partial info, end events carry full info
  //   "keep latest"  — terminal state from the last event wins

  // keep first
  if (!areThreadEventScopesEqual(existing.scope, scopeFields.scope)) {
    throw new Error(
      `Cannot merge tool-call messages with different scopes for call ${incoming.callId}`,
    );
  }
  if (incoming.messageKind && existing.messageKind !== incoming.messageKind) {
    if (existing.toolName) {
      throw new Error(
        `Cannot merge ${existing.messageKind} with ${incoming.messageKind} for call ${incoming.callId}`,
      );
    }
    existing.messageKind = incoming.messageKind;
  }
  if (incoming.toolName && !existing.toolName)
    existing.toolName = incoming.toolName;
  if (incoming.cwd && !existing.cwd) existing.cwd = incoming.cwd;
  if (incoming.source && !existing.source) existing.source = incoming.source;
  if (incoming.durationMs !== undefined && existing.durationMs === null) {
    existing.durationMs = incoming.durationMs;
  }
  if (incoming.subagentType && !existing.subagentType) {
    existing.subagentType = incoming.subagentType;
  }
  if (incoming.description && !existing.description) {
    existing.description = incoming.description;
  }
  if (!existing.parentToolCallId && incoming.parentToolCallId) {
    existing.parentToolCallId = incoming.parentToolCallId;
  }

  // keep longest (begin has partial, end has full)
  if (incoming.command && incoming.command.length > existing.command.length) {
    existing.command = incoming.command;
  }
  if (incoming.toolArgs && !existing.toolArgs) {
    existing.toolArgs = incoming.toolArgs;
  }
  if (incoming.output && incoming.output.length > 0) {
    if (
      isTerminalToolCallStatus(incoming.status) ||
      incoming.output.length >=
        getVisibleTextBufferFullLength(existing.outputBuffer)
    ) {
      setRunningCallOutput(
        existing,
        incoming.output,
        isTerminalToolCallStatus(incoming.status),
      );
    }
  }

  // keep latest
  existing.threadId = threadId;
  existing.parsedIntents = chooseParsedIntents(
    existing.parsedIntents,
    incoming.parsedIntents,
  );
  if (incoming.exitCode !== undefined) existing.exitCode = incoming.exitCode;
  existing.approvalStatus = applyApprovalStatusDelta(
    existing.approvalStatus,
    buildApprovalStatusDelta(incoming.approvalStatus, incoming.status),
  );
  existing.status =
    mergeCallStatus(existing.status, incoming.status) ?? "pending";
  existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
  existing.createdAt = Math.max(existing.createdAt, meta.createdAt);

  return existing;
}

function appendExecOutputDelta(
  call: RunningExecCall,
  delta: string | undefined,
): void {
  if (!delta || delta.length === 0) return;
  appendVisibleTextBuffer(call.outputBuffer, delta);
  syncRunningCallVisibleOutput(call);
}

function shouldInterruptToolScope(
  scope: ThreadEventScope,
  args: InterruptPendingToolActivityArgs,
): boolean {
  return (
    args.turnIds === undefined ||
    (scope.kind === "turn" && args.turnIds.has(scope.turnId))
  );
}

function interruptPendingToolCall(call: InterruptibleToolCall): void {
  if (call.status !== "pending") {
    return;
  }
  call.status = "interrupted";
  if (!call.output) {
    call.output = "Tool execution interrupted";
  }
}

function interruptPendingToolMessage(message: InterruptibleToolMessage): void {
  switch (message.kind) {
    case "command":
    case "tool-call":
    case "delegation":
      interruptPendingToolCall(message);
      return;
    case "web-search":
    case "web-fetch":
      if (message.status === "pending") {
        message.status = "interrupted";
      }
      return;
  }
}

function isInterruptibleToolMessage(
  message: ViewMessage,
): message is InterruptibleToolMessage {
  return (
    isProviderExecutionMessage(message) ||
    message.kind === "web-search" ||
    message.kind === "web-fetch"
  );
}

function findExecMessageInActiveCell(
  activeCell: ToolActivityState["activeCell"],
  callId: string,
): ViewProviderExecutionMessage | null {
  if (!activeCell) return null;
  if (isProviderExecutionMessage(activeCell) && activeCell.callId === callId) {
    return activeCell;
  }
  return null;
}

function findExecMessageInHistoryCells(
  state: ToolActivityProjectionState,
  callId: string,
): {
  cell: ViewProviderExecutionMessage;
  call: ViewProviderExecutionMessage;
} | null {
  for (
    let index = state.toolActivity.historyCells.length - 1;
    index >= 0;
    index -= 1
  ) {
    const cell = state.toolActivity.historyCells[index];
    if (!cell || cell.kind === "web-search" || cell.kind === "web-fetch") {
      continue;
    }

    const call = findExecMessageInActiveCell(cell, callId);
    if (!call) continue;

    return {
      cell,
      call,
    };
  }

  return null;
}

function isWebActivityMessage(
  cell:
    | ViewProviderExecutionMessage
    | ViewWebActivityMessage
    | null
    | undefined,
): cell is ViewWebActivityMessage {
  return cell?.kind === "web-search" || cell?.kind === "web-fetch";
}

interface FindWebActivityInHistoryCellsArgs {
  callId: string;
  itemKind?: WebActivityKind;
}

function findWebActivityInHistoryCells(
  state: ToolActivityProjectionState,
  args: FindWebActivityInHistoryCellsArgs,
): ViewWebActivityMessage | null {
  for (
    let index = state.toolActivity.historyCells.length - 1;
    index >= 0;
    index -= 1
  ) {
    const cell = state.toolActivity.historyCells[index];
    if (!isWebActivityMessage(cell)) continue;
    if (cell.callId !== args.callId) continue;
    if (args.itemKind && cell.kind !== args.itemKind) continue;
    return cell;
  }

  return null;
}

function buildWebActivityKey(kind: WebActivityKind, callId: string): string {
  return `${kind}:${callId}`;
}

function interruptWebActivityMessage(message: ViewWebActivityMessage): void {
  if (message.status === "pending") {
    message.status = "interrupted";
  }
}

function canSetDelegationMetadata(
  target: MutableExecSummary,
): target is DelegationMetadataTarget {
  return !("kind" in target) || target.kind === "delegation";
}

function canSetCommandExecutionMetadata(
  target: MutableExecSummary,
): target is CommandExecutionMetadataTarget {
  return !("kind" in target) || target.kind === "command";
}

function canSetToolCallMetadata(
  target: MutableExecSummary,
): target is ToolCallMetadataTarget {
  return !("kind" in target) || target.kind === "tool-call";
}

function canSetParsedIntentMetadata(
  target: MutableExecSummary,
): target is ParsedIntentMetadataTarget {
  return (
    !("kind" in target) ||
    target.kind === "command" ||
    target.kind === "tool-call"
  );
}

function mergeCallSummary(
  target: MutableExecSummary,
  incoming: ExecCallUpdate,
  options: MergeCallSummaryOptions = {},
): void {
  const { appendOutput, replaceOutput, visibleOutput } = options;
  if (
    canSetCommandExecutionMetadata(target) &&
    incoming.command &&
    incoming.command.length > target.command.length
  ) {
    target.command = incoming.command;
  }
  if (canSetCommandExecutionMetadata(target)) {
    if (incoming.cwd && !target.cwd) target.cwd = incoming.cwd;
    if (incoming.source && !target.source) target.source = incoming.source;
  }
  if (canSetToolCallMetadata(target) && incoming.toolArgs && !target.toolArgs) {
    target.toolArgs = incoming.toolArgs;
  }
  if (canSetParsedIntentMetadata(target)) {
    target.parsedIntents = chooseParsedIntents(
      target.parsedIntents,
      incoming.parsedIntents,
    );
  }
  if (visibleOutput !== undefined) {
    target.output = visibleOutput;
  } else if (appendOutput && incoming.output && incoming.output.length > 0) {
    target.output = `${target.output}${incoming.output}`;
  } else if (replaceOutput && incoming.output && incoming.output.length > 0) {
    target.output = incoming.output;
  } else if (
    !appendOutput &&
    incoming.output &&
    incoming.output.length > 0 &&
    incoming.output.length >= target.output.length
  ) {
    target.output = incoming.output;
  }
  if (
    canSetCommandExecutionMetadata(target) &&
    incoming.exitCode !== undefined
  ) {
    target.exitCode = incoming.exitCode;
  }
  if (incoming.durationMs !== undefined && target.durationMs === null) {
    target.durationMs = incoming.durationMs;
  }
  if (canSetDelegationMetadata(target)) {
    if (incoming.subagentType && !target.subagentType) {
      target.subagentType = incoming.subagentType;
    }
    if (incoming.description && !target.description) {
      target.description = incoming.description;
    }
  }
  if (
    canSetCommandExecutionMetadata(target) ||
    canSetToolCallMetadata(target)
  ) {
    target.approvalStatus = applyApprovalStatusDelta(
      target.approvalStatus,
      buildApprovalStatusDelta(incoming.approvalStatus, incoming.status),
    );
  }
  target.status =
    mergeCallStatus(target.status, incoming.status) ?? target.status;
}

function syncProjectedCallOutput(
  state: ToolActivityProjectionState,
  call: RunningExecCall,
): void {
  const activeCall = findExecMessageInActiveCell(
    state.toolActivity.activeCell,
    call.callId,
  );
  if (activeCall) {
    activeCall.output = call.output;
  }

  const historyMatch = findExecMessageInHistoryCells(state, call.callId);
  if (historyMatch) {
    historyMatch.call.output = call.output;
  }
}

export function flushActiveToolCell(state: ToolActivityProjectionState): void {
  const active = state.toolActivity.activeCell;
  if (!active) return;

  if (isProviderExecutionMessage(active) && active.status !== "pending") {
    state.toolActivity.finalizedExecCallIds.add(active.callId);
  }

  state.toolActivity.historyCells.push(active);
  state.messages.push(active);
  state.toolActivity.activeCell = null;
}

export function flushToolActivityBeforeNonToolMessage(
  state: ToolActivityProjectionState,
): void {
  flushActiveToolCell(state);
}

export function flushPendingToolActivityOutput(
  state: ToolActivityProjectionState,
): void {
  for (const call of state.toolActivity.runningCallsById.values()) {
    if (!flushVisibleTextBuffer(call.outputBuffer)) {
      continue;
    }
    syncRunningCallVisibleOutput(call);
    syncProjectedCallOutput(state, call);
  }
}

export function interruptPendingToolActivity(
  state: ToolActivityProjectionState,
  args: InterruptPendingToolActivityArgs = {},
): void {
  const interruptedRunningCallIds: string[] = [];
  for (const call of state.toolActivity.runningCallsById.values()) {
    if (!shouldInterruptToolScope(call.scope, args)) {
      continue;
    }

    flushVisibleTextBuffer(call.outputBuffer);
    syncRunningCallVisibleOutput(call);
    interruptPendingToolCall(call);

    const activeCall = findExecMessageInActiveCell(
      state.toolActivity.activeCell,
      call.callId,
    );
    if (activeCall) {
      mergeCallSummary(activeCall, {
        ...call,
        parsedIntents: call.parsedIntents,
      });
      interruptedRunningCallIds.push(call.callId);
      continue;
    }

    const historyMatch = findExecMessageInHistoryCells(state, call.callId);
    if (historyMatch) {
      mergeCallSummary(historyMatch.call, {
        ...call,
        parsedIntents: call.parsedIntents,
      });
      interruptedRunningCallIds.push(call.callId);
      continue;
    }

    state.messages.push(createExecMessage(call));
    interruptedRunningCallIds.push(call.callId);
  }

  for (const callId of interruptedRunningCallIds) {
    state.toolActivity.runningCallsById.delete(callId);
  }

  if (
    state.toolActivity.activeCell &&
    shouldInterruptToolScope(state.toolActivity.activeCell.scope, args)
  ) {
    interruptPendingToolMessage(state.toolActivity.activeCell);
  }

  for (const cell of state.toolActivity.historyCells) {
    if (shouldInterruptToolScope(cell.scope, args)) {
      interruptPendingToolMessage(cell);
    }
  }

  for (const message of state.messages) {
    if (
      isInterruptibleToolMessage(message) &&
      shouldInterruptToolScope(message.scope, args)
    ) {
      interruptPendingToolMessage(message);
    }
  }
}

function createExecMessage(
  call: RunningExecCall,
): ViewProviderExecutionMessage {
  const messageKindForId =
    call.messageKind === "tool-call" ? "tool" : call.messageKind;
  const base = {
    id: messageId(call.threadId, messageKindForId, call.callId),
    threadId: call.threadId,
    sourceSeqStart: call.sourceSeqStart,
    sourceSeqEnd: call.sourceSeqEnd,
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    scope: call.scope,
    ...(call.parentToolCallId
      ? { parentToolCallId: call.parentToolCallId }
      : {}),
    callId: call.callId,
    output: call.output,
    durationMs: call.durationMs,
    status: call.status,
  };

  if (call.messageKind === "command") {
    return {
      ...base,
      kind: "command",
      command: call.command,
      cwd: call.cwd,
      parsedIntents: call.parsedIntents,
      source: call.source,
      exitCode: call.exitCode,
      approvalStatus: call.approvalStatus,
    };
  }

  if (call.messageKind === "delegation") {
    return {
      ...base,
      kind: "delegation",
      toolName: call.toolName ?? "Agent",
      subagentType: call.subagentType,
      description: call.description,
      childProjection: emptyViewProjection(),
    };
  }

  return {
    ...base,
    kind: "tool-call",
    toolName: call.toolName ?? "tool",
    toolArgs: call.toolArgs,
    parsedIntents: call.parsedIntents,
    approvalStatus: call.approvalStatus,
  };
}

export function onExecBegin(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ExecCallUpdate,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(
    incoming.callId,
  );
  const call = upsertRunningExecCall(
    existingRunning,
    incoming,
    meta,
    threadId,
    turnId,
  );
  state.toolActivity.runningCallsById.set(call.callId, call);

  const existingInActive = findExecMessageInActiveCell(
    state.toolActivity.activeCell,
    call.callId,
  );
  if (existingInActive) {
    mergeCallSummary(existingInActive, call);
    if (isProviderExecutionMessage(state.toolActivity.activeCell)) {
      state.toolActivity.activeCell.sourceSeqEnd = Math.max(
        state.toolActivity.activeCell.sourceSeqEnd,
        call.sourceSeqEnd,
      );
      state.toolActivity.activeCell.createdAt = Math.max(
        state.toolActivity.activeCell.createdAt,
        call.createdAt,
      );
    }
    return;
  }

  flushActiveToolCell(state);
  state.toolActivity.activeCell = createExecMessage(call);
}

export function onExecOutput(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  incoming: ExecCallUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(
    incoming.callId,
  );
  if (existingRunning) {
    if (appendOutput) {
      appendExecOutputDelta(existingRunning, incoming.output);
      mergeCallSummary(existingRunning, incoming, {
        appendOutput,
        replaceOutput,
        visibleOutput: existingRunning.output,
      });
    } else if (replaceOutput && incoming.output !== undefined) {
      setRunningCallOutput(
        existingRunning,
        incoming.output,
        isTerminalToolCallStatus(incoming.status),
      );
      mergeCallSummary(existingRunning, incoming, {
        appendOutput,
        replaceOutput,
        visibleOutput: existingRunning.output,
      });
    } else {
      mergeCallSummary(existingRunning, incoming, {
        appendOutput,
        replaceOutput,
      });
    }
    existingRunning.sourceSeqEnd = Math.max(
      existingRunning.sourceSeqEnd,
      meta.seq,
    );
    existingRunning.createdAt = Math.max(
      existingRunning.createdAt,
      meta.createdAt,
    );
  }

  const activeCall = findExecMessageInActiveCell(
    state.toolActivity.activeCell,
    incoming.callId,
  );
  if (activeCall) {
    mergeCallSummary(activeCall, incoming, {
      appendOutput,
      replaceOutput,
      visibleOutput: existingRunning?.output,
    });
    if (isProviderExecutionMessage(state.toolActivity.activeCell)) {
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

  const historyMatch = findExecMessageInHistoryCells(state, incoming.callId);
  if (!historyMatch) return;

  mergeCallSummary(historyMatch.call, incoming, {
    appendOutput,
    replaceOutput,
    visibleOutput: existingRunning?.output,
  });
  historyMatch.cell.sourceSeqEnd = Math.max(
    historyMatch.cell.sourceSeqEnd,
    meta.seq,
  );
  historyMatch.cell.createdAt = Math.max(
    historyMatch.cell.createdAt,
    meta.createdAt,
  );

  historyMatch.cell.status =
    mergeCallStatus(historyMatch.cell.status, incoming.status) ??
    historyMatch.cell.status;
}

export function onExecEnd(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ExecCallUpdate,
): void {
  const running = state.toolActivity.runningCallsById.get(incoming.callId);
  const merged = upsertRunningExecCall(
    running,
    incoming,
    meta,
    threadId,
    turnId,
  );
  if (isTerminalToolCallStatus(merged.status)) {
    flushVisibleTextBuffer(merged.outputBuffer);
    syncRunningCallVisibleOutput(merged);
  }
  state.toolActivity.runningCallsById.delete(incoming.callId);

  const active = state.toolActivity.activeCell;
  const existingInActive = findExecMessageInActiveCell(active, incoming.callId);
  if (existingInActive) {
    mergeCallSummary(existingInActive, merged, {
      visibleOutput: merged.output,
    });
    if (isProviderExecutionMessage(active)) {
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, merged.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, merged.createdAt);
      active.status =
        mergeCallStatus(active.status, merged.status) ?? active.status;
      active.output = merged.output || active.output;
      if (canSetCommandExecutionMetadata(active)) {
        active.exitCode = merged.exitCode ?? active.exitCode;
      }
      active.durationMs = merged.durationMs ?? active.durationMs;
      state.toolActivity.finalizedExecCallIds.add(incoming.callId);
      flushActiveToolCell(state);
      return;
    }
  }

  if (state.toolActivity.finalizedExecCallIds.has(incoming.callId)) {
    return;
  }

  const historyMatch = findExecMessageInHistoryCells(state, incoming.callId);
  if (historyMatch) {
    mergeCallSummary(historyMatch.call, merged, {
      visibleOutput: merged.output,
    });
    historyMatch.cell.sourceSeqEnd = Math.max(
      historyMatch.cell.sourceSeqEnd,
      merged.sourceSeqEnd,
    );
    historyMatch.cell.createdAt = Math.max(
      historyMatch.cell.createdAt,
      merged.createdAt,
    );

    historyMatch.cell.status =
      mergeCallStatus(historyMatch.cell.status, merged.status) ??
      historyMatch.cell.status;
    historyMatch.cell.output = merged.output || historyMatch.cell.output;
    if (canSetCommandExecutionMetadata(historyMatch.cell)) {
      historyMatch.cell.exitCode =
        merged.exitCode ?? historyMatch.cell.exitCode;
    }
    historyMatch.cell.durationMs =
      merged.durationMs ?? historyMatch.cell.durationMs;

    state.toolActivity.finalizedExecCallIds.add(incoming.callId);
    return;
  }

  flushActiveToolCell(state);

  const execMessage = createExecMessage(merged);
  execMessage.status =
    mergeCallStatus(execMessage.status, incoming.status) ?? execMessage.status;
  state.toolActivity.activeCell = execMessage;
  flushActiveToolCell(state);
}

function createWebActivityMessage(
  threadId: string,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
  status: ViewWebActivityMessage["status"],
): ViewWebActivityMessage {
  if (payload.itemKind === "web-search") {
    return {
      kind: "web-search",
      id: messageId(threadId, "web-search", payload.callId),
      threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      ...(turnId
        ? viewMessageTurnScopeFields(turnId)
        : viewMessageThreadScopeFields()),
      ...(payload.parentToolCallId
        ? { parentToolCallId: payload.parentToolCallId }
        : {}),
      callId: payload.callId,
      queries: payload.queries,
      resultText: payload.resultText,
      status,
    };
  }

  return {
    kind: "web-fetch",
    id: messageId(threadId, "web-fetch", payload.callId),
    threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    ...(turnId
      ? viewMessageTurnScopeFields(turnId)
      : viewMessageThreadScopeFields()),
    ...(payload.parentToolCallId
      ? { parentToolCallId: payload.parentToolCallId }
      : {}),
    callId: payload.callId,
    url: payload.url,
    prompt: payload.prompt,
    pattern: payload.pattern,
    resultText: payload.resultText,
    status,
  };
}

function mergeWebActivityMessage(
  target: ViewWebActivityMessage,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const scopeFields = turnId
    ? viewMessageTurnScopeFields(turnId)
    : viewMessageThreadScopeFields();
  if (!areThreadEventScopesEqual(target.scope, scopeFields.scope)) {
    throw new Error(
      `Cannot merge ${target.kind} messages with different scopes for call ${payload.callId}`,
    );
  }
  target.sourceSeqEnd = Math.max(target.sourceSeqEnd, meta.seq);
  target.createdAt = Math.max(target.createdAt, meta.createdAt);
  if (!target.parentToolCallId && payload.parentToolCallId) {
    target.parentToolCallId = payload.parentToolCallId;
  }

  if (target.kind === "web-search" && payload.itemKind === "web-search") {
    target.queries = payload.queries;
    target.resultText = payload.resultText;
    return;
  }

  if (target.kind === "web-fetch" && payload.itemKind === "web-fetch") {
    target.url = payload.url;
    target.prompt = payload.prompt;
    target.pattern = payload.pattern;
    target.resultText = payload.resultText;
  }
}

export function onWebActivityBegin(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const activityKey = buildWebActivityKey(payload.itemKind, payload.callId);
  if (state.toolActivity.finalizedWebActivityCallIds.has(activityKey)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (
    isWebActivityMessage(active) &&
    active.callId === payload.callId &&
    active.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(active);
    flushActiveToolCell(state);
  }

  if (
    active &&
    active.kind === payload.itemKind &&
    active.callId === payload.callId
  ) {
    mergeWebActivityMessage(active, meta, turnId, payload);
    return;
  }

  flushActiveToolCell(state);
  state.toolActivity.activeCell = createWebActivityMessage(
    threadId,
    meta,
    turnId,
    payload,
    "pending",
  );
}

export function onWebActivityEnd(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  payload: WebActivityLifecycleEvent,
): void {
  const activityKey = buildWebActivityKey(payload.itemKind, payload.callId);
  if (state.toolActivity.finalizedWebActivityCallIds.has(activityKey)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (
    isWebActivityMessage(active) &&
    active.callId === payload.callId &&
    active.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(active);
    flushActiveToolCell(state);
  }

  if (
    active &&
    active.kind === payload.itemKind &&
    active.callId === payload.callId
  ) {
    mergeWebActivityMessage(active, meta, turnId, payload);
    active.status = "completed";
    flushActiveToolCell(state);
    state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
    return;
  }

  flushActiveToolCell(state);

  const conflictingHistoryMatch = findWebActivityInHistoryCells(state, {
    callId: payload.callId,
  });
  if (
    conflictingHistoryMatch &&
    conflictingHistoryMatch.kind !== payload.itemKind
  ) {
    interruptWebActivityMessage(conflictingHistoryMatch);
  }

  const historyMatch = findWebActivityInHistoryCells(state, {
    callId: payload.callId,
    itemKind: payload.itemKind,
  });
  if (historyMatch) {
    mergeWebActivityMessage(historyMatch, meta, turnId, payload);
    historyMatch.status = "completed";
    state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
    return;
  }

  const completedMessage = createWebActivityMessage(
    threadId,
    meta,
    turnId,
    payload,
    "completed",
  );
  completedMessage.id = messageId(
    threadId,
    completedMessage.kind,
    `${payload.callId}:${meta.seq}`,
  );
  state.messages.push(completedMessage);
  state.toolActivity.finalizedWebActivityCallIds.add(activityKey);
}
