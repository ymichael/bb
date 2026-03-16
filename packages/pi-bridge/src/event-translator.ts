export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

let turnCounter = 0;

function nextTurnId(): string {
  turnCounter += 1;
  return `turn-${turnCounter}`;
}

export function resetTurnCounter(): void {
  turnCounter = 0;
}

export function translatePiEvent(
  event: Record<string, unknown>,
  threadId: string,
  currentTurnId: string | undefined,
): { notifications: JsonRpcNotification[]; turnId: string | undefined } {
  const notifications: JsonRpcNotification[] = [];
  let turnId = currentTurnId;
  const eventType = event.type as string;

  switch (eventType) {
    case "agent_start":
      if (!turnId) {
        turnId = nextTurnId();
        notifications.push({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turnId },
        });
      }
      break;

    case "agent_end": {
      const messages = event.messages as Array<Record<string, unknown>> | undefined;
      const lastAssistant = messages
        ?.filter((m) => m.role === "assistant")
        .pop();
      if (lastAssistant) {
        const text = extractAssistantText(lastAssistant);
        if (text) {
          notifications.push({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              threadId,
              turnId: turnId ?? "",
              item: { normalizedType: "agentmessage", text: { text } },
            },
          });
        }
      }
      if (turnId) {
        notifications.push({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId, turnId },
        });
        turnId = undefined;
      }
      break;
    }

    case "message_update": {
      const assistantEvent = event.assistantMessageEvent as
        | Record<string, unknown>
        | undefined;
      if (assistantEvent?.type === "text_delta" && turnId) {
        const delta = assistantEvent.delta as string | undefined;
        if (delta) {
          notifications.push({
            jsonrpc: "2.0",
            method: "item/agentMessage/delta",
            params: { threadId, turnId, delta },
          });
        }
      }
      break;
    }

    case "tool_execution_start": {
      if (turnId) {
        notifications.push({
          jsonrpc: "2.0",
          method: "item/started",
          params: {
            threadId,
            turnId,
            item: {
              normalizedType: "toolcall",
              callId: event.toolCallId as string,
              tool: event.toolName as string,
              arguments: event.args,
            },
          },
        });
      }
      break;
    }

    case "tool_execution_end": {
      if (turnId) {
        notifications.push({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId,
            turnId: turnId,
            item: {
              normalizedType: "toolresult",
              callId: event.toolCallId as string,
              tool: event.toolName as string,
              output: event.result,
              isError: event.isError ?? false,
            },
          },
        });
      }
      break;
    }

    default:
      break;
  }

  return { notifications, turnId };
}

function extractAssistantText(
  message: Record<string, unknown>,
): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) return undefined;

  const chunks: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      chunks.push((block as { text: string }).text);
    }
  }

  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
}
