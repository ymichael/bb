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

type CollapsibleTurnMessage = ViewMessage;

export interface BuildThreadDetailRowsOptions {
  includeToolGroupMessages?: boolean;
}

export type BuildTimelineRowsOptions = BuildThreadDetailRowsOptions;

function isCollapsibleTurnMessage(message: ViewMessage): message is CollapsibleTurnMessage {
  if (
    message.kind === "operation" &&
    (message.opType === "compaction" || message.opType === "thread-title-updated")
  ) {
    return false;
  }
  if (message.kind === "user" || message.kind === "assistant-text") {
    return false;
  }
  return true;
}

function isToolExploringMessage(
  message: CollapsibleTurnMessage,
): message is Extract<ViewMessage, { kind: "tool-exploring" }> {
  return message.kind === "tool-exploring";
}

function isFileEditMessage(
  message: CollapsibleTurnMessage,
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
  messages: CollapsibleTurnMessage[],
): CollapsibleTurnMessage[] {
  const merged: CollapsibleTurnMessage[] = [];
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

function getToolGroupSummaryCount(messages: CollapsibleTurnMessage[]): number {
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

function getSourceSeqRange(messages: CollapsibleTurnMessage[]): {
  sourceSeqStart: number;
  sourceSeqEnd: number;
} {
  const sourceSeqStart = Math.min(...messages.map((message) => message.sourceSeqStart));
  const sourceSeqEnd = Math.max(...messages.map((message) => message.sourceSeqEnd));
  return { sourceSeqStart, sourceSeqEnd };
}

function getCollapsibleTurnMessageStatus(
  message: CollapsibleTurnMessage,
): TimelineToolGroupRow["status"] {
  switch (message.kind) {
    case "user":
      return "completed";
    case "assistant-reasoning":
    case "assistant-text":
      return "completed";
    case "tool-exploring":
    case "tool-call":
    case "web-search":
    case "file-edit":
      return message.status;
    case "operation":
      return message.status ?? "completed";
    case "error":
      return "error";
    case "debug/raw-event":
      return "completed";
    default:
      return assertNever(message);
  }
}

function getToolGroupStatus(messages: CollapsibleTurnMessage[]): TimelineToolGroupRow["status"] {
  return messages.reduce<TimelineToolGroupRow["status"]>(
    (status, message) => mergeStatus(status, getCollapsibleTurnMessageStatus(message)),
    "completed",
  );
}

export function buildThreadDetailRows(
  messages: ViewMessage[],
  options?: BuildThreadDetailRowsOptions,
): TimelineRow[] {
  // Timeline guardrail: keep one canonical row per user-visible operation whenever possible.
  // If new lifecycle/outcome events are added, update these collapse passes so thread timelines
  // stay familiar across projections instead of showing near-duplicate status updates.
  const includeToolGroupMessages = options?.includeToolGroupMessages ?? true;
  const provisioningMergedMessages = mergeProvisioningOperations(messages);
  const threadOperationMergedMessages = mergeThreadOperationMessages(
    provisioningMergedMessages,
  );
  const reconnectMergedMessages = mergeConsecutiveReconnectErrors(
    threadOperationMergedMessages,
  );
  const mergedMessages = mergeConsecutiveToolActivityMessages(reconnectMergedMessages);
  const lastAssistantIndexByTurn = new Map<string, number>();

  for (const [index, message] of mergedMessages.entries()) {
    if (!message.turnId) continue;
    if (message.kind !== "assistant-text") continue;
    lastAssistantIndexByTurn.set(message.turnId, index);
  }

  const collapsedByFirstIndex = new Map<
    number,
    {
      indices: Set<number>;
      messages: CollapsibleTurnMessage[];
      turnId: string;
    }
  >();
  const collapsedMessageIndices = new Set<number>();

  for (let index = 0; index < mergedMessages.length; index += 1) {
    const message = mergedMessages[index];
    const turnId = message?.turnId;
    if (!turnId) continue;

    const lastAssistantIndex = lastAssistantIndexByTurn.get(turnId);
    if (lastAssistantIndex === undefined || index >= lastAssistantIndex) continue;
    if (!isCollapsibleTurnMessage(message)) continue;

    const previousMessage = index > 0 ? mergedMessages[index - 1] : undefined;
    const continuesPriorGroup =
      previousMessage?.turnId === turnId && isCollapsibleTurnMessage(previousMessage);
    if (continuesPriorGroup) {
      continue;
    }

    const indices = new Set<number>();
    const messages: CollapsibleTurnMessage[] = [];
    let scanIndex = index;
    while (scanIndex < mergedMessages.length) {
      const candidate = mergedMessages[scanIndex];
      if (
        !candidate ||
        candidate.turnId !== turnId ||
        !isCollapsibleTurnMessage(candidate) ||
        scanIndex >= lastAssistantIndex
      ) {
        break;
      }
      indices.add(scanIndex);
      collapsedMessageIndices.add(scanIndex);
      messages.push(candidate);
      scanIndex += 1;
    }

    collapsedByFirstIndex.set(index, {
      indices,
      messages,
      turnId,
    });
  }

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

export function buildTimelineRows(
  messages: ViewMessage[],
  options?: BuildTimelineRowsOptions,
): TimelineRow[] {
  return buildThreadDetailRows(messages, options);
}
