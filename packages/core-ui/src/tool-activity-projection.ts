import type {
  ThreadEventScope,
  ViewApprovalLifecycleStatus,
  ViewWebFetchMessage,
  ViewMessage,
  ViewToolCallMessage,
  ViewToolCallSummary,
  ViewToolExploringMessage,
  ViewToolParsedIntent,
  ViewWebSearchMessage,
} from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type { ExecCallPartial } from "./exec-lifecycle.js";
import { messageId } from "./format-helpers.js";
import {
  areThreadEventScopesEqual,
  viewMessageThreadScopeFields,
  viewMessageTurnScopeFields,
} from "./message-scope.js";
import { isExploringCall } from "./tool-call-parsing.js";
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

interface ExploringCompatibilityContext {
  scope: ThreadEventScope;
  source?: string;
  parentToolCallId?: string;
}

type ViewWebActivityMessage = ViewWebSearchMessage | ViewWebFetchMessage;
type WebActivityKind = ViewWebActivityMessage["kind"];

type ApprovalStatusDelta =
  | { kind: "keep" }
  | { kind: "set"; value: ViewApprovalLifecycleStatus | null };

export interface ToolActivityProjectionState {
  messages: ViewMessage[];
  toolActivity: ToolActivityState;
}

interface RunningExecCall extends ViewToolCallSummary {
  threadId: string;
  scope: ThreadEventScope;
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
  activeCell:
    | ViewToolExploringMessage
    | ViewToolCallMessage
    | ViewWebActivityMessage
    | null;
  historyCells: Array<
    ViewToolExploringMessage | ViewToolCallMessage | ViewWebActivityMessage
  >;
  finalizedExecCallIds: Set<string>;
  finalizedWebActivityCallIds: Set<string>;
}

interface MergeCallSummaryOptions {
  appendOutput?: boolean;
  replaceOutput?: boolean;
  visibleOutput?: string;
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
  status: ViewToolCallSummary["status"] | undefined,
): boolean {
  return status !== undefined && status !== "pending";
}

