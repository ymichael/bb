#!/usr/bin/env node

import { createInterface } from "node:readline";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SdkSession, type SdkSessionOptions } from "./sdk-session.js";
import {
  translateSdkMessage,
  createTurnCounterState,
  nextTurnId,
  type JsonRpcNotification,
  type TurnCounterState,
} from "./event-translator.js";
import {
  buildBridgeMcpServer,
  getAllowedToolNames,
  BRIDGE_MCP_SERVER_NAME,
  type DynamicToolDefinition,
  type ToolCallForwarder,
} from "./tool-proxy-mcp.js";

export const BRIDGE_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "thread/stop",
] as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingToolCall {
  resolve: (value: { content: string; isError?: boolean }) => void;
}

interface ThreadSession {
  session: SdkSession;
  turnId: string | undefined;
  turnCounter: TurnCounterState;
  pendingToolCalls: Map<string | number, PendingToolCall>;
  providerThreadId?: string;
}

const sessions = new Map<string, ThreadSession>();
let toolCallRequestIdCounter = 0;
const MANAGER_BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "LS",
] as const;

function send(msg: JsonRpcResponse | JsonRpcNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(
  id: string | number,
  code: number,
  message: string,
): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function createOnSdkMessage(threadIdRef: { current: string }): (message: SDKMessage) => void {
  return (message: SDKMessage) => {
    const threadSession = sessions.get(threadIdRef.current);
    if (!threadSession) return;

    const { notifications, turnId } = translateSdkMessage(
      message,
      threadIdRef.current,
      threadSession.turnId,
      threadSession.turnCounter,
    );
    threadSession.turnId = turnId;

    for (const notification of notifications) {
      send(notification);
    }
  };
}

function createOnSdkDone(threadIdRef: { current: string }): (error?: unknown) => void {
  return (error?: unknown) => {
    if (!error) return;

    const threadSession = sessions.get(threadIdRef.current);
    if (!threadSession) return;

    const message =
      error instanceof Error ? error.message : String(error);

    if (threadSession.turnId) {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: threadIdRef.current,
          turnId: threadSession.turnId,
          error: { message },
        },
      });
      threadSession.turnId = undefined;
    } else {
      send({
        jsonrpc: "2.0",
        method: "error",
        params: { threadId: threadIdRef.current, message },
      });
    }
  };
}

function createForwardToolCall(threadIdRef: { current: string }): ToolCallForwarder {
  return (toolName, args) => {
    return new Promise<{ content: string; isError?: boolean }>((resolve) => {
      const threadSession = sessions.get(threadIdRef.current);
      if (!threadSession) {
        resolve({ content: "Thread session not found", isError: true });
        return;
      }
      toolCallRequestIdCounter += 1;
      const requestId = toolCallRequestIdCounter;
      threadSession.pendingToolCalls.set(requestId, { resolve });
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "item/tool/call",
        params: {
          threadId: threadIdRef.current,
          turnId: threadSession.turnId ?? "",
          callId: `call-${requestId}`,
          tool: toolName,
          arguments: args,
        },
      } as unknown as JsonRpcResponse);
    });
  };
}

function findSessionByPendingToolCall(id: string | number): ThreadSession | undefined {
  for (const session of sessions.values()) {
    if (session.pendingToolCalls.has(id)) return session;
  }
  return undefined;
}

function extractEnvOverrides(params: Record<string, unknown>): Record<string, string> {
  const envOverrides: Record<string, string> = {};
  const config = params.config as Record<string, unknown> | undefined;
  if (config) {
    for (const [key, value] of Object.entries(config)) {
      if (
        key.startsWith("shell_environment_policy.set.") &&
        typeof value === "string"
      ) {
        const envVar = key.slice("shell_environment_policy.set.".length);
        envOverrides[envVar] = value;
      }
    }
  }
  return envOverrides;
}

function buildSessionEnv(envOverrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...envOverrides,
    CLAUDE_AGENT_SDK_CLIENT_APP: "bb/1.0.0",
  };
}

export function buildSessionOptions(
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): SdkSessionOptions {
  const systemPrompt =
    typeof params.baseInstructions === "string"
      ? params.baseInstructions
      : "You are a helpful coding assistant.";
  const model =
    typeof params.model === "string" ? params.model : undefined;
  const cwd =
    typeof params.cwd === "string" ? params.cwd : process.cwd();
  const managerMode = params.managerMode === true;

  return {
    cwd,
    systemPrompt,
    model,
    env,
    ...(managerMode ? { tools: [...MANAGER_BUILTIN_TOOLS] } : {}),
  };
}

function applyDynamicTools(
  sessionOptions: SdkSessionOptions,
  params: Record<string, unknown>,
  threadIdRef: { current: string },
): void {
  const dynamicTools = params.dynamicTools as
    | DynamicToolDefinition[]
    | undefined;
  if (dynamicTools && dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(dynamicTools, createForwardToolCall(threadIdRef));
    sessionOptions.mcpServers = {
      [BRIDGE_MCP_SERVER_NAME]: mcpServer,
    };
    sessionOptions.allowedTools = getAllowedToolNames(dynamicTools);
  }
}

