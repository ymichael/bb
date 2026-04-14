import type {
  TimelineRow,
  TimelineToolGroupRow,
  ViewMessage,
  ViewProjection,
  ViewTurn,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getMessageStartedAt } from "./format-helpers.js";
import { mergeProvisioningOperations } from "./provisioning-helpers.js";
import {
  findLastTerminalTimelineMessageIndex,
  isTimelineUngroupableMessage,
  toIndexedTimelineMessages,
  type IndexedTimelineMessage,
} from "./timeline-message-helpers.js";

export interface BuildTimelineRowsOptions {
  includeToolGroupMessages?: boolean;
  /** When true, group all non-ungroupable messages into one group, ignoring terminal detection. */
  collapseAll?: boolean;
}

function isToolExploringMessage(
  message: ViewMessage,
): message is Extract<ViewMessage, { kind: "tool-exploring" }> {
  return message.kind === "tool-exploring";
}

function isFileEditMessage(
  message: ViewMessage,
): message is Extract<ViewMessage, { kind: "file-edit" }> {
  return message.kind === "file-edit";
}

function getGroupDurationMs(messages: readonly Pick<ViewMessage, "createdAt" | "startedAt">[]): number | undefined {
  if (messages.length === 0) return undefined;
  const startedAt = Math.min(...messages.map((message) => getMessageStartedAt(message)));
  const endedAt = Math.max(...messages.map((message) => message.createdAt));
  const durationMs = endedAt - startedAt;
  return durationMs > 0 ? durationMs : undefined;
}

type TerminalStatus = "pending" | "completed" | "error" | "interrupted";

interface ReconnectAttempt {
  attempt: number;
  total: number;
}

function statusPriority(status: TerminalStatus): number {
  switch (status) {
    case "completed":
      return 0;
    case "interrupted":
      return 1;
    case "pending":
      return 2;
    case "error":
      return 3;
    default:
      return assertNever(status);
  }
}

function mergeStatus<T extends TerminalStatus>(left: T, right: T): T {
  return statusPriority(left) >= statusPriority(right) ? left : right;
}

function parseReconnectAttempt(
  message: Extract<ViewMessage, { kind: "error" }>,
): ReconnectAttempt | null {
  const match = message.message.trim().match(/^Reconnecting\.\.\.\s+(\d+)\/(\d+)$/);
  if (!match) return null;

  const attempt = Number.parseInt(match[1] ?? "", 10);
  const total = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(attempt) || !Number.isFinite(total)) {
    return null;
  }
  if (attempt <= 0 || total <= 0 || attempt > total) {
    return null;
  }

  return { attempt, total };
}