function syncRunningCallVisibleOutput(call: RunningExecCall): void {
  call.output = getVisibleTextBufferText(call.outputBuffer);
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
  incoming: ExecCallPartial,
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
      toolName: incoming.toolName,
      command: incoming.command,
      cwd: incoming.cwd,
      parsedCmd: incoming.parsedCmd,
      source: incoming.source,
      scope: scopeFields.scope,
      subagentType: incoming.subagentType,
      description: incoming.description,
      output: getVisibleTextBufferText(outputBuffer),
      exitCode: incoming.exitCode,
      duration: incoming.duration,
      durationMs: incoming.durationMs,
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
  if (incoming.toolName && !existing.toolName)
    existing.toolName = incoming.toolName;
  if (incoming.cwd && !existing.cwd) existing.cwd = incoming.cwd;
  if (incoming.source && !existing.source) existing.source = incoming.source;
  if (incoming.duration && !existing.duration)
    existing.duration = incoming.duration;
  if (incoming.durationMs !== undefined && existing.durationMs === undefined) {
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
  if (
    incoming.command &&
    (!existing.command || incoming.command.length > existing.command.length)
  ) {
    existing.command = incoming.command;
  }
  if (incoming.output && incoming.output.length > 0) {
    if (
      isTerminalToolCallStatus(incoming.status) ||
      incoming.output.length >= getVisibleTextBufferFullLength(existing.outputBuffer)
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
  existing.parsedCmd = chooseParsedIntents(
    existing.parsedCmd,
    incoming.parsedCmd,
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

function areExploringCallsCompatible(
  a: ExploringCompatibilityContext,
  b: ExploringCompatibilityContext,
): boolean {
  const sameScope = areThreadEventScopesEqual(a.scope, b.scope);
  const sameSource = (a.source ?? "agent") === (b.source ?? "agent");
  const sameParent =
    (a.parentToolCallId ?? null) === (b.parentToolCallId ?? null);
  return sameScope && sameSource && sameParent;
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
  state: ToolActivityProjectionState,
  callId: string,
): {
  cell: ViewToolExploringMessage | ViewToolCallMessage;
  call: ViewToolCallSummary | ViewToolCallMessage;
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

    const call = findCallInActiveCell(cell, callId);
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
    | ViewToolExploringMessage
    | ViewToolCallMessage
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

function mergeCallSummary(
  target: ViewToolCallSummary | ViewToolCallMessage,
  incoming: ExecCallPartial,
  options: MergeCallSummaryOptions = {},
): void {
  const { appendOutput, replaceOutput, visibleOutput } = options;
  if (
    incoming.command &&
    (!target.command || incoming.command.length > target.command.length)
  ) {
    target.command = incoming.command;
  }
  if (incoming.cwd && !target.cwd) target.cwd = incoming.cwd;
  target.parsedCmd = chooseParsedIntents(
    target.parsedCmd ?? [],
    incoming.parsedCmd,
  );
  if (incoming.source && !target.source) target.source = incoming.source;
  if (visibleOutput !== undefined) {
    target.output = visibleOutput;
  } else if (appendOutput && incoming.output && incoming.output.length > 0) {
    target.output = `${target.output ?? ""}${incoming.output}`;
  } else if (
    replaceOutput &&
    incoming.output &&
    incoming.output.length > 0
  ) {
    target.output = incoming.output;
  } else if (appendOutput && incoming.output && incoming.output.length > 0) {
    target.output = `${target.output ?? ""}${incoming.output}`;
  } else if (
    !appendOutput &&
    incoming.output &&
    incoming.output.length > 0 &&
    (!target.output || incoming.output.length >= target.output.length)
  ) {
    target.output = incoming.output;
  }
  if (incoming.exitCode !== undefined) target.exitCode = incoming.exitCode;
  if (incoming.duration && !target.duration)
    target.duration = incoming.duration;
  if (incoming.durationMs !== undefined && target.durationMs === undefined) {
    target.durationMs = incoming.durationMs;
  }
  if (incoming.subagentType && !target.subagentType) {
    target.subagentType = incoming.subagentType;
  }
  if (incoming.description && !target.description) {
    target.description = incoming.description;
  }
  target.approvalStatus = applyApprovalStatusDelta(
    target.approvalStatus,
    buildApprovalStatusDelta(incoming.approvalStatus, incoming.status),
  );
  target.status =
    mergeCallStatus(target.status, incoming.status) ?? target.status;
}

function syncProjectedCallOutput(
  state: ToolActivityProjectionState,
  call: RunningExecCall,
): void {
  const activeCall = findCallInActiveCell(state.toolActivity.activeCell, call.callId);
  if (activeCall) {
    activeCall.output = call.output;
  }

  const historyMatch = findCallInHistoryCells(state, call.callId);
  if (historyMatch) {
    historyMatch.call.output = call.output;
  }
}

export function flushActiveToolCell(state: ToolActivityProjectionState): void {
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
): void {
  for (const call of state.toolActivity.runningCallsById.values()) {
    flushVisibleTextBuffer(call.outputBuffer);
    syncRunningCallVisibleOutput(call);
    call.status = mergeCallStatus(call.status, "interrupted") ?? "interrupted";
    if (!call.output) {
      call.output = "Tool execution interrupted";
    }

    const activeCall = findCallInActiveCell(
      state.toolActivity.activeCell,
      call.callId,
    );
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
  } else if (
    state.toolActivity.activeCell?.kind === "web-search" ||
    state.toolActivity.activeCell?.kind === "web-fetch"
  ) {
    state.toolActivity.activeCell.status = "interrupted";
  }
}

function createToolCallMessage(call: RunningExecCall): ViewToolCallMessage {
  return {
    kind: "tool-call",
    id: messageId(call.threadId, "tool", call.callId),
    threadId: call.threadId,
    sourceSeqStart: call.sourceSeqStart,
    sourceSeqEnd: call.sourceSeqEnd,
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    scope: call.scope,
    ...(call.parentToolCallId
      ? { parentToolCallId: call.parentToolCallId }
      : {}),
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
    approvalStatus: call.approvalStatus,
    status: call.status,
  };
}

function createToolCallSummary(call: RunningExecCall): ViewToolCallSummary {
  return {
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
    approvalStatus: call.approvalStatus,
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
    scope: call.scope,
    ...(call.parentToolCallId
      ? { parentToolCallId: call.parentToolCallId }
      : {}),
    status: call.status === "pending" ? "pending" : "completed",
    calls: [createToolCallSummary(call)],
  };
}

export function onExecBegin(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ExecCallPartial,
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

  const existingInActive = findCallInActiveCell(
    state.toolActivity.activeCell,
    call.callId,
  );
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
    if (
      lastCall &&
      areExploringCallsCompatible(
        {
          scope: active.scope,
          source: lastCall.source,
          parentToolCallId: active.parentToolCallId,
        },
        call,
      )
    ) {
      active.calls.push(createToolCallSummary(call));
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

export function onExecOutput(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  incoming: ExecCallPartial,
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

  const activeCall = findCallInActiveCell(
    state.toolActivity.activeCell,
    incoming.callId,
  );
  if (activeCall) {
    mergeCallSummary(activeCall, incoming, {
      appendOutput,
      replaceOutput,
      visibleOutput: existingRunning?.output,
    });
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

  if (historyMatch.cell.kind === "tool-exploring") {
    syncExploringStatus(historyMatch.cell);
  } else if (historyMatch.cell.kind === "tool-call") {
    historyMatch.cell.status =
      mergeCallStatus(historyMatch.cell.status, incoming.status) ??
      historyMatch.cell.status;
  }
}

export function onExecEnd(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
  incoming: ExecCallPartial,
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
  const existingInActive = findCallInActiveCell(active, incoming.callId);
  if (existingInActive) {
    mergeCallSummary(existingInActive, merged, {
      visibleOutput: merged.output,
    });
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
      active.status =
        mergeCallStatus(active.status, merged.status) ?? active.status;
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

    if (historyMatch.cell.kind === "tool-exploring") {
      syncExploringStatus(historyMatch.cell);
    } else {
      historyMatch.cell.status =
        mergeCallStatus(historyMatch.cell.status, merged.status) ??
        historyMatch.cell.status;
      historyMatch.cell.output = merged.output ?? historyMatch.cell.output;
      historyMatch.cell.exitCode =
        merged.exitCode ?? historyMatch.cell.exitCode;
      historyMatch.cell.duration =
        merged.duration ?? historyMatch.cell.duration;
      historyMatch.cell.durationMs =
        merged.durationMs ?? historyMatch.cell.durationMs;
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
  toolCall.status =
    mergeCallStatus(toolCall.status, incoming.status) ?? toolCall.status;
  state.toolActivity.activeCell = toolCall;
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
