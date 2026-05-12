import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = number | string;

interface ActiveTurn {
  timer: NodeJS.Timeout | null;
  turnId: string;
}

interface PendingToolCall {
  delayMs: number;
  responseText: string;
  threadId: string;
}

type ToolTurnIdMode = "active" | "unresolved";

interface ThreadState {
  activeTurn: ActiveTurn | null;
  providerThreadId: string;
  turnCount: number;
  userMessageCount: number;
}

interface TurnPlan {
  delayMs: number;
  responseText: string;
  toolName: string | null;
  toolTurnIdMode: ToolTurnIdMode;
}

const rl = createInterface({ input: process.stdin });

const threads = new Map<string, ThreadState>();
const pendingToolCalls = new Map<JsonRpcId, PendingToolCall>();

let nextProviderThreadId = 1;
let nextToolCallId = 1;
const defaultModelList = [
  {
    id: "fake-model",
    model: "fake-model",
    displayName: "Fake Model",
    description: "Fake model for integration and runtime tests",
    supportedReasoningEfforts: [
      {
        reasoningEffort: "medium",
        description: "Medium",
      },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
];

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function getJsonRpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function getParams(message: JsonRecord): JsonRecord {
  return isJsonRecord(message.params) ? message.params : {};
}

function send(message: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function getThreadState(threadId: string): ThreadState | null {
  const thread = threads.get(threadId);
  if (!thread) {
    return null;
  }
  return thread;
}

function parseInputText(input: unknown): string {
  if (!Array.isArray(input)) {
    return "";
  }

  return input
    .filter((item) => isJsonRecord(item))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join(" ");
}

function parseUserContent(input: unknown): JsonRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const content: JsonRecord[] = [];
  for (const item of input) {
    if (!isJsonRecord(item)) {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    }
    if (item.type === "image" && typeof item.url === "string") {
      content.push({ type: "image", url: item.url });
    }
    if (item.type === "localImage" && typeof item.path === "string") {
      content.push({ type: "localImage", path: item.path });
    }
    if (item.type === "localFile" && typeof item.path === "string") {
      content.push({ type: "localFile", path: item.path });
    }
  }
  return content;
}

function parseTurnPlan(inputText: string): TurnPlan {
  const delayMatch = /(?:^|\s)delay:(\d+)(?:\s|$)/.exec(inputText);
  const unresolvedToolMatch =
    /(?:^|\s)call_tool_unresolved:([^\s]+)(?:\s|$)/.exec(inputText);
  const toolMatch =
    unresolvedToolMatch ?? /(?:^|\s)call_tool:([^\s]+)(?:\s|$)/.exec(inputText);

  let delayMs = delayMatch ? Number(delayMatch[1]) : 0;
  let toolName = toolMatch ? toolMatch[1] : null;
  const toolTurnIdMode = unresolvedToolMatch ? "unresolved" : "active";

  if (toolName && /^delay:\d+$/u.test(toolName)) {
    delayMs = Number(toolName.slice("delay:".length));
    toolName = null;
  }

  return {
    delayMs,
    responseText: inputText ? `Response to: ${inputText}` : "Response complete",
    toolName,
    toolTurnIdMode,
  };
}

function buildToolArguments(toolName: string): JsonRecord {
  if (toolName === "message_user") {
    return { text: "Fake provider message" };
  }
  return {};
}

function clearActiveTurn(thread: ThreadState): void {
  if (!thread.activeTurn) {
    return;
  }
  if (thread.activeTurn.timer) {
    clearTimeout(thread.activeTurn.timer);
  }
  thread.activeTurn = null;
}

function emitUserMessage(
  threadId: string,
  turnId: string,
  input: unknown,
): void {
  const thread = getThreadState(threadId);
  if (!thread) {
    return;
  }
  const content = parseUserContent(input);
  if (content.length === 0) {
    return;
  }
  thread.userMessageCount += 1;
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId,
      turnId,
      providerThreadId: thread.providerThreadId,
      item: {
        type: "userMessage",
        id: `user-${thread.userMessageCount}`,
        content,
      },
    },
  });
}

function completeTurn(
  threadId: string,
  status: string,
  responseText: string,
): void {
  const thread = getThreadState(threadId);
  if (!thread || !thread.activeTurn) {
    return;
  }

  const turn = thread.activeTurn;
  clearActiveTurn(thread);

  if (status === "completed") {
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId: turn.turnId,
        item: {
          type: "agentMessage",
          id: `msg-${thread.turnCount}`,
          text: responseText,
        },
      },
    });
  }

  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId,
      turnId: turn.turnId,
      providerThreadId: thread.providerThreadId,
      status,
    },
  });
}

function scheduleTurnCompletion(
  threadId: string,
  responseText: string,
  delayMs: number,
): void {
  const thread = getThreadState(threadId);
  if (!thread || !thread.activeTurn) {
    return;
  }

  thread.activeTurn.timer = setTimeout(() => {
    completeTurn(threadId, "completed", responseText);
  }, delayMs);
}

