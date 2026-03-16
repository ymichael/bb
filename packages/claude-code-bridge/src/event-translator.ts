import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

export interface TurnCounterState {
  turnCounter: number;
}

export function createTurnCounterState(): TurnCounterState {
  return { turnCounter: 0 };
}

function nextTurnId(state: TurnCounterState): string {
  state.turnCounter += 1;
  return `turn-${state.turnCounter}`;
}

export function translateSdkMessage(
  message: SDKMessage,
  threadId: string,
  currentTurnId: string | undefined,
  counterState: TurnCounterState,
): { notifications: JsonRpcNotification[]; turnId: string | undefined } {
  const notifications: JsonRpcNotification[] = [];
  let turnId = currentTurnId;

  switch (message.type) {
    case "system":
      // Capture session_id only; no notification emitted for system init.
      break;

    case "assistant": {
      if (!turnId) {
        turnId = nextTurnId(counterState);
        notifications.push({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turnId },
        });
      }

      const text = extractAssistantText(message);
      if (text) {
        notifications.push({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { type: "agentMessage", text },
          },
        });
      }

      const toolUses = extractToolUses(message);
      for (const toolUse of toolUses) {
        notifications.push({
          jsonrpc: "2.0",
          method: "item/started",
          params: {
            threadId,
            turnId,
            item: translateToolCallToItem(toolUse.id, toolUse.name, toolUse.input),
          },
        });
      }
      break;
    }

    case "stream_event": {
      const delta = extractStreamTextDelta(message);
      if (delta && turnId) {
        notifications.push({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { threadId, turnId, delta },
        });
      }
      break;
    }

    case "user": {
      const toolResults = extractToolResults(message);
      for (const result of toolResults) {
        notifications.push({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId,
            turnId: turnId ?? "",
            item: translateToolResultToItem(
              result.toolUseId,
              result.toolName,
              result.content,
            ),
          },
        });
      }
      break;
    }

    case "result": {
      const resultMessage = message as SDKResultMessage;
      if (turnId) {
        const tokenUsage = extractTokenUsage(resultMessage);
        if (tokenUsage) {
          notifications.push({
            jsonrpc: "2.0",
            method: "thread/tokenUsage/updated",
            params: {
              threadId,
              turnId,
              tokenUsage,
            },
          });
        }
        notifications.push({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            threadId,
            turnId,
            result: {
              subtype: resultMessage.subtype,
            },
          },
        });
        turnId = undefined;
      }
      break;
    }

    default:
      break;
  }

  return { notifications, turnId };
}

function extractTokenUsage(
  message: SDKResultMessage,
): Record<string, unknown> | undefined {
  const total = toTokenUsageBreakdown(message.usage);
  const modelContextWindow = extractModelContextWindow(message.modelUsage);

  if (!total && modelContextWindow === null) {
    return undefined;
  }

  const emptyBreakdown = createEmptyTokenUsageBreakdown();

  return {
    total: total ?? emptyBreakdown,
    last: total ?? emptyBreakdown,
    modelContextWindow,
  };
}

