#!/usr/bin/env node

/**
 * Claude Code bridge process.
 *
 * Thin JSON-RPC shell that manages Claude Agent SDK sessions and forwards
 * raw `SDKMessage` events to the parent process. The parent (host-daemon)
 * passes these to the adapter's `translateEvent` for conversion to
 * `ThreadEvent[]`.
 *
 * The bridge does NOT translate events — it only:
 * - Manages SDK session lifecycle (start, resume, stop, push input)
 * - Forwards raw SDK messages as `{ method: "sdk/message", params: { threadId, message } }`
 * - Forwards tool call requests to the parent and feeds responses back to the SDK
 * - Emits `thread/identity` when the SDK session ID is captured
 */

import { createInterface } from "node:readline";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  jsonRpcEnvelopeSchema,
  type BridgeToolCallRequest,
} from "../../shared/bridge-tool-calls.js";
import { SdkSession, type SdkSessionOptions } from "./sdk-session.js";
import {
  buildBridgeMcpServer,
  getAllowedToolNames,
  BRIDGE_MCP_SERVER_NAME,
  type ToolCallForwarder,
} from "./tool-proxy-mcp.js";

// ---------------------------------------------------------------------------
// Command schema — defines what JSON-RPC requests this bridge accepts
// ---------------------------------------------------------------------------

const claudeCodeCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: z.object({
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }),
  }),
  z.object({
    method: z.literal("thread/start"),
    params: z.object({
      threadId: z.string(),
      baseInstructions: z.string(),
      config: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      managerMode: z.boolean().optional(),
      dynamicTools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.unknown(),
      })).optional(),
    }),
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      baseInstructions: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      dynamicTools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.unknown(),
      })).optional(),
    }),
  }),
  z.object({
    method: z.literal("turn/start"),
    params: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      input: z.array(z.unknown()),
      model: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    method: z.literal("turn/steer"),
    params: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      expectedTurnId: z.string(),
      input: z.array(z.unknown()),
    }),
  }),
  z.object({
    method: z.literal("thread/stop"),
    params: z.object({
      threadId: z.string(),
    }),
  }),
]);

export type ClaudeCodeCommand = z.infer<typeof claudeCodeCommandSchema>;

function decodeClaudeCodeJsonRpcRequest(raw: unknown): (ClaudeCodeCommand & { jsonrpc: "2.0"; id: string | number }) | null {
  const envelope = jsonRpcEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;

  const command = claudeCodeCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (!command.success) return null;

  return { ...command.data, jsonrpc: "2.0", id: envelope.data.id };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC notification carrying a raw SDK message. */
interface SdkMessageNotification {
  jsonrpc: "2.0";
  method: "sdk/message";
  params: { threadId: string; message: SDKMessage };
}

/** JSON-RPC notification for bridge-originated events. */
interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface PendingToolCall {
  resolve: (value: { content: string; isError?: boolean }) => void;
}

interface ThreadSession {
  session: SdkSession;
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

function send(msg: JsonRpcResponse | SdkMessageNotification | BridgeEventNotification | BridgeToolCallRequest): void {
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

function sendSdkMessage(threadId: string, message: SDKMessage): void {
  send({
    jsonrpc: "2.0",
    method: "sdk/message",
    params: { threadId, message },
  });
}

function createOnSdkMessage(threadIdRef: { current: string }): (message: SDKMessage) => void {
  return (message: SDKMessage) => {
    if (!sessions.has(threadIdRef.current)) return;
    sendSdkMessage(threadIdRef.current, message);
  };
}

function createOnSdkDone(threadIdRef: { current: string }): (error?: unknown) => void {
  return (error?: unknown) => {
    if (!error) return;
    if (!sessions.has(threadIdRef.current)) return;

    const message =
      error instanceof Error ? error.message : String(error);

    send({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: threadIdRef.current, message },
    });
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
          turnId: "",
          callId: `call-${requestId}`,
          tool: toolName,
          arguments: args,
        },
      });
    });
  };
}

function findSessionByPendingToolCall(id: string | number): ThreadSession | undefined {
  for (const session of sessions.values()) {
    if (session.pendingToolCalls.has(id)) return session;
  }
  return undefined;
}