function mergeConsecutiveReconnectErrors(messages: ViewMessage[]): ViewMessage[] {
  const merged: ViewMessage[] = [];
  let active: Extract<ViewMessage, { kind: "error" }> | null = null;
  let activeReconnect: ReconnectAttempt | null = null;

  const flush = () => {
    if (!active) return;
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

    const reconnect = parseReconnectAttempt(message);
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

    const isSameTurn = (active.turnId ?? null) === (message.turnId ?? null);
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
        id: `${active.id}:reconnect:${message.id}`,
        sourceSeqStart: Math.min(active.sourceSeqStart, message.sourceSeqStart),
        sourceSeqEnd: Math.max(active.sourceSeqEnd, message.sourceSeqEnd),
        createdAt: Math.max(active.createdAt, message.createdAt),
        startedAt: Math.min(getMessageStartedAt(active), getMessageStartedAt(message)),
        turnId: active.turnId ?? message.turnId,
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

function mergeConsecutiveToolActivityMessages(
  messages: ViewMessage[],
): ViewMessage[] {
  const merged: ViewMessage[] = [];
  let active:
    | Extract<ViewMessage, { kind: "tool-exploring" }>
    | Extract<ViewMessage, { kind: "file-edit" }>
    | null = null;

  const flush = () => {
    if (!active) return;
    merged.push(active);
    active = null;
  };

  for (const message of messages) {
    if (!isToolExploringMessage(message) && !isFileEditMessage(message)) {
      flush();
      merged.push(message);
      continue;
    }

    if (!active) {
      active = isToolExploringMessage(message)
        ? {
            ...message,
            calls: [...message.calls],
          }
        : {
            ...message,
            changes: message.changes.map((change) => ({ ...change })),
          };
      continue;
    }

    if ((active.turnId ?? null) !== (message.turnId ?? null)) {
      flush();
      active = isToolExploringMessage(message)
        ? {
            ...message,
            calls: [...message.calls],
          }
        : {
            ...message,
            changes: message.changes.map((change) => ({ ...change })),
          };
      continue;
    }

    if (isToolExploringMessage(active) && isToolExploringMessage(message)) {
      active.calls = [...active.calls, ...message.calls];
      active.sourceSeqStart = Math.min(active.sourceSeqStart, message.sourceSeqStart);
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, message.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, message.createdAt);
      active.startedAt = Math.min(getMessageStartedAt(active), getMessageStartedAt(message));
      if (!active.turnId && message.turnId) {
        active.turnId = message.turnId;
      }
      active.status =
        active.status === "pending" || message.status === "pending"
          ? "pending"
          : "completed";
      continue;
    }

    if (isFileEditMessage(active) && isFileEditMessage(message)) {
      active.changes = [
        ...active.changes,
        ...message.changes.map((change) => ({ ...change })),
      ];
      active.sourceSeqStart = Math.min(active.sourceSeqStart, message.sourceSeqStart);
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, message.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, message.createdAt);
      active.startedAt = Math.min(getMessageStartedAt(active), getMessageStartedAt(message));
      if (!active.turnId && message.turnId) {
        active.turnId = message.turnId;
      }
      active.status = mergeStatus(active.status, message.status);
      if (message.stdout) {
        active.stdout = message.stdout;
      }
      if (message.stderr) {
        active.stderr = message.stderr;
      }
      continue;
    }

    flush();
    active = isToolExploringMessage(message)
      ? {
          ...message,
          calls: [...message.calls],
        }
      : {
          ...message,
          changes: message.changes.map((change) => ({ ...change })),
        };
  }

  flush();
  return merged;
}

function getToolGroupSummaryCount(messages: ViewMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.kind === "tool-exploring") {
      return count + Math.max(1, message.calls.length);
    }
    if (message.kind === "file-edit") {
      return count + Math.max(1, message.changes.length);
    }
    return count + 1;
  }, 0);
}

