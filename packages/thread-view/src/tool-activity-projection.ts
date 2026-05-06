import type { JsonObject, ThreadEventScope } from "@bb/domain";
import type {
  EventProjectionApprovalLifecycleStatus,
  EventProjectionMessage,
  EventProjection,
  EventProjectionToolCallMessage,
  EventProjectionToolParsedIntent,
} from "./event-projection-types.js";
import type { EventMeta } from "./event-decode.js";
import type {
  ExecutionOutputUpdate,
  ProviderExecutionUpdate,
} from "./exec-lifecycle.js";
import { messageId } from "./format-helpers.js";
import {
  areThreadEventScopesEqual,
  eventProjectionMessageThreadScopeFields,
  eventProjectionMessageTurnScopeFields,
} from "./message-scope.js";
import {
  appendVisibleTextBuffer,
  createVisibleTextBuffer,
  flushVisibleTextBuffer,
  getVisibleTextBufferFullLength,
  getVisibleTextBufferFullText,
  getVisibleTextBufferText,
  setVisibleTextBuffer,
  type VisibleTextBuffer,
} from "./visible-text-buffer.js";
import {
  findExecMessageInActiveCell,
  findExecMessageInHistoryCells,
  flushActiveToolCell,
  isProviderExecutionMessage,
  type ToolActivityCell,
  type ViewProviderExecutionMessage,
  type ViewWebActivityMessage,
} from "./tool-activity-cells.js";
export { flushActiveToolCell } from "./tool-activity-cells.js";
export {
  onWebActivityBegin,
  onWebActivityEnd,
} from "./tool-activity-web-projection.js";

type InterruptibleToolMessage =
  | ViewProviderExecutionMessage
  | ViewWebActivityMessage;
type InterruptibleToolCall = Pick<
  ViewProviderExecutionMessage,
  "completedAt" | "output" | "status"
>;
interface ExecutionCompletionTarget {
  completedAt: number | null;
  status: ViewProviderExecutionMessage["status"];
}

interface ExecutionCompletionSource {
  completedAt?: number | null;
  status?: ViewProviderExecutionMessage["status"];
}

interface RunningExecutionBase {
  callId: string;
  threadId: string;
  scope: ThreadEventScope;
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt: number;
  output: string;
  completedAt: number | null;
  status: ViewProviderExecutionMessage["status"];
  outputBuffer: VisibleTextBuffer;
}

interface PendingExecutionOutput {
  callId: string;
  parentToolCallId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
  startedAt: number;
  output: string;
  status?: ViewProviderExecutionMessage["status"];
  outputBuffer: VisibleTextBuffer;
}

type BufferedExecutionOutput = RunningExecCall | PendingExecutionOutput;

interface RunningCommandExecution extends RunningExecutionBase {
  kind: "command";
  command: string;
  cwd: string | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  source: string | null;
  exitCode: number | null;
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
}

interface RunningToolCallExecution extends RunningExecutionBase {
  kind: "tool-call";
  toolName: string | null;
  toolArgs: JsonObject | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
}

interface RunningDelegationExecution extends RunningExecutionBase {
  kind: "delegation";
  toolName: string | null;
  subagentType?: string;
  description?: string;
}

type RunningExecCall =
  | RunningCommandExecution
  | RunningToolCallExecution
  | RunningDelegationExecution;

type ApprovalStatusDelta =
  | { kind: "keep" }
  | { kind: "set"; value: EventProjectionApprovalLifecycleStatus | null };

export interface ToolActivityProjectionState {
  messages: EventProjectionMessage[];
  toolActivity: ToolActivityState;
}

export interface ToolActivityState {
  runningCallsById: Map<string, RunningExecCall>;
  pendingOutputsByCallId: Map<string, PendingExecutionOutput>;
  activeCell: ToolActivityCell | null;
  historyCells: ToolActivityCell[];
  execHistoryCellIndexByCallId: Map<string, number>;
  finalizedExecCallIds: Set<string>;
  finalizedWebActivityCallIds: Set<string>;
}

interface MergeCallSummaryOptions {
  appendOutput?: boolean;
  replaceOutput?: boolean;
  visibleOutput?: string;
}

export interface InterruptPendingToolActivityArgs {
  completedAt: number | null;
  turnIds?: ReadonlySet<string>;
}

