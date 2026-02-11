import type { UIMessage } from "@beanbag/core";

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
  messages: CollapsibleTurnMessage[];
}

export type ThreadDetailRow = ThreadDetailMessageRow | ThreadDetailToolGroupRow;

function isCollapsibleTurnMessage(message: UIMessage): message is CollapsibleTurnMessage {
  return message.kind !== "user";
}

export function buildThreadDetailRows(messages: UIMessage[]): ThreadDetailRow[] {
  const lastAssistantIndexByTurn = new Map<string, number>();

  for (const [index, message] of messages.entries()) {
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

  for (const [index, message] of messages.entries()) {
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

  for (const [index, message] of messages.entries()) {
    const turnId = message.turnId;
    const collapseGroup = turnId ? collapsedByTurn.get(turnId) : undefined;

    if (turnId && collapseGroup && index === collapseGroup.firstIndex) {
      rows.push({
        kind: "tool-group",
        id: `${turnId}:tool-group:${collapseGroup.firstIndex}`,
        turnId,
        messages: collapseGroup.messages,
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
