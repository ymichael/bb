import type { UIMessage } from "@beanbag/agent-core";

type CollapsibleTurnMessage = UIMessage;

export interface ThreadDetailMessageRow {
  kind: "message";
  id: string;
  message: UIMessage;
}

export interface ThreadDetailToolGroupRow {
  kind: "tool-group";
  id: string;
  turnId: string;
  summaryCount: number;
  messages: CollapsibleTurnMessage[];
}

export type ThreadDetailRow = ThreadDetailMessageRow | ThreadDetailToolGroupRow;

function isCollapsibleTurnMessage(message: UIMessage): message is CollapsibleTurnMessage {
  return message.kind !== "user";
}

function isToolExploringMessage(
  message: CollapsibleTurnMessage,
): message is Extract<UIMessage, { kind: "tool-exploring" }> {
  return message.kind === "tool-exploring";
}

function mergeToolExploringMessages(
  messages: CollapsibleTurnMessage[],
): CollapsibleTurnMessage[] {
  const merged: CollapsibleTurnMessage[] = [];
  let active: Extract<UIMessage, { kind: "tool-exploring" }> | null = null;

  const flush = () => {
    if (!active) return;
    merged.push(active);
    active = null;
  };

  for (const message of messages) {
    if (!isToolExploringMessage(message)) {
      flush();
      merged.push(message);
      continue;
    }

    if (!active) {
      active = {
        ...message,
        calls: [...message.calls],
      };
      continue;
    }

    if ((active.turnId ?? null) !== (message.turnId ?? null)) {
      flush();
      active = {
        ...message,
        calls: [...message.calls],
      };
      continue;
    }

    active.calls = [...active.calls, ...message.calls];
    active.sourceSeqStart = Math.min(active.sourceSeqStart, message.sourceSeqStart);
    active.sourceSeqEnd = Math.max(active.sourceSeqEnd, message.sourceSeqEnd);
    active.createdAt = Math.max(active.createdAt, message.createdAt);
    if (!active.turnId && message.turnId) {
      active.turnId = message.turnId;
    }
    active.status =
      active.status === "pending" || message.status === "pending"
        ? "pending"
        : "completed";
  }

  flush();
  return merged;
}

function getToolGroupSummaryCount(messages: CollapsibleTurnMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.kind === "tool-exploring") {
      return count + Math.max(1, message.calls.length);
    }
    return count + 1;
  }, 0);
}

export function buildThreadDetailRows(messages: UIMessage[]): ThreadDetailRow[] {
  const mergedMessages = mergeToolExploringMessages(messages);
  const lastAssistantIndexByTurn = new Map<string, number>();

  for (const [index, message] of mergedMessages.entries()) {
    if (!message.turnId) continue;
    if (message.kind !== "assistant-text") continue;
    lastAssistantIndexByTurn.set(message.turnId, index);
  }

  const collapsedByTurn = new Map<
    string,
    {
      firstIndex: number;
      indices: Set<number>;
      messages: CollapsibleTurnMessage[];
    }
  >();

  for (const [index, message] of mergedMessages.entries()) {
    const turnId = message.turnId;
    if (!turnId) continue;

    const lastAssistantIndex = lastAssistantIndexByTurn.get(turnId);
    if (lastAssistantIndex === undefined || index >= lastAssistantIndex) continue;
    if (!isCollapsibleTurnMessage(message)) continue;

    const existing = collapsedByTurn.get(turnId);
    if (!existing) {
      collapsedByTurn.set(turnId, {
        firstIndex: index,
        indices: new Set([index]),
        messages: [message],
      });
      continue;
    }

    existing.firstIndex = Math.min(existing.firstIndex, index);
    existing.indices.add(index);
    existing.messages.push(message);
  }

  const rows: ThreadDetailRow[] = [];

  for (const [index, message] of mergedMessages.entries()) {
    const turnId = message.turnId;
    const collapseGroup = turnId ? collapsedByTurn.get(turnId) : undefined;

    if (turnId && collapseGroup && index === collapseGroup.firstIndex) {
      const mergedGroupMessages = mergeToolExploringMessages(collapseGroup.messages);
      rows.push({
        kind: "tool-group",
        id: `${turnId}:tool-group:${collapseGroup.firstIndex}`,
        turnId,
        summaryCount: getToolGroupSummaryCount(collapseGroup.messages),
        messages: mergedGroupMessages,
      });
    }

    if (turnId && collapseGroup?.indices.has(index)) {
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