const DEFAULT_INTERRUPT_PENDING_TOOL_ACTIVITY_ARGS: InterruptPendingToolActivityArgs =
  {
    completedAt: null,
  };

export function createToolActivityState(): ToolActivityState {
  return {
    runningCallsById: new Map(),
    pendingOutputsByCallId: new Map(),
    activeCell: null,
    historyCells: [],
    execHistoryCellIndexByCallId: new Map(),
    finalizedExecCallIds: new Set(),
    finalizedWebActivityCallIds: new Set(),
  };
}

function emptyEventProjection(): EventProjection {
  return {
    entries: [],
    state: {
      activeThinking: null,
    },
  };
}

function mergeCallStatus(
  current: EventProjectionToolCallMessage["status"] | undefined,
  incoming: EventProjectionToolCallMessage["status"] | undefined,
): EventProjectionToolCallMessage["status"] | undefined {
  // Lifecycle merge is monotonic: terminal call state sticks unless a later
  // error wins.
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming === "error") return "error";
  if (isTerminalToolCallStatus(current)) return current;
  return incoming;
}

export function buildApprovalStatusDelta(
  incoming: EventProjectionApprovalLifecycleStatus | null | undefined,
  incomingStatus: EventProjectionToolCallMessage["status"] | undefined,
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
  current: EventProjectionApprovalLifecycleStatus | null,
  delta: ApprovalStatusDelta,
): EventProjectionApprovalLifecycleStatus | null {
  switch (delta.kind) {
    case "keep":
      return current;
    case "set":
      return delta.value;
  }
}

function hasSemanticIntent(
  intents: EventProjectionToolParsedIntent[],
): boolean {
  return intents.some((intent) => intent.type !== "unknown");
}

function chooseParsedIntents(
  existing: EventProjectionToolParsedIntent[],
  incoming: EventProjectionToolParsedIntent[],
): EventProjectionToolParsedIntent[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  if (!hasSemanticIntent(existing) && hasSemanticIntent(incoming)) {
    return incoming;
  }
  if (incoming.length > existing.length) return incoming;
  return existing;
}

function isTerminalToolCallStatus(
  status: EventProjectionToolCallMessage["status"] | undefined,
): boolean {
  return status !== undefined && status !== "pending";
}

function syncBufferedExecutionOutput(target: BufferedExecutionOutput): void {
  target.output = getVisibleTextBufferText(target.outputBuffer) ?? "";
}

function syncRunningCallVisibleOutput(call: RunningExecCall): void {
  call.output = getVisibleTextBufferText(call.outputBuffer) ?? "";
}

function setBufferedExecutionOutput(
  target: BufferedExecutionOutput,
  text: string,
  flushTrailingPartial: boolean,
): void {
  setVisibleTextBuffer(target.outputBuffer, text, flushTrailingPartial);
  syncBufferedExecutionOutput(target);
}

function setRunningCallOutput(
  call: RunningExecCall,
  text: string,
  flushTrailingPartial: boolean,
): void {
  setBufferedExecutionOutput(call, text, flushTrailingPartial);
}

interface CreateRunningExecutionBaseArgs {
  incoming: ProviderExecutionUpdate;
  meta: EventMeta;
  scope: ThreadEventScope;
  threadId: string;
}

function createRunningExecutionBase({
  incoming,
  meta,
  scope,
  threadId,
}: CreateRunningExecutionBaseArgs): RunningExecutionBase {
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
    scope,
    ...(incoming.parentToolCallId
      ? { parentToolCallId: incoming.parentToolCallId }
      : {}),
    output: getVisibleTextBufferText(outputBuffer) ?? "",
    completedAt: incoming.completedAt ?? null,
    status: incoming.status ?? "pending",
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    outputBuffer,
  };
}

function createRunningExecCall(
  incoming: ProviderExecutionUpdate,
  meta: EventMeta,
  threadId: string,
  scope: ThreadEventScope,
): RunningExecCall {
  const base = createRunningExecutionBase({
    incoming,
    meta,
    scope,
    threadId,
  });

  switch (incoming.kind) {
    case "command":
      return {
        ...base,
        kind: "command",
        command: incoming.command ?? "",
        cwd: incoming.cwd ?? null,
        parsedIntents: incoming.parsedIntents ?? [],
        source: incoming.source ?? null,
        exitCode: incoming.exitCode ?? null,
        approvalStatus: incoming.approvalStatus ?? null,
      };
    case "tool-call":
      return {
        ...base,
        kind: "tool-call",
        toolName: incoming.toolName ?? null,
        toolArgs: incoming.toolArgs ?? null,
        parsedIntents: incoming.parsedIntents ?? [],
        approvalStatus: incoming.approvalStatus ?? null,
      };
    case "delegation":
      return {
        ...base,
        kind: "delegation",
        toolName: incoming.toolName ?? null,
        subagentType: incoming.subagentType,
        description: incoming.description,
      };
  }
}

