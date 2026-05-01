import type {
  TimelineAssistantStepSummaryChildRow,
  TimelineAssistantStepSummaryRow,
  TimelineGroupedRowStatus,
  TimelineMessageRow,
  TimelineRow,
  TimelineToolBundleKind,
  TimelineToolBundleRow,
  TimelineTurnSummaryChildRow,
  TimelineTurnSummaryRow,
  ViewMessage,
  ViewProjection,
  ViewTurn,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getMessageStartedAt } from "./format-helpers.js";
import {
  findLastTerminalTimelineMessageIndex,
  isTimelineUngroupableMessage,
  toIndexedTimelineMessages,
  type IndexedTimelineMessage,
} from "./timeline-message-helpers.js";
import { mergeGroupedRowStatus } from "./timeline-grouped-row-status.js";
import {
  summarizeExploringCounts,
  type ToolIntentSummary,
} from "./timeline-render-helpers.js";
import { isExploringCall } from "./tool-call-parsing.js";
import {
  getViewMessageScopeTurnId,
  haveCompatibleViewMessageScope,
} from "./message-scope.js";

export interface BuildTimelineRowsOptions {
  includeNestedRows?: boolean;
}

type TimelineRowsBuildMode = "default" | "collapsed";

interface ResolvedBuildTimelineRowsOptions {
  includeNestedRows: boolean;
  mode: TimelineRowsBuildMode;
}

interface TimelineMessageRange {
  createdAt: number;
  sourceSeqEnd: number;
  sourceSeqStart: number;
  startedAt: number;
}

interface ToolBundleAccumulator {
  bundleKind: TimelineToolBundleKind;
  messages: ViewMessage[];
}

function getTimelineRange(
  messages: readonly Pick<
    ViewMessage,
    "createdAt" | "startedAt" | "sourceSeqEnd" | "sourceSeqStart"
  >[],
): TimelineMessageRange | null {
  if (messages.length === 0) {
    return null;
  }

  return {
    createdAt: Math.max(...messages.map((message) => message.createdAt)),
    sourceSeqEnd: Math.max(...messages.map((message) => message.sourceSeqEnd)),
    sourceSeqStart: Math.min(
      ...messages.map((message) => message.sourceSeqStart),
    ),
    startedAt: Math.min(
      ...messages.map((message) => getMessageStartedAt(message)),
    ),
  };
}

function getDurationMs(range: TimelineMessageRange | null): number | undefined {
  if (!range) {
    return undefined;
  }

  const durationMs = range.createdAt - range.startedAt;
  return durationMs > 0 ? durationMs : undefined;
}

function getGroupMessageStatus(message: ViewMessage): TimelineGroupedRowStatus {
  switch (message.kind) {
    case "command":
    case "tool-call":
    case "web-search":
    case "web-fetch":
    case "file-edit":
    case "tasks":
    case "delegation":
    case "permission-grant-lifecycle":
      return message.status;
    case "assistant-text":
      return message.status === "streaming" ? "pending" : message.status;
    case "operation":
      return message.status ?? "completed";
    case "error":
      return "error";
    case "user":
    case "debug/raw-event":
      return "completed";
    default:
      return assertNever(message);
  }
}

function getReconnectAttempt(
  message: Extract<ViewMessage, { kind: "error" }>,
): { attempt: number; total: number } | null {
  if (
    message.reconnectAttempt === undefined ||
    message.reconnectTotal === undefined
  ) {
    return null;
  }

  if (
    message.reconnectAttempt <= 0 ||
    message.reconnectTotal <= 0 ||
    message.reconnectAttempt > message.reconnectTotal
  ) {
    return null;
  }

  return {
    attempt: message.reconnectAttempt,
    total: message.reconnectTotal,
  };
}