function toTokenUsageBreakdown(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;

  const inputTokens = toNonNegativeNumber(usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.output_tokens);
  const cacheReadTokens = toNonNegativeNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = toNonNegativeNumber(usage.cache_creation_input_tokens);
  const cachedInputTokens = cacheReadTokens + cacheCreationTokens;
  const totalTokens =
    inputTokens + outputTokens + cachedInputTokens;

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function createEmptyTokenUsageBreakdown(): Record<string, unknown> {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function extractModelContextWindow(
  modelUsage: Record<string, { contextWindow: number }> | undefined,
): number | null {
  if (!modelUsage) return null;

  let largestContextWindow: number | null = null;
  for (const usage of Object.values(modelUsage)) {
    const contextWindow = toPositiveNumber(usage.contextWindow);
    if (contextWindow === null) continue;
    if (largestContextWindow === null || contextWindow > largestContextWindow) {
      largestContextWindow = contextWindow;
    }
  }

  return largestContextWindow;
}

function toNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function toPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function extractAssistantText(
  message: Extract<SDKMessage, { type: "assistant" }>,
): string | undefined {
  const content = (message.message as { content?: unknown })?.content;
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

function extractToolUses(
  message: Extract<SDKMessage, { type: "assistant" }>,
): Array<{ id: string; name: string; input: unknown }> {
  const content = (message.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];

  const uses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (
      typed.type === "tool_use" &&
      typeof typed.id === "string" &&
      typeof typed.name === "string"
    ) {
      uses.push({ id: typed.id, name: typed.name, input: typed.input });
    }
  }
  return uses;
}

function extractStreamTextDelta(
  message: Extract<SDKMessage, { type: "stream_event" }>,
): string | undefined {
  const event = message.event as {
    type?: unknown;
    delta?: { type?: unknown; text?: unknown };
    content_block?: { type?: unknown; text?: unknown };
  } | undefined;

  if (!event) return undefined;

  if (event.type === "content_block_delta") {
    if (
      event.delta?.type === "text_delta" &&
      typeof event.delta.text === "string" &&
      event.delta.text.length > 0
    ) {
      return event.delta.text;
    }
  }

  if (event.type === "content_block_start") {
    if (
      event.content_block?.type === "text" &&
      typeof event.content_block.text === "string" &&
      event.content_block.text.length > 0
    ) {
      return event.content_block.text;
    }
  }

  return undefined;
}

function extractToolResults(
  message: Extract<SDKMessage, { type: "user" }>,
): Array<{ toolUseId: string; toolName?: string; content: unknown }> {
  const results: Array<{ toolUseId: string; toolName?: string; content: unknown }> = [];

  const content = (message.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return results;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as {
      type?: unknown;
      tool_use_id?: unknown;
      tool_name?: unknown;
      content?: unknown;
    };
    if (
      typed.type === "tool_result" &&
      typeof typed.tool_use_id === "string"
    ) {
      results.push({
        toolUseId: typed.tool_use_id,
        toolName: typeof typed.tool_name === "string" ? typed.tool_name : undefined,
        content: typed.content,
      });
    }
  }

  return results;
}

// Well-known tool name sets for semantic translation
const BASH_TOOLS = new Set(["Bash", "bash"]);
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "edit", "write"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch", "WebFetch"]);

function translateToolCallToItem(
  callId: string,
  toolName: string,
  args: unknown,
): Record<string, unknown> {
  const argsRecord =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  if (BASH_TOOLS.has(toolName)) {
    return {
      type: "commandExecution",
      id: callId,
      command: argsRecord.command ?? "",
      cwd: argsRecord.cwd,
      status: "running",
    };
  }

  if (FILE_EDIT_TOOLS.has(toolName)) {
    const filePath =
      (argsRecord.file_path as string | undefined) ??
      (argsRecord.path as string | undefined) ??
      "";
    return {
      type: "filechange",
      id: callId,
      changes: [
        {
          path: filePath,
          kind: { type: "update" },
        },
      ],
    };
  }

  if (WEB_SEARCH_TOOLS.has(toolName)) {
    return {
      type: "webSearch",
      id: callId,
      query: argsRecord.query ?? argsRecord.url ?? "",
    };
  }

  // Generic tool call — use custom_tool_call shape for Codex compatibility
  return {
    type: "custom_tool_call",
    call_id: callId,
    name: toolName,
    input: JSON.stringify(args ?? {}),
  };
}

function translateToolResultToItem(
  callId: string,
  toolName: string | undefined,
  content: unknown,
): Record<string, unknown> {
  const outputText = extractResultText(content);

  if (toolName && BASH_TOOLS.has(toolName)) {
    return {
      type: "commandExecution",
      id: callId,
      aggregatedOutput: outputText,
      exitCode: 0,
      status: "completed",
    };
  }

  if (toolName && FILE_EDIT_TOOLS.has(toolName)) {
    return {
      type: "filechange",
      id: callId,
      stdout: outputText,
      status: "completed",
    };
  }

  if (toolName && WEB_SEARCH_TOOLS.has(toolName)) {
    return {
      type: "webSearch",
      id: callId,
      status: "completed",
    };
  }

  // Generic tool result — custom_tool_call_output shape
  return {
    type: "custom_tool_call_output",
    call_id: callId,
    output: outputText,
  };
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    }
  }
  return chunks.join("\n");
}