function assertMatchingExecutionKind(
  existing: RunningExecCall,
  incoming: ProviderExecutionUpdate,
): void {
  if (existing.kind === incoming.kind) {
    return;
  }

  throw new Error(
    `Cannot merge ${existing.kind} with ${incoming.kind} for call ${incoming.callId}`,
  );
}

interface CommandExecutionFieldsTarget {
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  source: string | null;
}

interface CommandExecutionFieldsSource {
  approvalStatus?: EventProjectionApprovalLifecycleStatus | null;
  command?: string;
  cwd?: string | null;
  exitCode?: number | null;
  parsedIntents?: EventProjectionToolParsedIntent[];
  source?: string | null;
  status?: EventProjectionToolCallMessage["status"];
}

interface ToolCallExecutionFieldsTarget {
  approvalStatus: EventProjectionApprovalLifecycleStatus | null;
  parsedIntents: EventProjectionToolParsedIntent[];
  toolArgs: JsonObject | null;
  toolName: string | null;
}

interface ToolCallExecutionFieldsSource {
  approvalStatus?: EventProjectionApprovalLifecycleStatus | null;
  parsedIntents?: EventProjectionToolParsedIntent[];
  status?: EventProjectionToolCallMessage["status"];
  toolArgs?: JsonObject | null;
  toolName?: string | null;
}

interface DelegationExecutionFieldsTarget {
  description?: string;
  subagentType?: string;
  toolName: string | null;
}

interface DelegationExecutionFieldsSource {
  description?: string;
  subagentType?: string;
  toolName?: string | null;
}

function mergeCommandExecutionFields(
  target: CommandExecutionFieldsTarget,
  incoming: CommandExecutionFieldsSource,
): void {
  if (incoming.cwd && !target.cwd) target.cwd = incoming.cwd;
  if (incoming.source && !target.source) target.source = incoming.source;
  if (incoming.command && incoming.command !== target.command) {
    target.command = incoming.command;
    target.parsedIntents = incoming.parsedIntents ?? [];
  } else {
    target.parsedIntents = chooseParsedIntents(
      target.parsedIntents,
      incoming.parsedIntents ?? [],
    );
  }
  if (incoming.exitCode !== undefined) target.exitCode = incoming.exitCode;
  target.approvalStatus = applyApprovalStatusDelta(
    target.approvalStatus,
    buildApprovalStatusDelta(incoming.approvalStatus, incoming.status),
  );
}

function mergeToolCallExecutionFields(
  target: ToolCallExecutionFieldsTarget,
  incoming: ToolCallExecutionFieldsSource,
): void {
  if (incoming.toolName && !target.toolName) {
    target.toolName = incoming.toolName;
  }
  if (incoming.toolArgs && !target.toolArgs) {
    target.toolArgs = incoming.toolArgs;
  }
  target.parsedIntents = chooseParsedIntents(
    target.parsedIntents,
    incoming.parsedIntents ?? [],
  );
  target.approvalStatus = applyApprovalStatusDelta(
    target.approvalStatus,
    buildApprovalStatusDelta(incoming.approvalStatus, incoming.status),
  );
}

function mergeDelegationExecutionFields(
  target: DelegationExecutionFieldsTarget,
  incoming: DelegationExecutionFieldsSource,
): void {
  if (incoming.toolName && !target.toolName) {
    target.toolName = incoming.toolName;
  }
  if (incoming.subagentType && !target.subagentType) {
    target.subagentType = incoming.subagentType;
  }
  if (incoming.description && !target.description) {
    target.description = incoming.description;
  }
}

function mergeExecutionCompletion(
  target: ExecutionCompletionTarget,
  incoming: ExecutionCompletionSource,
): void {
  if (incoming.completedAt === undefined || incoming.completedAt === null) {
    return;
  }

  if (target.status === "interrupted" && incoming.status !== "error") {
    return;
  }

  target.completedAt = incoming.completedAt;
}

