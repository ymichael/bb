#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  jsonRpcEnvelopeSchema,
  type BridgeToolCallRequest,
} from "../../shared/bridge-tool-calls.js";
import type {
  ThreadEventContextWindowUsage,
} from "@bb/domain";
import type {
  AgentSessionEvent,
  ContextUsage,
} from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import { PiSdkSession, type PiSdkSessionOptions } from "./sdk-session.js";
import {
  buildDynamicTools,
  type DynamicToolDefinition,
  type ToolCallForwarder,
} from "./tool-proxy.js";
import { listPiBridgeModels } from "./model-list.js";

// ---------------------------------------------------------------------------
// Command schema — defines what JSON-RPC requests this bridge accepts
// ---------------------------------------------------------------------------

const piCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: z.object({
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }),
  }),
  z.object({
    method: z.literal("model/list"),
    params: z.object({}),
  }),
  z.object({
    method: z.literal("thread/start"),
    params: z.object({
      threadId: z.string().optional(),
      cwd: z.string(),
      baseInstructions: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      input: z.array(z.unknown()).optional(),
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
      cwd: z.string(),
      sessionPath: z.string().optional(),
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
      input: z.array(z.unknown()),
      model: z.string().optional(),
    }),
  }),
  z.object({
    method: z.literal("turn/steer"),
    params: z.object({
      threadId: z.string(),
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

export type PiCommand = z.infer<typeof piCommandSchema>;

function decodePiJsonRpcRequest(raw: unknown): (PiCommand & { jsonrpc: "2.0"; id: string | number }) | null {
  const envelope = jsonRpcEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;

  const command = piCommandSchema.safeParse({
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
  error?: { code: number; message: string };
}

interface SdkEventNotification {
  jsonrpc: "2.0";
  method: "sdk/message";
  params: { threadId: string; message: AgentSessionEvent };
}

interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface PendingToolCall {
  resolve: (value: { content: string; isError?: boolean }) => void;
}

interface CurrentThreadSessionArgs {
  sessionSerial: number;
  threadId: string;
}

interface CreateSessionCallbackArgs {
  sessionSerial: number;
  threadId: string;
}

interface ThreadSession {
  session: PiSdkSession;
  sessionSerial: number;
  stopping: boolean;
  pendingToolCalls: Map<string | number, PendingToolCall>;
}

const sessions = new Map<string, ThreadSession>();
let sessionSerialCounter = 0;
let toolCallRequestIdCounter = 0;

function send(msg: JsonRpcResponse | SdkEventNotification | BridgeEventNotification | BridgeToolCallRequest): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toContextWindowUsagePayload(
  contextUsage: ContextUsage | undefined,
): ThreadEventContextWindowUsage | null {
  if (!contextUsage) {
    return null;
  }

  return {
    usedTokens: contextUsage.tokens ?? null,
    modelContextWindow: contextUsage.contextWindow > 0
      ? contextUsage.contextWindow
      : null,
    estimated: true,
  };
}

function emitContextWindowUsage(threadId: string): void {
  const threadSession = sessions.get(threadId);
  if (!threadSession) {
    return;
  }

  const contextWindowUsage = toContextWindowUsagePayload(
    threadSession.session.getContextUsage(),
  );
  if (!contextWindowUsage) {
    return;
  }

  send({
    jsonrpc: "2.0",
    method: "thread/contextWindowUsage/updated",
    params: {
      threadId,
      contextWindowUsage,
    },
  });
}

function nextSessionSerial(): number {
  sessionSerialCounter += 1;
  return sessionSerialCounter;
}

function getCurrentThreadSession(
  args: CurrentThreadSessionArgs,
): ThreadSession | undefined {
  const threadSession = sessions.get(args.threadId);
  // Runtime treats stop as a terminal boundary for pending acks and active turn
  // state, so callbacks from a stopping session must not leak stale SDK events.
  if (
    !threadSession
    || threadSession.stopping
    || threadSession.sessionSerial !== args.sessionSerial
  ) {
    return undefined;
  }
  return threadSession;
}

function createOnPiEvent(args: CreateSessionCallbackArgs): (event: AgentSessionEvent) => void {
  return (event: AgentSessionEvent) => {
    const threadSession = getCurrentThreadSession({
      sessionSerial: args.sessionSerial,
      threadId: args.threadId,
    });
    if (!threadSession) return;
    send({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: { threadId: args.threadId, message: event },
    });
    if (event.type === "agent_end") {
      emitContextWindowUsage(args.threadId);
    }
  };
}

function createOnSessionDone(args: CreateSessionCallbackArgs): (error?: unknown) => void {
  return (error?: unknown) => {
    if (!error) return;
    const threadSession = getCurrentThreadSession({
      sessionSerial: args.sessionSerial,
      threadId: args.threadId,
    });
    if (!threadSession) return;

    const message =
      error instanceof Error ? error.message : String(error);

    send({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: args.threadId, message },
    });
  };
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
          providerThreadId: threadId,
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
  };
}

function buildSessionOptions(
  params: {
    cwd: string;
    model?: string;
    baseInstructions?: string;
    sessionPath?: string;
  },
  env: NodeJS.ProcessEnv,
  threadId: string,
): PiSdkSessionOptions {
  const sessionFilePath = resolvePiSessionFilePath(threadId, params.sessionPath);

  return {
    cwd: params.cwd,
    model: params.model,
    env,
    sessionFilePath,
    systemPrompt: params.baseInstructions,
  };
}

function applyDynamicTools(
  sessionOptions: PiSdkSessionOptions,
  dynamicTools: DynamicToolDefinition[] | undefined,
  threadId: string,
): void {
  if (dynamicTools && dynamicTools.length > 0) {
    sessionOptions.customTools = buildDynamicTools(
      dynamicTools,
      createForwardToolCall(threadId),
    );
  }
}

function resolvePiSessionFilePath(
  threadId: string,
  sessionPath?: string,
): string {
  if (sessionPath?.trim()) {
    return resolve(sessionPath);
  }

  return join(
    homedir(),
    ".bb",
    "pi-bridge-sessions",
    `${sanitizeSessionKey(threadId)}.jsonl`,
  );
}

function sanitizeSessionKey(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function handleRequest(request: PiCommand & { id: string | number }): void {
  switch (request.method) {
    case "initialize":
      sendResult(request.id, { ok: true });
      break;
    case "model/list":
      void handleModelList(request.id);
      break;
    case "thread/start":
      void handleThreadStart(request.id, request.params);
      break;
    case "thread/resume":
      void handleThreadResume(request.id, request.params);
      break;
    case "turn/start":
      void handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      void handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      void handleThreadStop(request.id, request.params);
      break;
  }
}

type ThreadStartParams = Extract<PiCommand, { method: "thread/start" }>["params"];
type ThreadResumeParams = Extract<PiCommand, { method: "thread/resume" }>["params"];
type TurnStartParams = Extract<PiCommand, { method: "turn/start" }>["params"];
type TurnSteerParams = Extract<PiCommand, { method: "turn/steer" }>["params"];
type ThreadStopParams = Extract<PiCommand, { method: "thread/stop" }>["params"];

async function handleModelList(id: string | number): Promise<void> {
  try {
    sendResult(id, await listPiBridgeModels());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(id, -32000, message);
  }
}

async function handleThreadStart(
  id: string | number,
  params: ThreadStartParams,
): Promise<void> {
  const threadId = params.threadId ?? `pi-${Date.now()}`;

  // Stop existing session for this thread if any
  const existing = sessions.get(threadId);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadId);
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv, threadId);
  applyDynamicTools(sessionOptions, params.dynamicTools, threadId);

  const sessionSerial = nextSessionSerial();
  const session = new PiSdkSession(
    sessionOptions,
    createOnPiEvent({ sessionSerial, threadId }),
    createOnSessionDone({ sessionSerial, threadId }),
  );

  const threadSession: ThreadSession = {
    session,
    sessionSerial,
    stopping: false,
    pendingToolCalls: new Map(),
  };
  sessions.set(threadId, threadSession);

  await session.start();

  sendResult(id, { threadId });
  send({
    jsonrpc: "2.0",
    method: "thread/identity",
    params: { threadId, providerThreadId: threadId },
  });
}

async function handleThreadResume(
  id: string | number,
  params: ThreadResumeParams,
): Promise<void> {
  const threadId = params.threadId;

  // Stop existing session for this thread if any
  const existing = sessions.get(threadId);
  if (existing) {
    existing.session.stop();
    sessions.delete(threadId);
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv, threadId);
  applyDynamicTools(sessionOptions, params.dynamicTools, threadId);

  const sessionSerial = nextSessionSerial();
  const session = new PiSdkSession(
    sessionOptions,
    createOnPiEvent({ sessionSerial, threadId }),
    createOnSessionDone({ sessionSerial, threadId }),
  );

  const threadSession: ThreadSession = {
    session,
    sessionSerial,
    stopping: false,
    pendingToolCalls: new Map(),
  };
  sessions.set(threadId, threadSession);

  await session.start();

  sendResult(id, { threadId });
}

async function handleTurnStart(
  id: string | number,
  params: TurnStartParams,
): Promise<void> {
  const threadSession = sessions.get(params.threadId);
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
  sendResult(id, { threadId: params.threadId });
}

async function handleTurnSteer(
  id: string | number,
  params: TurnSteerParams,
): Promise<void> {
  const threadSession = sessions.get(params.threadId);
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
  sendResult(id, { threadId: params.threadId });
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParams,
): Promise<void> {
  try {
    const threadSession = sessions.get(params.threadId);
    if (threadSession) {
      threadSession.stopping = true;
      threadSession.session.stop();
      sessions.delete(params.threadId);
    }
    sendResult(id, { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(id, -32000, message);
  }
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

  const request = decodePiJsonRpcRequest(parsed);
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
