import type {
  ViewApprovalLifecycleStatus,
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
import { isExploringCall } from "./tool-call-parsing.js";
import type { WebSearchLifecycleEvent } from "./web-search-lifecycle.js";

interface ExploringCompatibilityContext {
  turnId?: string;
  source?: string;
  parentToolCallId?: string;
}

type ApprovalStatusDelta =
  | { kind: "keep" }
  | { kind: "set"; value: ViewApprovalLifecycleStatus | null };

export interface ToolActivityProjectionState {
  messages: ViewMessage[];
  toolActivity: ToolActivityState;
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

export interface ToolActivityState {
  runningCallsById: Map<string, RunningExecCall>;
  activeCell: ViewToolExploringMessage | ViewToolCallMessage | ViewWebSearchMessage | null;
  historyCells: Array<ViewToolExploringMessage | ViewToolCallMessage | ViewWebSearchMessage>;
  finalizedExecCallIds: Set<string>;
  finalizedWebSearchCallIds: Set<string>;
}

interface MergeCallSummaryOptions {
  appendOutput?: boolean;
}

export function createToolActivityState(): ToolActivityState {
  return {
    runningCallsById: new Map(),
    activeCell: null,
    historyCells: [],
    finalizedExecCallIds: new Set(),
    finalizedWebSearchCallIds: new Set(),
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
      approvalStatus: incoming.approvalStatus ?? null,
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
  existing.approvalStatus = applyApprovalStatusDelta(
    existing.approvalStatus,
    buildApprovalStatusDelta(incoming.approvalStatus, incoming.status),
  );
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
  state: ToolActivityProjectionState,
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

function findWebSearchInHistoryCells(
  state: ToolActivityProjectionState,
  callId: string,
): ViewWebSearchMessage | null {
  for (let index = state.toolActivity.historyCells.length - 1; index >= 0; index -= 1) {
    const cell = state.toolActivity.historyCells[index];
    if (cell?.kind !== "web-search" || cell.callId !== callId) continue;
    return cell;
  }

  return null;
}

function mergeCallSummary(
  target: ViewToolCallSummary | ViewToolCallMessage,
  incoming: ExecCallPartial,
  options: MergeCallSummaryOptions = {},
): void {
  const { appendOutput } = options;
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
  target.approvalStatus = applyApprovalStatusDelta(
    target.approvalStatus,
    buildApprovalStatusDelta(incoming.approvalStatus, incoming.status),
  );
  target.status = mergeCallStatus(target.status, incoming.status) ?? target.status;
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

export function flushToolActivityBeforeNonToolMessage(state: ToolActivityProjectionState): void {
  flushActiveToolCell(state);
}

export function interruptPendingToolActivity(
  state: ToolActivityProjectionState,
): void {
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
    ...(call.turnId ? { turnId: call.turnId } : {}),
    ...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}),
    status: call.status === "pending" ? "pending" : "completed",
    calls: [call],
  };
}

export function onExecBegin(
  state: ToolActivityProjectionState,
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

export function onExecOutput(
  state: ToolActivityProjectionState,
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

export function onExecEnd(
  state: ToolActivityProjectionState,
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

export function onWebSearchBegin(
  state: ToolActivityProjectionState,
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

function mergeWebSearchMessage(
  target: ViewWebSearchMessage,
  meta: EventMeta,
  turnId: string | undefined,
  payload: WebSearchLifecycleEvent,
): void {
  target.sourceSeqEnd = Math.max(target.sourceSeqEnd, meta.seq);
  target.createdAt = Math.max(target.createdAt, meta.createdAt);
  if (!target.turnId && turnId) target.turnId = turnId;
  if (!target.parentToolCallId && payload.parentToolCallId) {
    target.parentToolCallId = payload.parentToolCallId;
  }
  if (payload.query) target.query = payload.query;
  if (payload.action) target.action = payload.action;
  if (payload.output) target.output = payload.output;
}

export function onWebSearchEnd(
  state: ToolActivityProjectionState,
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
    mergeWebSearchMessage(active, meta, turnId, payload);
    active.status = "completed";
    flushActiveToolCell(state);
    state.toolActivity.finalizedWebSearchCallIds.add(payload.callId);
    return;
  }

  flushActiveToolCell(state);

  const historyMatch = findWebSearchInHistoryCells(state, payload.callId);
  if (historyMatch) {
    mergeWebSearchMessage(historyMatch, meta, turnId, payload);
    historyMatch.status = "completed";
    state.toolActivity.finalizedWebSearchCallIds.add(payload.callId);
    return;
  }

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