function getGroupMessageStatus(
  message: ViewMessage,
): TimelineToolGroupRow["status"] {
  switch (message.kind) {
    case "tool-exploring":
    case "tool-call":
    case "web-search":
    case "file-edit":
    case "tasks":
    case "delegation":
    case "permission-grant-lifecycle":
      return message.status;
    case "assistant-reasoning":
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

type IndexedTurnMessage = IndexedTimelineMessage;

function isLossyActiveTurn(messages: IndexedTurnMessage[]): boolean {
  return messages.some(({ message }) => getGroupMessageStatus(message) === "pending");
}

interface BuildTurnToolGroupRowArgs {
  durationMs: number | undefined;
  includeToolGroupMessages: boolean;
  messages: ViewMessage[];
  summaryCount: number;
  turn: ViewTurn;
}

function prepareTimelineMessages(messages: ViewMessage[]): ViewMessage[] {
  const provisioningMergedMessages = mergeProvisioningOperations(messages);
  const reconnectMergedMessages = mergeConsecutiveReconnectErrors(
    provisioningMergedMessages,
  );
  return mergeConsecutiveToolActivityMessages(reconnectMergedMessages);
}

function getTurnToolGroupRowId(turn: ViewTurn): string {
  return `${turn.turnId}:tool-group:${turn.sourceSeqStart}`;
}

function toMessageRow(message: ViewMessage): TimelineRow {
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

function findLastUngroupableIndexBeforeTerminal(
  messages: IndexedTimelineMessage[],
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
  messages: IndexedTimelineMessage[],
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

function buildTurnToolGroupRow(
  args: BuildTurnToolGroupRowArgs,
): TimelineToolGroupRow {
  const groupMessages = args.includeToolGroupMessages
    ? mergeConsecutiveToolActivityMessages(args.messages)
    : [];
  const row: TimelineToolGroupRow = {
    kind: "tool-group",
    id: getTurnToolGroupRowId(args.turn),
    turnId: args.turn.turnId,
    summaryCount: args.summaryCount,
    sourceSeqStart: args.turn.sourceSeqStart,
    sourceSeqEnd: args.turn.sourceSeqEnd,
    startedAt: args.turn.startedAt,
    createdAt: args.turn.createdAt,
    status: args.turn.status,
    messages: groupMessages,
  };
  if (args.durationMs !== undefined) {
    row.durationMs = args.durationMs;
  }
  return row;
}

function buildPendingTurnRows(turn: ViewTurn): TimelineRow[] {
  return prepareTimelineMessages(turn.messages ?? []).map((message) =>
    toMessageRow(message)
  );
}

function buildTerminalTurnRows(
  turn: ViewTurn,
  includeToolGroupMessages: boolean,
  collapseAll: boolean,
): TimelineRow[] {
  if (!turn.messages) {
    const rows: TimelineRow[] = [];
    if (turn.summaryCount > 0) {
      rows.push(buildTurnToolGroupRow({
        durationMs: turn.durationMs,
        includeToolGroupMessages,
        messages: [],
        summaryCount: turn.summaryCount,
        turn,
      }));
    }
    if (turn.terminalMessage) {
      rows.push(toMessageRow(turn.terminalMessage));
    }
    return rows;
  }

  const mergedMessages = prepareTimelineMessages(turn.messages);
  const indexedMessages = toIndexedTimelineMessages(mergedMessages);
  if (collapseAll && isLossyActiveTurn(indexedMessages)) {
    return mergedMessages.map((message) => toMessageRow(message));
  }

  const collapsedMessageIndices = new Set<number>();
  const groupedTurnMessages = collapseAll
    ? indexedMessages.filter(({ message }) =>
        !isTimelineUngroupableMessage(message)
      )
    : getGroupedTerminalTurnMessages(indexedMessages);
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
  for (const [index, message] of mergedMessages.entries()) {
    const collapseGroup = collapsedByFirstIndex.get(index);
    if (collapseGroup) {
      rows.push(buildTurnToolGroupRow({
        durationMs: collapseAll
          ? getGroupDurationMs(collapseGroup)
          : turn.durationMs ?? getGroupDurationMs(collapseGroup),
        includeToolGroupMessages,
        messages: collapseGroup,
        summaryCount: getToolGroupSummaryCount(collapseGroup),
        turn,
      }));
    }
    if (collapsedMessageIndices.has(index)) {
      continue;
    }
    rows.push(toMessageRow(message));
  }
  return rows;
}

function buildTurnRows(
  turn: ViewTurn,
  options: BuildTimelineRowsOptions | undefined,
): TimelineRow[] {
  const includeToolGroupMessages = options?.includeToolGroupMessages ?? true;
  const collapseAll = options?.collapseAll ?? false;
  if (turn.status === "pending" && !collapseAll) {
    return buildPendingTurnRows(turn);
  }
  return buildTerminalTurnRows(turn, includeToolGroupMessages, collapseAll);
}

export function buildTimelineRows(
  projection: ViewProjection,
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const standaloneMessages: ViewMessage[] = [];
  const flushStandaloneMessages = () => {
    if (standaloneMessages.length === 0) {
      return;
    }
    rows.push(
      ...prepareTimelineMessages(standaloneMessages).map((message) =>
        toMessageRow(message)
      ),
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