function handleRequest(request: JsonRpcRequest): void {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      sendResult(id, { ok: true });
      break;

    case "thread/start":
      handleThreadStart(id, params ?? {});
      break;

    case "thread/resume":
      handleThreadResume(id, params ?? {});
      break;

    case "turn/start":
      handleTurnStart(id, params ?? {});
      break;

    case "turn/steer":
      handleTurnSteer(id, params ?? {});
      break;

    case "thread/stop":
      handleThreadStop(id, params ?? {});
      break;

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function handleThreadStart(
  id: string | number,
  params: Record<string, unknown>,
): void {
  const routingThreadId =
    typeof params.threadId === "string" ? params.threadId : undefined;
  if (!routingThreadId) {
    sendError(id, -32602, "Missing threadId");
    return;
  }
  const threadIdRef = { current: routingThreadId };

  // Stop existing session for this thread if any
  const existing = sessions.get(threadIdRef.current);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadIdRef.current);
  }

  const envOverrides = extractEnvOverrides(params);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  applyDynamicTools(sessionOptions, params, threadIdRef);

  const turnCounter = createTurnCounterState();
  const session = new SdkSession(sessionOptions, createOnSdkMessage(threadIdRef), createOnSdkDone(threadIdRef));
  session.start();

  const threadSession: ThreadSession = {
    session,
    turnId: undefined,
    turnCounter,
    pendingToolCalls: new Map(),
  };
  sessions.set(threadIdRef.current, threadSession);

  const input = extractInputText(params.input);
  if (input) {
    session.pushInput(input);
  }

  // Return a temporary ID immediately. Once the SDK session ID is
  // captured, re-key the session map and update the threadIdRef so
  // subsequent events carry the real SDK session ID. The orchestrator
  // picks up the real ID from persisted event data (same field it
  // uses for Codex's conversationId).
  sendResult(id, { threadId: threadIdRef.current, providerThreadId: null });

  void session.waitForSessionId().then((sdkSessionId) => {
    threadSession.providerThreadId = sdkSessionId;
    send({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        threadId: threadIdRef.current,
        providerThreadId: sdkSessionId,
      },
    });
  });
}

function handleThreadResume(
  id: string | number,
  params: Record<string, unknown>,
): void {
  const threadId =
    typeof params.threadId === "string"
      ? params.threadId
      : undefined;
  if (!threadId) {
    sendError(id, -32602, "Missing threadId");
    return;
  }
  const providerThreadId =
    typeof params.providerThreadId === "string"
      ? params.providerThreadId
      : undefined;

  // Stop existing session for this thread if any
  const existing = sessions.get(threadId);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadId);
  }

  const envOverrides = extractEnvOverrides(params);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  const threadIdRef = { current: threadId };
  applyDynamicTools(sessionOptions, params, threadIdRef);
  const turnCounter = createTurnCounterState();
  const session = new SdkSession(sessionOptions, createOnSdkMessage(threadIdRef), createOnSdkDone(threadIdRef));

  session.start(providerThreadId);

  const threadSession: ThreadSession = {
    session,
    turnId: undefined,
    turnCounter,
    pendingToolCalls: new Map(),
    ...(providerThreadId ? { providerThreadId } : {}),
  };
  sessions.set(threadId, threadSession);

  sendResult(id, { threadId, providerThreadId: providerThreadId ?? null });
}

function handleTurnStart(
  id: string | number,
  params: Record<string, unknown>,
): void {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const threadSession = threadId ? sessions.get(threadId) : undefined;
  if (!threadSession) {
    sendError(id, -32000, "No active session");
    return;
  }

  const input = extractInputText(params.input);
  if (!input) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  threadSession.session.pushInput(input);
  sendResult(id, { threadId });
}

function handleTurnSteer(
  id: string | number,
  params: Record<string, unknown>,
): void {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const threadSession = threadId ? sessions.get(threadId) : undefined;
  if (!threadSession) {
    sendError(id, -32000, "No active session");
    return;
  }

  const input = extractInputText(params.input);
  if (!input) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  threadSession.session.pushInput(input);
  sendResult(id, { threadId });
}

function handleThreadStop(
  id: string | number,
  params: Record<string, unknown>,
): void {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (threadId) {
    const threadSession = sessions.get(threadId);
    if (threadSession) {
      threadSession.session.stop();
      sessions.delete(threadId);
    }
  }
  sendResult(id, { ok: true });
}

function extractInputText(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return undefined;

  const chunks: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const typed = item as { type?: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    }
  }

  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const request = parsed as JsonRpcRequest;
  if (!request || typeof request !== "object" || request.jsonrpc !== "2.0") {
    return;
  }

  // Handle tool call responses (they come back as JSON-RPC responses or errors)
  if (("result" in request || "error" in request) && findSessionByPendingToolCall(request.id)) {
    const threadSession = findSessionByPendingToolCall(request.id)!;
    const pending = threadSession.pendingToolCalls.get(request.id)!;
    threadSession.pendingToolCalls.delete(request.id);
    if ("error" in request) {
      const error = (request as unknown as { error: { message?: string } }).error;
      pending.resolve({ content: error?.message ?? "Tool call failed", isError: true });
    } else {
      const result = (request as unknown as { result: unknown }).result;
      const record = result as Record<string, unknown> | undefined;
      const contentItems = record?.contentItems as
        | Array<{ type: string; text?: string }>
        | undefined;
      const text =
        contentItems
          ?.filter((item) => item.type === "inputText" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n") ?? "OK";
      pending.resolve({
        content: text,
        isError: (record?.success as boolean | undefined) === false,
      });
    }
    return;
  }

  if (typeof request.method !== "string") return;
  handleRequest(request);
}

// Main entry point
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", handleLine);
rl.on("close", () => {
  for (const threadSession of sessions.values()) {
    threadSession.session.stop();
  }
  sessions.clear();
  process.exit(0);
});
