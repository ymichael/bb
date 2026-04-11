import type {
  TimelineRow,
  TimelineToolGroupRow,
  ViewMessage,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { getMessageStartedAt } from "./format-helpers.js";
import { mergeProvisioningOperations } from "./provisioning-helpers.js";
import {
  mergeThreadOperationMessages,
} from "./thread-operation-helpers.js";

/** Messages that are never absorbed into a tool-group (they always stay standalone). */
function isUngroupableMessage(message: ViewMessage): boolean {
  return message.kind === "user" || message.kind === "debug/raw-event";
}

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
): { attempt: number; total: number } | null {
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
  let activeReconnect: { attempt: number; total: number } | null = null;

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

function getSourceSeqRange(messages: ViewMessage[]): {
  sourceSeqStart: number;
  sourceSeqEnd: number;
} {
  const sourceSeqStart = Math.min(...messages.map((message) => message.sourceSeqStart));
  const sourceSeqEnd = Math.max(...messages.map((message) => message.sourceSeqEnd));
  return { sourceSeqStart, sourceSeqEnd };
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

function getToolGroupStatus(messages: ViewMessage[]): TimelineToolGroupRow["status"] {
  return messages.reduce<TimelineToolGroupRow["status"]>(
    (status, message) => mergeStatus(status, getGroupMessageStatus(message)),
    "completed",
  );
}

interface IndexedTurnMessage {
  index: number;
  message: ViewMessage;
}

interface IndexedTurnMessageGroup {
  messages: IndexedTurnMessage[];
  turnId: string;
}

interface CollapsedTurnGroup {
  messages: ViewMessage[];
  turnId: string;
}

function collectMessagesByTurnSegment(messages: ViewMessage[]): IndexedTurnMessageGroup[] {
  const groups: IndexedTurnMessageGroup[] = [];
  const activeGroupsByTurnId = new Map<string, IndexedTurnMessageGroup>();

  for (const [index, message] of messages.entries()) {
    if (message.kind === "user") {
      activeGroupsByTurnId.clear();
      continue;
    }

    const turnId = message.turnId;
    if (!turnId) {
      continue;
    }

    const indexedMessage = { index, message };
    const existing = activeGroupsByTurnId.get(turnId);
    if (existing) {
      existing.messages.push(indexedMessage);
      continue;
    }

    const group: IndexedTurnMessageGroup = {
      messages: [indexedMessage],
      turnId,
    };
    activeGroupsByTurnId.set(turnId, group);
    groups.push(group);
  }

  return groups;
}

function isTerminalMessage(message: ViewMessage): boolean {
  return message.kind === "assistant-text" || message.kind === "error";
}

function findLastTerminalIndex(turnMessages: IndexedTurnMessage[]): number | null {
  for (let i = turnMessages.length - 1; i >= 0; i -= 1) {
    const turnMessage = turnMessages[i];
    if (turnMessage && isTerminalMessage(turnMessage.message)) {
      return turnMessage.index;
    }
  }
  return null;
}

export function buildTimelineRows(
  messages: ViewMessage[],
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  // Timeline guardrail: keep one canonical row per user-visible operation whenever possible.
  // If new lifecycle/outcome events are added, update these collapse passes so thread timelines
  // stay familiar across projections instead of showing near-duplicate status updates.
  const includeToolGroupMessages = options?.includeToolGroupMessages ?? true;
  const collapseAll = options?.collapseAll ?? false;
  const provisioningMergedMessages = mergeProvisioningOperations(messages);
  const threadOperationMergedMessages = mergeThreadOperationMessages(
    provisioningMergedMessages,
  );
  const reconnectMergedMessages = mergeConsecutiveReconnectErrors(
    threadOperationMergedMessages,
  );
  const mergedMessages = mergeConsecutiveToolActivityMessages(reconnectMergedMessages);

  // Group messages by turn. In collapseAll mode, group everything
  // non-ungroupable. Otherwise find the last terminal message (assistant-text
  // or error) and collapse everything before it into one group.
  const collapsedByFirstIndex = new Map<number, CollapsedTurnGroup>();
  const collapsedMessageIndices = new Set<number>();

  for (const { messages: turnMessages, turnId } of collectMessagesByTurnSegment(mergedMessages)) {
    const terminalIndex = collapseAll ? null : findLastTerminalIndex(turnMessages);
    const groupedTurnMessages = turnMessages.filter(({ index, message }) => {
      if (isUngroupableMessage(message)) return false;
      if (collapseAll) return true;
      if (terminalIndex === null) return false;
      return index < terminalIndex;
    });

    if (groupedTurnMessages.length === 0) {
      continue;
    }

    for (const { index } of groupedTurnMessages) {
      collapsedMessageIndices.add(index);
    }

    collapsedByFirstIndex.set(groupedTurnMessages[0]!.index, {
      messages: groupedTurnMessages.map(({ message }) => message),
      turnId,
    });
  }

  // Step 3: Build final row list.
  const rows: TimelineRow[] = [];

  for (const [index, message] of mergedMessages.entries()) {
    const collapseGroup = collapsedByFirstIndex.get(index);

    if (collapseGroup) {
      const mergedGroupMessages = includeToolGroupMessages
        ? mergeConsecutiveToolActivityMessages(collapseGroup.messages)
        : [];
      const { sourceSeqStart, sourceSeqEnd } = getSourceSeqRange(collapseGroup.messages);
      rows.push({
        kind: "tool-group",
        id: `${collapseGroup.turnId}:tool-group:${index}`,
        turnId: collapseGroup.turnId,
        summaryCount: getToolGroupSummaryCount(collapseGroup.messages),
        sourceSeqStart,
        sourceSeqEnd,
        startedAt: Math.min(...collapseGroup.messages.map((message) => getMessageStartedAt(message))),
        createdAt: Math.max(...collapseGroup.messages.map((message) => message.createdAt)),
        durationMs: getGroupDurationMs(collapseGroup.messages),
        status: getToolGroupStatus(collapseGroup.messages),
        messages: mergedGroupMessages,
      });
    }

    if (collapsedMessageIndices.has(index)) {
      continue;
    }

    rows.push({
      kind: "message",
      id: message.id,
      message,
    });
  }

  return rows;
}