function mergeConsecutiveReconnectErrors(
  messages: readonly ViewMessage[],
): ViewMessage[] {
  const merged: ViewMessage[] = [];
  let active: Extract<ViewMessage, { kind: "error" }> | null = null;
  let activeReconnect: { attempt: number; total: number } | null = null;

  const flush = () => {
    if (!active) {
      return;
    }
    merged.push(active);
    active = null;
    activeReconnect = null;
  };

  for (const message of messages) {
    if (message.kind !== "error") {
      flush();
      merged.push(message);
      continue;
    }

    const reconnect = getReconnectAttempt(message);
    if (!reconnect) {
      flush();
      merged.push(message);
      continue;
    }

    if (!active || !activeReconnect) {
      active = { ...message };
      activeReconnect = reconnect;
      continue;
    }

    const isSameTurn = haveCompatibleViewMessageScope(active, message);
    const isSameThread = active.threadId === message.threadId;
    const isSameRawType = active.rawType === message.rawType;
    const isSameRetryBudget = activeReconnect.total === reconnect.total;
    const isNextAttempt = reconnect.attempt === activeReconnect.attempt + 1;

    if (
      isSameTurn &&
      isSameThread &&
      isSameRawType &&
      isSameRetryBudget &&
      isNextAttempt
    ) {
      active = {
        ...message,
        id: active.id,
        sourceSeqStart: Math.min(active.sourceSeqStart, message.sourceSeqStart),
        sourceSeqEnd: Math.max(active.sourceSeqEnd, message.sourceSeqEnd),
        createdAt: Math.max(active.createdAt, message.createdAt),
        startedAt: Math.min(
          getMessageStartedAt(active),
          getMessageStartedAt(message),
        ),
      };
      activeReconnect = reconnect;
      continue;
    }

    flush();
    active = { ...message };
    activeReconnect = reconnect;
  }

  flush();
  return merged;
}

function getTurnSummaryCount(messages: readonly ViewMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.kind === "file-edit") {
      return count + Math.max(1, message.changes.length);
    }
    return count + 1;
  }, 0);
}

function prepareTimelineMessages(
  messages: readonly ViewMessage[],
): ViewMessage[] {
  return mergeConsecutiveReconnectErrors(messages);
}