function mergeRunningExecutionMetadata(
  existing: RunningExecCall,
  incoming: ProviderExecutionUpdate,
): void {
  assertMatchingExecutionKind(existing, incoming);
  switch (incoming.kind) {
    case "command":
      if (existing.kind !== "command") return;
      mergeCommandExecutionFields(existing, incoming);
      return;
    case "tool-call":
      if (existing.kind !== "tool-call") return;
      mergeToolCallExecutionFields(existing, incoming);
      return;
    case "delegation":
      if (existing.kind !== "delegation") return;
      mergeDelegationExecutionFields(existing, incoming);
      return;
  }
}

function upsertRunningExecCall(
  existing: RunningExecCall | undefined,
  incoming: ProviderExecutionUpdate,
  meta: EventMeta,
  threadId: string,
  turnId: string | undefined,
): RunningExecCall {
  const scopeFields = turnId
    ? eventProjectionMessageTurnScopeFields(turnId)
    : eventProjectionMessageThreadScopeFields();
  if (!existing) {
    return createRunningExecCall(incoming, meta, threadId, scopeFields.scope);
  }

  // Merge strategy per field:
  //   "keep first"  — set once from the first event that provides it
  //   "keep latest" — provider begin/end can revise command text
  //   "keep latest non-null" — duration from authoritative terminal events
  //   "keep longest" — begin events carry partial output, end events carry full output
  //   "keep terminal" — first terminal state wins unless a later error arrives

  // keep first
  if (!areThreadEventScopesEqual(existing.scope, scopeFields.scope)) {
    throw new Error(
      `Cannot merge execution messages with different scopes for call ${incoming.callId}`,
    );
  }
  mergeRunningExecutionMetadata(existing, incoming);
  mergeExecutionCompletion(existing, incoming);
  if (!existing.parentToolCallId && incoming.parentToolCallId) {
    existing.parentToolCallId = incoming.parentToolCallId;
  }

  // keep longest (begin has partial, end has full)
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
  existing.status =
    mergeCallStatus(existing.status, incoming.status) ?? "pending";
  existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, meta.seq);
  existing.createdAt = Math.max(existing.createdAt, meta.createdAt);

  return existing;
}

function appendExecOutputDelta(
  target: BufferedExecutionOutput,
  delta: string | undefined,
): void {
  if (!delta || delta.length === 0) return;
  appendVisibleTextBuffer(target.outputBuffer, delta);
  syncBufferedExecutionOutput(target);
}

function applyExecutionOutputUpdate(
  target: BufferedExecutionOutput,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  if (appendOutput) {
    appendExecOutputDelta(target, incoming.output);
    return;
  }
  if (replaceOutput) {
    setBufferedExecutionOutput(
      target,
      incoming.output,
      isTerminalToolCallStatus(incoming.status),
    );
    return;
  }
  if (
    incoming.output.length >=
    getVisibleTextBufferFullLength(target.outputBuffer)
  ) {
    setBufferedExecutionOutput(target, incoming.output, true);
  }
}

function upsertPendingExecutionOutput(
  state: ToolActivityProjectionState,
  meta: EventMeta,
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  let pending = state.toolActivity.pendingOutputsByCallId.get(incoming.callId);
  if (!pending) {
    pending = {
      callId: incoming.callId,
      ...(incoming.parentToolCallId
        ? { parentToolCallId: incoming.parentToolCallId }
        : {}),
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      startedAt: meta.createdAt,
      output: "",
      status: incoming.status,
      outputBuffer: createVisibleTextBuffer(),
    };
    state.toolActivity.pendingOutputsByCallId.set(incoming.callId, pending);
  }

  applyExecutionOutputUpdate(pending, incoming, appendOutput, replaceOutput);
  pending.sourceSeqEnd = Math.max(pending.sourceSeqEnd, meta.seq);
  pending.createdAt = Math.max(pending.createdAt, meta.createdAt);
  if (!pending.parentToolCallId && incoming.parentToolCallId) {
    pending.parentToolCallId = incoming.parentToolCallId;
  }
  pending.status = mergeCallStatus(pending.status, incoming.status);
}