function extractEnvOverrides(config: Record<string, unknown> | undefined): Record<string, string> {
  const envOverrides: Record<string, string> = {};
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
  params: { baseInstructions?: string; model?: string; managerMode?: boolean },
  env: NodeJS.ProcessEnv,
): SdkSessionOptions {
  const systemPrompt = params.baseInstructions ?? "You are a helpful coding assistant.";
  const model = params.model;
  const cwd = process.cwd();
  const managerMode = params.managerMode === true;

  return {
    cwd,
    systemPrompt,
    model,
    env,
    ...(managerMode ? { tools: [...MANAGER_BUILTIN_TOOLS] } : {}),
  };
}

function handleRequest(request: ClaudeCodeCommand & { id: string | number }): void {
  switch (request.method) {
    case "initialize":
      sendResult(request.id, { ok: true });
      break;
    case "thread/start":
      handleThreadStart(request.id, request.params);
      break;
    case "thread/resume":
      handleThreadResume(request.id, request.params);
      break;
    case "turn/start":
      handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      handleThreadStop(request.id, request.params);
      break;
  }
}

type ThreadStartParams = Extract<ClaudeCodeCommand, { method: "thread/start" }>["params"];
type ThreadResumeParams = Extract<ClaudeCodeCommand, { method: "thread/resume" }>["params"];
type TurnStartParams = Extract<ClaudeCodeCommand, { method: "turn/start" }>["params"];
type TurnSteerParams = Extract<ClaudeCodeCommand, { method: "turn/steer" }>["params"];
type ThreadStopParams = Extract<ClaudeCodeCommand, { method: "thread/stop" }>["params"];

function handleThreadStart(
  id: string | number,
  params: ThreadStartParams,
): void {
  const threadIdRef = { current: params.threadId };

  const existing = sessions.get(threadIdRef.current);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadIdRef.current);
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(threadIdRef),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }

  const session = new SdkSession(sessionOptions, createOnSdkMessage(threadIdRef), createOnSdkDone(threadIdRef));
  session.start();

  const threadSession: ThreadSession = {
    session,
    pendingToolCalls: new Map(),
  };
  sessions.set(threadIdRef.current, threadSession);

  sendResult(id, { threadId: threadIdRef.current, providerThreadId: null });

  void session.waitForSessionId().then((sdkSessionId) => {
    threadSession.providerThreadId = sdkSessionId;
    send({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: {
        threadId: threadIdRef.current,
        providerThreadId: sdkSessionId,
      },
    });
  });
}

function handleThreadResume(
  id: string | number,
  params: ThreadResumeParams,
): void {
  const threadId = params.threadId;
  const providerThreadId = params.providerThreadId ?? undefined;

  const existing = sessions.get(threadId);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadId);
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  const threadIdRef = { current: threadId };
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(threadIdRef),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }
  const session = new SdkSession(sessionOptions, createOnSdkMessage(threadIdRef), createOnSdkDone(threadIdRef));

  session.start(providerThreadId);

  const threadSession: ThreadSession = {
    session,
    pendingToolCalls: new Map(),
    ...(providerThreadId ? { providerThreadId } : {}),
  };
  sessions.set(threadId, threadSession);

  sendResult(id, { threadId, providerThreadId: providerThreadId ?? null });
}

function handleTurnStart(
  id: string | number,
  params: TurnStartParams,
): void {
  const threadSession = sessions.get(params.threadId);
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
  sendResult(id, { threadId: params.threadId });
}

function handleTurnSteer(
  id: string | number,
  params: TurnSteerParams,
): void {
  const threadSession = sessions.get(params.threadId);
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
  sendResult(id, { threadId: params.threadId });
}

function handleThreadStop(
  id: string | number,
  params: ThreadStopParams,
): void {
  const threadSession = sessions.get(params.threadId);
  if (threadSession) {
    threadSession.session.stop();
    sessions.delete(params.threadId);
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

  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response && findSessionByPendingToolCall(response.id)) {
    const threadSession = findSessionByPendingToolCall(response.id)!;
    const pending = threadSession.pendingToolCalls.get(response.id)!;
    threadSession.pendingToolCalls.delete(response.id);
    if ("error" in response) {
      pending.resolve({
        content: response.error.message ?? "Tool call failed",
        isError: true,
      });
    } else {
      pending.resolve(decodeToolCallResponsePayload(response.result));
    }
    return;
  }

  const request = decodeClaudeCodeJsonRpcRequest(parsed);
  if (!request) return;
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
