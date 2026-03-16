#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createInterface } from "node:readline";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import { PiSdkSession, type PiSdkSessionOptions } from "./sdk-session.js";
import {
  translatePiEvent,
  createTurnCounterState,
  type JsonRpcNotification,
  type TurnCounterState,
} from "./event-translator.js";
import {
  buildDynamicTools,
  type DynamicToolDefinition,
  type ToolCallForwarder,
} from "./tool-proxy.js";

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
  error?: { code: number; message: string };
}

interface PendingToolCall {
  resolve: (value: { content: string; isError?: boolean }) => void;
}

interface ThreadSession {
  session: PiSdkSession;
  turnId: string | undefined;
  turnCounter: TurnCounterState;
  pendingToolCalls: Map<string | number, PendingToolCall>;
}

const sessions = new Map<string, ThreadSession>();
let toolCallRequestIdCounter = 0;

function send(msg: JsonRpcResponse | JsonRpcNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function createOnPiEvent(threadId: string): (event: AgentSessionEvent) => void {
  return (event: AgentSessionEvent) => {
    const threadSession = sessions.get(threadId);
    if (!threadSession) return;

    // Convert AgentSessionEvent to the Record<string, unknown> shape
    // that translatePiEvent expects
    const eventRecord = event as unknown as Record<string, unknown>;

    const { notifications, turnId } = translatePiEvent(
      eventRecord,
      threadId,
      threadSession.turnId,
      threadSession.turnCounter,
    );
    threadSession.turnId = turnId;

    for (const notification of notifications) {
      send(notification);
    }
  };
}

function onSessionDone(_error?: unknown): void {
  // Stream ended; session remains available for resume.
}

function createForwardToolCall(threadId: string): ToolCallForwarder {
  return (toolName, args) => {
    return new Promise<{ content: string; isError?: boolean }>((resolve) => {
      const threadSession = sessions.get(threadId);
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
          threadId,
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
  };
}

function buildSessionOptions(
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): PiSdkSessionOptions {
  const model =
    typeof params.model === "string" ? params.model : undefined;
  const cwd =
    typeof params.cwd === "string" ? params.cwd : process.cwd();

  return { cwd, model, env };
}

function applyDynamicTools(
  sessionOptions: PiSdkSessionOptions,
  params: Record<string, unknown>,
  threadId: string,
): void {
  const dynamicTools = params.dynamicTools as
    | DynamicToolDefinition[]
    | undefined;
  if (dynamicTools && dynamicTools.length > 0) {
    sessionOptions.customTools = buildDynamicTools(
      dynamicTools,
      createForwardToolCall(threadId),
    );
  }
}

function handleRequest(request: JsonRpcRequest): void {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      sendResult(id, { ok: true });
      break;

    case "thread/start":
      void handleThreadStart(id, params ?? {});
      break;

    case "thread/resume":
      void handleThreadResume(id, params ?? {});
      break;

    case "turn/start":
      void handleTurnStart(id, params ?? {});
      break;

    case "turn/steer":
      void handleTurnSteer(id, params ?? {});
      break;

    case "thread/stop":
      handleThreadStop(id, params ?? {});
      break;

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleThreadStart(
  id: string | number,
  params: Record<string, unknown>,
): Promise<void> {
  const threadId =
    typeof params.threadId === "string"
      ? params.threadId
      : `pi-${Date.now()}`;

  // Stop existing session for this thread if any
  const existing = sessions.get(threadId);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadId);
  }

  const envOverrides = extractEnvOverrides(params);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  applyDynamicTools(sessionOptions, params, threadId);

  const turnCounter = createTurnCounterState();
  const session = new PiSdkSession(sessionOptions, createOnPiEvent(threadId), onSessionDone);

  const threadSession: ThreadSession = {
    session,
    turnId: undefined,
    turnCounter,
    pendingToolCalls: new Map(),
  };
  sessions.set(threadId, threadSession);

  await session.start();

  // Send the initial prompt
  const { text: inputText, images: inputImages } = extractInput(params.input);
  if (inputText) {
    void session.prompt(inputText, inputImages.length > 0 ? inputImages : undefined);
  }

  sendResult(id, { threadId });
}

async function handleThreadResume(
  id: string | number,
  params: Record<string, unknown>,
): Promise<void> {
  const threadId =
    typeof params.threadId === "string"
      ? params.threadId
      : `pi-${Date.now()}`;

  // Stop existing session for this thread if any
  const existing = sessions.get(threadId);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadId);
  }

  const envOverrides = extractEnvOverrides(params);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  applyDynamicTools(sessionOptions, params, threadId);

  const turnCounter = createTurnCounterState();
  const session = new PiSdkSession(sessionOptions, createOnPiEvent(threadId), onSessionDone);

  const threadSession: ThreadSession = {
    session,
    turnId: undefined,
    turnCounter,
    pendingToolCalls: new Map(),
  };
  sessions.set(threadId, threadSession);

  // Pi in-memory sessions don't support resume, so just start fresh
  await session.start();

  sendResult(id, { threadId });
}

async function handleTurnStart(
  id: string | number,
  params: Record<string, unknown>,
): Promise<void> {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const threadSession = threadId ? sessions.get(threadId) : undefined;
  if (!threadSession) {
    sendError(id, -32000, "No active pi session");
    return;
  }

  const { text, images } = extractInput(params.input);
  if (!text) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  void threadSession.session.prompt(text, images.length > 0 ? images : undefined);
  sendResult(id, { threadId });
}

async function handleTurnSteer(
  id: string | number,
  params: Record<string, unknown>,
): Promise<void> {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const threadSession = threadId ? sessions.get(threadId) : undefined;
  if (!threadSession) {
    sendError(id, -32000, "No active pi session");
    return;
  }

  const { text, images } = extractInput(params.input);
  if (!text) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  void threadSession.session.steer(text, images.length > 0 ? images : undefined);
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

interface ExtractedInput {
  text?: string;
  images: ImageContent[];
}

function mimeTypeFromExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    default: return "image/png";
  }
}

function extractInput(input: unknown): ExtractedInput {
  if (typeof input === "string") return { text: input, images: [] };
  if (!Array.isArray(input)) return { images: [] };

  const chunks: string[] = [];
  const images: ImageContent[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const typed = item as {
      type?: string;
      text?: string;
      path?: string;
      url?: string;
      mimeType?: string;
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    } else if (typed.type === "localImage" && typeof typed.path === "string") {
      try {
        const data = readFileSync(typed.path).toString("base64");
        const mimeType = typed.mimeType ?? mimeTypeFromExtension(typed.path);
        images.push({ type: "image", data, mimeType });
      } catch {
        // Skip unreadable images silently
      }
    }
  }

  return {
    text: chunks.length > 0 ? chunks.join("\n") : undefined,
    images,
  };
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