function beginTurn(threadId: string, input: unknown): void {
  const thread = getThreadState(threadId);
  if (!thread) {
    return;
  }

  clearActiveTurn(thread);
  thread.turnCount += 1;

  const turnId = `turn-${thread.turnCount}`;
  const inputText = parseInputText(input);
  const plan = parseTurnPlan(inputText);

  thread.activeTurn = {
    turnId,
    timer: null,
  };

  send({
    jsonrpc: "2.0",
    method: "turn/started",
    params: {
      threadId,
      turnId,
      providerThreadId: thread.providerThreadId,
    },
  });
  emitUserMessage(threadId, turnId, input);

  if (plan.toolName) {
    const toolCallId = nextToolCallId++;
    const params: JsonRecord = {
      providerThreadId: thread.providerThreadId,
      callId: `call-${toolCallId}`,
      tool: plan.toolName,
      arguments: buildToolArguments(plan.toolName),
    };
    params.turnId = plan.toolTurnIdMode === "active" ? turnId : null;
    pendingToolCalls.set(toolCallId, {
      delayMs: plan.delayMs,
      responseText: `Tool called: ${plan.toolName}`,
      threadId,
    });
    send({
      jsonrpc: "2.0",
      id: toolCallId,
      method: "item/tool/call",
      params,
    });
    return;
  }

  scheduleTurnCompletion(threadId, plan.responseText, plan.delayMs);
}

function startTurn(message: JsonRecord): void {
  const params = getParams(message);
  const threadId = getString(params.threadId, "unknown");
  const thread = getThreadState(threadId);
  if (!thread) {
    send({
      jsonrpc: "2.0",
      id: getJsonRpcId(message.id) ?? 0,
      error: { code: -32000, message: `Unknown thread: ${threadId}` },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: getJsonRpcId(message.id) ?? 0,
    result: { ok: true },
  });
  beginTurn(threadId, params.input);
}

function startOrResumeThread(
  message: JsonRecord,
  mode: "resume" | "start",
): void {
  const params = getParams(message);
  const threadId = getString(params.threadId, "unknown");
  const providerThreadId =
    mode === "resume"
      ? getString(params.providerThreadId) ||
        `resumed-${nextProviderThreadId++}`
      : `prov-${nextProviderThreadId++}`;

  threads.set(threadId, {
    activeTurn: null,
    providerThreadId,
    turnCount: 0,
    userMessageCount: 0,
  });

  send({
    jsonrpc: "2.0",
    id: getJsonRpcId(message.id) ?? 0,
    result: { providerThreadId },
  });

  if (mode === "start") {
    send({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: { threadId, providerThreadId },
    });
    if (Array.isArray(params.input) && params.input.length > 0) {
      beginTurn(threadId, params.input);
    }
  }
}

function handleToolResult(message: JsonRecord): boolean {
  const messageId = getJsonRpcId(message.id);
  if (messageId === undefined || typeof message.method === "string") {
    return false;
  }

  const pendingToolCall = pendingToolCalls.get(messageId);
  if (!pendingToolCall) {
    return false;
  }

  pendingToolCalls.delete(messageId);
  scheduleTurnCompletion(
    pendingToolCall.threadId,
    pendingToolCall.responseText,
    pendingToolCall.delayMs,
  );
  return true;
}

function handleMessage(message: JsonRecord): void {
  if (handleToolResult(message)) {
    return;
  }

  const method = getString(message.method);
  if (!method) {
    return;
  }

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: getJsonRpcId(message.id) ?? 0,
      result: { ok: true },
    });
    return;
  }

  if (method === "model/list") {
    send({
      jsonrpc: "2.0",
      id: getJsonRpcId(message.id) ?? 0,
      result: defaultModelList,
    });
    return;
  }

  if (method === "thread/start") {
    startOrResumeThread(message, "start");
    return;
  }

  if (method === "thread/resume") {
    startOrResumeThread(message, "resume");
    return;
  }

  if (method === "turn/start") {
    startTurn(message);
    return;
  }

  if (method === "turn/steer") {
    const params = getParams(message);
    const threadId = getString(params.threadId, "unknown");
    const thread = getThreadState(threadId);
    if (thread?.activeTurn) {
      emitUserMessage(threadId, thread.activeTurn.turnId, params.input);
    }
    send({
      jsonrpc: "2.0",
      id: getJsonRpcId(message.id) ?? 0,
      result: { ok: true },
    });
    return;
  }

  if (method === "thread/stop") {
    const params = getParams(message);
    const threadId = getString(params.threadId, "unknown");
    const thread = getThreadState(threadId);
    if (thread && thread.activeTurn) {
      completeTurn(threadId, "interrupted", "Interrupted");
    }
    send({
      jsonrpc: "2.0",
      id: getJsonRpcId(message.id) ?? 0,
      result: { ok: true },
    });
    return;
  }

  if (method === "thread/name/set") {
    const params = getParams(message);
    const threadId = getString(params.threadId, "unknown");
    const thread = getThreadState(threadId);
    send({
      jsonrpc: "2.0",
      id: getJsonRpcId(message.id) ?? 0,
      result: { ok: true },
    });
    if (thread) {
      send({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: {
          threadId,
          providerThreadId: thread.providerThreadId,
          threadName: getString(params.title),
        },
      });
    }
    return;
  }

  if (getJsonRpcId(message.id) !== undefined) {
    send({
      jsonrpc: "2.0",
      id: getJsonRpcId(message.id) ?? 0,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

rl.on("line", (line) => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isJsonRecord(parsed)) {
      handleMessage(parsed);
    }
  } catch {
    return;
  }
});