function toMessageRow(message: ViewMessage): TimelineMessageRow {
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

function isExplorationToolCallMessage(
  message: Extract<ViewMessage, { kind: "tool-call" }>,
): boolean {
  return isExploringCall({ parsedIntents: message.parsedIntents });
}

function isExplorationToolActivityMessage(
  message: Extract<ViewMessage, { kind: "command" | "tool-call" }>,
): boolean {
  return isExploringCall({ parsedIntents: message.parsedIntents });
}

function toToolCallSummary(
  message: Extract<ViewMessage, { kind: "command" | "tool-call" }>,
): ToolIntentSummary {
  if (message.kind === "command") {
    return {
      kind: "command",
      command: message.command,
      parsedIntents: message.parsedIntents,
    };
  }
  return {
    kind: "tool-call",
    toolName: message.toolName,
    toolArgs: message.toolArgs,
    parsedIntents: message.parsedIntents,
  };
}

function getRowStatus(
  row: TimelineAssistantStepSummaryChildRow,
): TimelineGroupedRowStatus {
  switch (row.kind) {
    case "message":
      return getGroupMessageStatus(row.message);
    case "tool-bundle":
      return row.status;
    default:
      return assertNever(row);
  }
}

function getToolBundleKind(
  message: ViewMessage,
): TimelineToolBundleKind | null {
  switch (message.kind) {
    case "command":
      if (isExplorationToolActivityMessage(message)) {
        return "exploration";
      }
      return "commands";
    case "tool-call":
      if (isExplorationToolCallMessage(message)) {
        return "exploration";
      }
      return null;
    case "web-search":
    case "web-fetch":
      return "web-research";
    case "delegation":
      return "delegations";
    case "assistant-text":
    case "debug/raw-event":
    case "error":
    case "file-edit":
    case "operation":
    case "permission-grant-lifecycle":
    case "tasks":
    case "user":
      return null;
    default:
      return assertNever(message);
  }
}

function canAppendToToolBundle(
  active: ToolBundleAccumulator,
  message: ViewMessage,
): boolean {
  switch (active.bundleKind) {
    case "exploration":
      return (
        (message.kind === "command" || message.kind === "tool-call") &&
        isExplorationToolActivityMessage(message)
      );
    case "commands":
      return message.kind === "command";
    case "web-research":
      return message.kind === "web-search" || message.kind === "web-fetch";
    case "delegations":
      return message.kind === "delegation";
    default:
      return assertNever(active.bundleKind);
  }
}

function buildToolBundleSummary(
  bundleKind: TimelineToolBundleKind,
  messages: readonly ViewMessage[],
): TimelineToolBundleRow["summary"] {
  switch (bundleKind) {
    case "exploration": {
      const calls = messages.map((message) => {
        if (
          (message.kind !== "command" && message.kind !== "tool-call") ||
          !isExplorationToolActivityMessage(message)
        ) {
          throw new Error(
            `Exploration bundles require exploring command or tool-call messages, got ${message.kind}`,
          );
        }
        return toToolCallSummary(message);
      });
      const counts = summarizeExploringCounts(calls);
      return {
        kind: "exploration",
        filesRead: counts.filesRead,
        searches: counts.searches,
        lists: counts.lists,
      };
    }
    case "commands": {
      for (const message of messages) {
        if (message.kind !== "command") {
          throw new Error(
            `Command bundles require command messages, got ${message.kind}`,
          );
        }
      }
      return {
        kind: "commands",
        commands: messages.length,
      };
    }
    case "web-research": {
      let webPagesRead = 0;
      let webSearches = 0;
      for (const message of messages) {
        switch (message.kind) {
          case "web-search":
            webSearches += Math.max(1, message.queries.length);
            break;
          case "web-fetch":
            webPagesRead += 1;
            break;
          default:
            throw new Error(
              "Web research bundles require web-search or web-fetch messages",
            );
        }
      }
      return {
        kind: "web-research",
        webPagesRead,
        webSearches,
      };
    }
    case "delegations": {
      for (const message of messages) {
        if (message.kind !== "delegation") {
          throw new Error(
            `Delegation bundles require delegation messages, got ${message.kind}`,
          );
        }
      }
      return {
        kind: "delegations",
        delegations: messages.length,
      };
    }
    default:
      return assertNever(bundleKind);
  }
}

function getToolBundleMinimumSize(bundleKind: TimelineToolBundleKind): number {
  switch (bundleKind) {
    case "delegations":
      return 2;
    case "commands":
    case "exploration":
    case "web-research":
      return 1;
    default:
      return assertNever(bundleKind);
  }
}

function shouldMaterializeToolBundle(
  accumulator: ToolBundleAccumulator,
): boolean {
  return (
    accumulator.messages.length >=
    getToolBundleMinimumSize(accumulator.bundleKind)
  );
}

function buildToolBundleRow(
  accumulator: ToolBundleAccumulator,
): TimelineToolBundleRow {
  const range = getTimelineRange(accumulator.messages);
  if (!range) {
    throw new Error("tool-bundle requires at least one message");
  }

  const status = accumulator.messages.reduce<TimelineGroupedRowStatus>(
    (current, message) =>
      mergeGroupedRowStatus(current, getGroupMessageStatus(message)),
    "completed",
  );
  const row: TimelineToolBundleRow = {
    kind: "tool-bundle",
    bundleKind: accumulator.bundleKind,
    id: `${accumulator.messages[0]!.id}:tool-bundle:${range.sourceSeqStart}:${accumulator.bundleKind}`,
    presentation: "default",
    turnId: getViewMessageScopeTurnId(accumulator.messages[0]!),
    sourceSeqStart: range.sourceSeqStart,
    sourceSeqEnd: range.sourceSeqEnd,
    startedAt: range.startedAt,
    createdAt: range.createdAt,
    status,
    summary: buildToolBundleSummary(
      accumulator.bundleKind,
      accumulator.messages,
    ),
    rows: accumulator.messages.map((message) => toMessageRow(message)),
  };
  const durationMs = getDurationMs(range);
  if (durationMs !== undefined) {
    row.durationMs = durationMs;
  }
  return row;
}

function buildToolBundleRows(
  messages: readonly ViewMessage[],
): TimelineAssistantStepSummaryChildRow[] {
  const rows: TimelineAssistantStepSummaryChildRow[] = [];
  let active: ToolBundleAccumulator | null = null;

  const flush = () => {
    if (!active) {
      return;
    }
    if (shouldMaterializeToolBundle(active)) {
      rows.push(buildToolBundleRow(active));
    } else {
      rows.push(toMessageRow(active.messages[0]!));
    }
    active = null;
  };

  for (const message of messages) {
    const bundleKind = getToolBundleKind(message);
    if (!bundleKind) {
      flush();
      rows.push(toMessageRow(message));
      continue;
    }

    if (!active) {
      active = {
        bundleKind,
        messages: [message],
      };
      continue;
    }

    if (
      active.bundleKind !== bundleKind ||
      !canAppendToToolBundle(active, message)
    ) {
      flush();
      active = {
        bundleKind,
        messages: [message],
      };
      continue;
    }

    active.messages.push(message);
  }

  flush();
  return rows;
}

function isAssistantBoundaryRow(
  row: TimelineAssistantStepSummaryChildRow,
): boolean {
  return row.kind === "message" && row.message.kind === "assistant-text";
}

function getRowRange(
  rows: readonly TimelineAssistantStepSummaryChildRow[],
): TimelineMessageRange | null {
  if (rows.length === 0) {
    return null;
  }

  return {
    createdAt: Math.max(
      ...rows.map((row) =>
        row.kind === "message" ? row.message.createdAt : row.createdAt,
      ),
    ),
    sourceSeqEnd: Math.max(
      ...rows.map((row) =>
        row.kind === "message" ? row.message.sourceSeqEnd : row.sourceSeqEnd,
      ),
    ),
    sourceSeqStart: Math.min(
      ...rows.map((row) =>
        row.kind === "message"
          ? row.message.sourceSeqStart
          : row.sourceSeqStart,
      ),
    ),
    startedAt: Math.min(
      ...rows.map((row) =>
        row.kind === "message"
          ? getMessageStartedAt(row.message)
          : row.startedAt,
      ),
    ),
  };
}

function findFirstRowTurnId(
  rows: readonly TimelineAssistantStepSummaryChildRow[],
): string | null {
  for (const entry of rows) {
    if (entry.kind === "message") {
      const turnId = getViewMessageScopeTurnId(entry.message);
      if (turnId !== null) {
        return turnId;
      }
      continue;
    }

    if (entry.turnId !== null) {
      return entry.turnId;
    }
  }

  return null;
}

function buildAssistantStepSummaryRow(
  rows: TimelineAssistantStepSummaryChildRow[],
): TimelineAssistantStepSummaryRow {
  const range = getRowRange(rows);
  if (!range) {
    throw new Error("assistant-step-summary requires at least one child row");
  }

  const status = rows.reduce<TimelineGroupedRowStatus>(
    (current, row) => mergeGroupedRowStatus(current, getRowStatus(row)),
    "completed",
  );
  const row: TimelineAssistantStepSummaryRow = {
    kind: "assistant-step-summary",
    id: `${rows[0]!.id}:assistant-step-summary:${range.sourceSeqStart}`,
    turnId: findFirstRowTurnId(rows),
    sourceSeqStart: range.sourceSeqStart,
    sourceSeqEnd: range.sourceSeqEnd,
    startedAt: range.startedAt,
    createdAt: range.createdAt,
    status,
    rows,
  };
  const durationMs = getDurationMs(range);
  if (durationMs !== undefined) {
    row.durationMs = durationMs;
  }
  return row;
}

function materializeAssistantStepSummaryRows(
  rows: TimelineAssistantStepSummaryChildRow[],
): TimelineTurnSummaryChildRow[] {
  if (rows.length === 1 && rows[0]?.kind === "tool-bundle") {
    return [
      {
        ...rows[0],
        presentation: "assistant-step-summary-placeholder",
      },
    ];
  }

  return [buildAssistantStepSummaryRow(rows)];
}

type AssistantStepSummaryMode = "active" | "completed";

function buildAssistantStepSummaryRows(
  rows: readonly TimelineAssistantStepSummaryChildRow[],
  mode: AssistantStepSummaryMode,
): TimelineTurnSummaryChildRow[] {
  const groupedRows: TimelineTurnSummaryChildRow[] = [];
  let bufferedRows: TimelineAssistantStepSummaryChildRow[] = [];
  let hasSeenAssistantMessage = false;

  for (const row of rows) {
    if (isAssistantBoundaryRow(row)) {
      if (bufferedRows.length > 0) {
        if (hasSeenAssistantMessage || mode === "completed") {
          groupedRows.push(
            ...materializeAssistantStepSummaryRows(bufferedRows),
          );
        } else {
          groupedRows.push(...bufferedRows);
        }
        bufferedRows = [];
      }

      hasSeenAssistantMessage = true;
      groupedRows.push(row);
      continue;
    }

    bufferedRows.push(row);
  }

  if (bufferedRows.length > 0) {
    if (mode === "active") {
      groupedRows.push(...bufferedRows);
    } else {
      groupedRows.push(...materializeAssistantStepSummaryRows(bufferedRows));
    }
  }

  return groupedRows;
}

function isLossyActiveTurn(
  messages: readonly IndexedTimelineMessage[],
): boolean {
  return messages.some(
    ({ message }) => getGroupMessageStatus(message) === "pending",
  );
}

function findLastUngroupableIndexBeforeTerminal(
  messages: readonly IndexedTimelineMessage[],
  terminalIndex: number,
): number {
  let boundaryIndex = -1;
  for (const { index, message } of messages) {
    if (index >= terminalIndex) {
      break;
    }
    if (isTimelineUngroupableMessage(message)) {
      boundaryIndex = index;
    }
  }
  return boundaryIndex;
}

function getGroupedTerminalTurnMessages(
  messages: readonly IndexedTimelineMessage[],
): IndexedTimelineMessage[] {
  const terminalIndex = findLastTerminalTimelineMessageIndex(messages);
  if (terminalIndex === null) {
    return [];
  }
  const boundaryIndex = findLastUngroupableIndexBeforeTerminal(
    messages,
    terminalIndex,
  );
  return messages.filter(({ index, message }) => {
    if (index <= boundaryIndex) return false;
    if (index >= terminalIndex) return false;
    if (isTimelineUngroupableMessage(message)) return false;
    return true;
  });
}

function buildTurnSummaryRows(
  messages: readonly ViewMessage[],
): TimelineTurnSummaryChildRow[] {
  return buildAssistantStepSummaryRows(
    buildToolBundleRows(messages),
    "completed",
  );
}

function getTurnSummaryRowId(turn: ViewTurn): string {
  return `${turn.turnId}:turn-summary:${turn.sourceSeqStart}`;
}

interface BuildTurnSummaryRowArgs {
  durationMs: number | undefined;
  includeNestedRows: boolean;
  messages: ViewMessage[];
  summaryCount: number;
  turn: ViewTurn;
}

function buildTurnSummaryRow(
  args: BuildTurnSummaryRowArgs,
): TimelineTurnSummaryRow {
  const row: TimelineTurnSummaryRow = {
    kind: "turn-summary",
    id: getTurnSummaryRowId(args.turn),
    turnId: args.turn.turnId,
    summaryCount: args.summaryCount,
    sourceSeqStart: args.turn.sourceSeqStart,
    sourceSeqEnd: args.turn.sourceSeqEnd,
    startedAt: args.turn.startedAt,
    createdAt: args.turn.createdAt,
    status: args.turn.status,
    rows: args.includeNestedRows ? buildTurnSummaryRows(args.messages) : null,
  };
  if (args.durationMs !== undefined) {
    row.durationMs = args.durationMs;
  }
  return row;
}

function buildActiveTurnRows(turn: ViewTurn): TimelineRow[] {
  return buildAssistantStepSummaryRows(
    buildToolBundleRows(prepareTimelineMessages(turn.messages ?? [])),
    "active",
  );
}

function buildTerminalTurnRows(
  turn: ViewTurn,
  includeNestedRows: boolean,
  mode: TimelineRowsBuildMode,
): TimelineRow[] {
  const collapseAll = mode === "collapsed";
  if (!turn.messages) {
    const rows: TimelineRow[] = [];
    if (turn.summaryCount > 0) {
      rows.push(
        buildTurnSummaryRow({
          durationMs: turn.durationMs,
          includeNestedRows,
          messages: [],
          summaryCount: turn.summaryCount,
          turn,
        }),
      );
    }
    if (turn.terminalMessage) {
      rows.push(toMessageRow(turn.terminalMessage));
    }
    return rows;
  }

  const mergedMessages = prepareTimelineMessages(turn.messages);
  const indexedMessages = toIndexedTimelineMessages(mergedMessages);
  if (collapseAll && isLossyActiveTurn(indexedMessages)) {
    return buildAssistantStepSummaryRows(
      buildToolBundleRows(mergedMessages),
      "active",
    );
  }

  const groupedTurnMessages = collapseAll
    ? indexedMessages.filter(
        ({ message }) => !isTimelineUngroupableMessage(message),
      )
    : getGroupedTerminalTurnMessages(indexedMessages);
  const collapsedMessageIndices = new Set<number>();
  const collapsedByFirstIndex = new Map<number, ViewMessage[]>();

  if (groupedTurnMessages.length > 0) {
    for (const { index } of groupedTurnMessages) {
      collapsedMessageIndices.add(index);
    }
    collapsedByFirstIndex.set(
      groupedTurnMessages[0]!.index,
      groupedTurnMessages.map(({ message }) => message),
    );
  }

  const rows: TimelineRow[] = [];
  let segmentMessages: ViewMessage[] = [];
  const flushSegmentMessages = () => {
    if (segmentMessages.length === 0) {
      return;
    }
    rows.push(...buildToolBundleRows(segmentMessages));
    segmentMessages = [];
  };

  for (const [index, message] of mergedMessages.entries()) {
    const collapseGroup = collapsedByFirstIndex.get(index);
    if (collapseGroup) {
      flushSegmentMessages();
      rows.push(
        buildTurnSummaryRow({
          durationMs: collapseAll
            ? getDurationMs(getTimelineRange(collapseGroup))
            : (turn.durationMs ??
              getDurationMs(getTimelineRange(collapseGroup))),
          includeNestedRows,
          messages: collapseGroup,
          summaryCount: getTurnSummaryCount(collapseGroup),
          turn,
        }),
      );
    }
    if (collapsedMessageIndices.has(index)) {
      continue;
    }
    segmentMessages.push(message);
  }

  flushSegmentMessages();
  return rows;
}

function buildTurnRows(
  turn: ViewTurn,
  options: ResolvedBuildTimelineRowsOptions,
): TimelineRow[] {
  if (turn.status === "pending" && options.mode === "default") {
    return buildActiveTurnRows(turn);
  }
  return buildTerminalTurnRows(turn, options.includeNestedRows, options.mode);
}

function resolveBuildTimelineRowsOptions(
  options: BuildTimelineRowsOptions | undefined,
  mode: TimelineRowsBuildMode,
): ResolvedBuildTimelineRowsOptions {
  return {
    includeNestedRows: options?.includeNestedRows ?? true,
    mode,
  };
}

function buildTimelineRowsWithMode(
  projection: ViewProjection,
  options: ResolvedBuildTimelineRowsOptions,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const standaloneMessages: ViewMessage[] = [];

  const flushStandaloneMessages = () => {
    if (standaloneMessages.length === 0) {
      return;
    }
    rows.push(
      ...buildToolBundleRows(prepareTimelineMessages(standaloneMessages)),
    );
    standaloneMessages.length = 0;
  };

  for (const entry of projection.entries) {
    if (entry.kind === "message") {
      standaloneMessages.push(entry.message);
      continue;
    }
    flushStandaloneMessages();
    rows.push(...buildTurnRows(entry.turn, options));
  }

  flushStandaloneMessages();
  return rows;
}

export function buildTimelineRows(
  projection: ViewProjection,
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  return buildTimelineRowsWithMode(
    projection,
    resolveBuildTimelineRowsOptions(options, "default"),
  );
}

export function buildCollapsedTimelineRows(
  projection: ViewProjection,
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  return buildTimelineRowsWithMode(
    projection,
    resolveBuildTimelineRowsOptions(options, "collapsed"),
  );
}