function applyPendingExecutionOutput(
  state: ToolActivityProjectionState,
  call: RunningExecCall,
): void {
  const pending = state.toolActivity.pendingOutputsByCallId.get(call.callId);
  if (!pending) {
    return;
  }

  if (isTerminalToolCallStatus(call.status)) {
    flushVisibleTextBuffer(pending.outputBuffer);
    syncBufferedExecutionOutput(pending);
  }
  reconcilePendingExecutionOutput(call, pending);
  call.sourceSeqStart = Math.min(call.sourceSeqStart, pending.sourceSeqStart);
  call.sourceSeqEnd = Math.max(call.sourceSeqEnd, pending.sourceSeqEnd);
  call.startedAt = Math.min(call.startedAt, pending.startedAt);
  call.createdAt = Math.max(call.createdAt, pending.createdAt);
  if (!call.parentToolCallId && pending.parentToolCallId) {
    call.parentToolCallId = pending.parentToolCallId;
  }
  call.status = mergeCallStatus(call.status, pending.status) ?? call.status;
  state.toolActivity.pendingOutputsByCallId.delete(call.callId);
}

function reconcilePendingExecutionOutput(
  call: RunningExecCall,
  pending: PendingExecutionOutput,
): void {
  const pendingText = getVisibleTextBufferFullText(pending.outputBuffer);
  if (pendingText.length === 0) {
    return;
  }

  const callText = getVisibleTextBufferFullText(call.outputBuffer);
  if (callText.includes(pendingText)) {
    return;
  }

  // Output deltas can arrive before begin; when the begin snapshot is a
  // divergent absolute snapshot, preserve both in event order.
  const reconciledText = pendingText.includes(callText)
    ? pendingText
    : `${pendingText}${callText}`;
  setRunningCallOutput(
    call,
    reconciledText,
    isTerminalToolCallStatus(call.status),
  );
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

function interruptPendingToolCall(
  call: InterruptibleToolCall,
  completedAt: number | null,
): void {
  if (call.status !== "pending") {
    return;
  }
  call.status = "interrupted";
  call.completedAt = completedAt;
  if (!call.output) {
    call.output = "Tool execution interrupted";
  }
}

function interruptPendingToolMessage(
  message: InterruptibleToolMessage,
  completedAt: number | null,
): void {
  switch (message.kind) {
    case "command":
    case "tool-call":
    case "delegation":
      interruptPendingToolCall(message, completedAt);
      return;
    case "web-search":
    case "web-fetch":
      if (message.status === "pending") {
        message.status = "interrupted";
        message.completedAt = completedAt;
      }
      return;
  }
}

function isInterruptibleToolMessage(
  message: EventProjectionMessage,
): message is InterruptibleToolMessage {
  return (
    isProviderExecutionMessage(message) ||
    message.kind === "web-search" ||
    message.kind === "web-fetch"
  );
}

type ExecutionMergeTarget = RunningExecCall | ViewProviderExecutionMessage;
type ExecutionMergeSource =
  | RunningExecCall
  | ProviderExecutionUpdate
  | ExecutionOutputUpdate;

function mergeExecutionOutput(
  target: ExecutionMergeTarget,
  incoming: ExecutionMergeSource,
  options: MergeCallSummaryOptions,
): void {
  const { appendOutput, replaceOutput, visibleOutput } = options;
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
}

function mergeExecutionSummary(
  target: ExecutionMergeTarget,
  incoming: ExecutionMergeSource,
  options: MergeCallSummaryOptions = {},
): void {
  mergeExecutionOutput(target, incoming, options);
  if ("kind" in incoming) {
    if (target.kind !== incoming.kind) {
      throw new Error(
        `Cannot merge ${target.kind} with ${incoming.kind} for call ${incoming.callId}`,
      );
    }
    switch (incoming.kind) {
      case "command":
        if (target.kind !== "command") return;
        mergeCommandExecutionFields(target, incoming);
        break;
      case "tool-call":
        if (target.kind !== "tool-call") return;
        mergeToolCallExecutionFields(target, incoming);
        break;
      case "delegation":
        if (target.kind !== "delegation") return;
        mergeDelegationExecutionFields(target, incoming);
        break;
    }
    mergeExecutionCompletion(target, incoming);
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
  args: InterruptPendingToolActivityArgs = DEFAULT_INTERRUPT_PENDING_TOOL_ACTIVITY_ARGS,
): void {
  const interruptedRunningCallIds: string[] = [];
  for (const call of state.toolActivity.runningCallsById.values()) {
    if (!shouldInterruptToolScope(call.scope, args)) {
      continue;
    }

    flushVisibleTextBuffer(call.outputBuffer);
    syncRunningCallVisibleOutput(call);
    interruptPendingToolCall(call, args.completedAt);

    const activeCall = findExecMessageInActiveCell(
      state.toolActivity.activeCell,
      call.callId,
    );
    if (activeCall) {
      mergeExecutionSummary(activeCall, call);
      interruptedRunningCallIds.push(call.callId);
      continue;
    }

    const historyMatch = findExecMessageInHistoryCells(state, call.callId);
    if (historyMatch) {
      mergeExecutionSummary(historyMatch.call, call);
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
    interruptPendingToolMessage(
      state.toolActivity.activeCell,
      args.completedAt,
    );
  }

  for (const cell of state.toolActivity.historyCells) {
    if (shouldInterruptToolScope(cell.scope, args)) {
      interruptPendingToolMessage(cell, args.completedAt);
    }
  }

  for (const message of state.messages) {
    if (
      isInterruptibleToolMessage(message) &&
      shouldInterruptToolScope(message.scope, args)
    ) {
      interruptPendingToolMessage(message, args.completedAt);
    }
  }
}

function createExecMessage(
  call: RunningExecCall,
): ViewProviderExecutionMessage {
  const rowKindForId = call.kind === "tool-call" ? "tool" : call.kind;
  const base = {
    id: messageId(call.threadId, rowKindForId, call.callId),
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
    completedAt: call.completedAt,
    status: call.status,
  };

  if (call.kind === "command") {
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

  if (call.kind === "delegation") {
    return {
      ...base,
      kind: "delegation",
      toolName: call.toolName ?? "Agent",
      subagentType: call.subagentType,
      description: call.description,
      childProjection: emptyEventProjection(),
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
  incoming: ProviderExecutionUpdate,
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
  applyPendingExecutionOutput(state, call);
  state.toolActivity.runningCallsById.set(call.callId, call);

  const existingInActive = findExecMessageInActiveCell(
    state.toolActivity.activeCell,
    call.callId,
  );
  if (existingInActive) {
    mergeExecutionSummary(existingInActive, call);
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
  incoming: ExecutionOutputUpdate,
  appendOutput?: boolean,
  replaceOutput?: boolean,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(
    incoming.callId,
  );
  if (existingRunning) {
    applyExecutionOutputUpdate(
      existingRunning,
      incoming,
      appendOutput,
      replaceOutput,
    );
    mergeExecutionSummary(existingRunning, incoming, {
      appendOutput,
      replaceOutput,
      visibleOutput: existingRunning.output,
    });
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
    mergeExecutionSummary(activeCall, incoming, {
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
  if (!historyMatch) {
    if (!existingRunning && !activeCall) {
      upsertPendingExecutionOutput(
        state,
        meta,
        incoming,
        appendOutput,
        replaceOutput,
      );
    }
    return;
  }

  mergeExecutionSummary(historyMatch.call, incoming, {
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
  incoming: ProviderExecutionUpdate,
): void {
  const running = state.toolActivity.runningCallsById.get(incoming.callId);
  const merged = upsertRunningExecCall(
    running,
    incoming,
    meta,
    threadId,
    turnId,
  );
  applyPendingExecutionOutput(state, merged);
  if (isTerminalToolCallStatus(merged.status)) {
    flushVisibleTextBuffer(merged.outputBuffer);
    syncRunningCallVisibleOutput(merged);
  }
  state.toolActivity.runningCallsById.delete(incoming.callId);

  const active = state.toolActivity.activeCell;
  const existingInActive = findExecMessageInActiveCell(active, incoming.callId);
  if (existingInActive) {
    mergeExecutionSummary(existingInActive, merged, {
      visibleOutput: merged.output,
    });
    if (isProviderExecutionMessage(active)) {
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, merged.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, merged.createdAt);
      state.toolActivity.finalizedExecCallIds.add(incoming.callId);
      flushActiveToolCell(state);
      return;
    }
  }

  if (
    state.toolActivity.finalizedExecCallIds.has(incoming.callId) &&
    merged.status !== "error"
  ) {
    return;
  }

  const historyMatch = findExecMessageInHistoryCells(state, incoming.callId);
  if (historyMatch) {
    mergeExecutionSummary(historyMatch.call, merged, {
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
