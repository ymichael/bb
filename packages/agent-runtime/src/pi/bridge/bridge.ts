#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  jsonRpcEnvelopeSchema,
  type BridgeToolCallRequest,
} from "../../shared/bridge-tool-calls.js";
import {
  reasoningLevelValues,
  type ReasoningLevel,
  type ThreadEventContextWindowUsage,
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

interface PiInstructionOverrideParams {
  baseInstructions?: string;
  appendSystemPrompt?: string;
}

interface BuildPiSessionOptionsParams extends PiInstructionOverrideParams {
  cwd: string;
  model?: string;
  sessionPath?: string;
  thinkingLevel?: ReasoningLevel;
}

function hasAtMostOnePiInstructionOverride(
  params: PiInstructionOverrideParams,
): boolean {
  return (
    params.baseInstructions === undefined
    || params.appendSystemPrompt === undefined
  );
}

const piInstructionOverrideSchemaOptions = {
  message: "Provide either baseInstructions or appendSystemPrompt, not both",
  path: ["appendSystemPrompt"],
};

const piReasoningLevelSchema = z.enum(reasoningLevelValues);

const piThreadStartParamsSchema = z.object({
  threadId: z.string().optional(),
  cwd: z.string(),
  baseInstructions: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  reasoningLevel: piReasoningLevelSchema.optional(),
  input: z.array(z.unknown()).optional(),
  dynamicTools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.unknown(),
  })).optional(),
}).refine(hasAtMostOnePiInstructionOverride, piInstructionOverrideSchemaOptions);

const piThreadResumeParamsSchema = z.object({
  threadId: z.string(),
  cwd: z.string(),
  sessionPath: z.string().optional(),
  baseInstructions: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  reasoningLevel: piReasoningLevelSchema.optional(),
  dynamicTools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.unknown(),
  })).optional(),
}).refine(hasAtMostOnePiInstructionOverride, piInstructionOverrideSchemaOptions);

const piCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: z.object({
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }),
  }),
  z.object({
    method: z.literal("model/list"),
    params: z.object({
      selectedModel: z.string().min(1).optional(),
    }),
  }),
  z.object({
    method: z.literal("thread/start"),
    params: piThreadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: piThreadResumeParamsSchema,
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

interface CloseThreadSessionArgs {
  message: string;
  threadId: string;
}

interface PiThreadStopResult {
  ok: true;
}

const sessions = new Map<string, ThreadSession>();
const closingSessions = new Map<string, Promise<void>>();
let sessionSerialCounter = 0;
let toolCallRequestIdCounter = 0;

// Runtime waits on thread/stop until Pi aborts the active operation or this
// timeout forces disposal. Stop remains a best-effort success boundary.
const THREAD_STOP_CLOSE_TIMEOUT_MS = 4_000;

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
      if (!threadSession || threadSession.stopping) {
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

function resolvePendingToolCalls(
  threadSession: ThreadSession,
  message: string,
): void {
  for (const [requestId, pending] of threadSession.pendingToolCalls) {
    threadSession.pendingToolCalls.delete(requestId);
    pending.resolve({ content: message, isError: true });
  }
}

async function closeThreadSession(args: CloseThreadSessionArgs): Promise<void> {
  const existingClose = closingSessions.get(args.threadId);
  if (existingClose) {
    await existingClose;
    return;
  }

  const threadSession = sessions.get(args.threadId);
  if (!threadSession) {
    return;
  }

  threadSession.stopping = true;
  resolvePendingToolCalls(threadSession, args.message);
  const closePromise = (async () => {
    await threadSession.session.closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS);
  })().finally(() => {
    if (sessions.get(args.threadId) === threadSession) {
      sessions.delete(args.threadId);
    }
    closingSessions.delete(args.threadId);
  });
  closingSessions.set(args.threadId, closePromise);
  await closePromise;
}

async function closeThreadSessionsGracefully(message: string): Promise<void> {
  await Promise.all(
    Array.from(sessions.keys()).map((threadId) =>
      closeThreadSession({ message, threadId })
    ),
  );
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
  params: BuildPiSessionOptionsParams,
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
    appendSystemPrompt: params.appendSystemPrompt,
    ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
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

async function handleRequest(request: PiCommand & { id: string | number }): Promise<void> {
  switch (request.method) {
    case "initialize":
      sendResult(request.id, { ok: true });
      break;
    case "model/list":
      await handleModelList(request.id, request.params);
      break;
    case "thread/start":
      await handleThreadStart(request.id, request.params);
      break;
    case "thread/resume":
      await handleThreadResume(request.id, request.params);
      break;
    case "turn/start":
      await handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      await handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      sendResult(request.id, await handleThreadStop(request.params));
      break;
  }
}

type ThreadStartParams = Extract<PiCommand, { method: "thread/start" }>["params"];
type ThreadResumeParams = Extract<PiCommand, { method: "thread/resume" }>["params"];
type TurnStartParams = Extract<PiCommand, { method: "turn/start" }>["params"];
type TurnSteerParams = Extract<PiCommand, { method: "turn/steer" }>["params"];
type ThreadStopParams = Extract<PiCommand, { method: "thread/stop" }>["params"];
type ModelListParams = Extract<PiCommand, { method: "model/list" }>["params"];
type PiSessionParams = ThreadStartParams | ThreadResumeParams;

function buildPiSessionParams(
  params: PiSessionParams,
): BuildPiSessionOptionsParams {
  return {
    cwd: params.cwd,
    ...(params.model ? { model: params.model } : {}),
    ...("sessionPath" in params && params.sessionPath
      ? { sessionPath: params.sessionPath }
      : {}),
    ...(params.baseInstructions ? { baseInstructions: params.baseInstructions } : {}),
    ...(params.appendSystemPrompt ? { appendSystemPrompt: params.appendSystemPrompt } : {}),
    ...(params.reasoningLevel ? { thinkingLevel: params.reasoningLevel } : {}),
  };
}

async function handleModelList(
  id: string | number,
  params: ModelListParams,
): Promise<void> {
  try {
    sendResult(id, await listPiBridgeModels({
      selectedModel: params.selectedModel,
    }));
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
    await closeThreadSession({
      message: "Pi thread session replaced while tool call was pending",
      threadId,
    });
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(
    buildPiSessionParams(params),
    sessionEnv,
    threadId,
  );
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
    await closeThreadSession({
      message: "Pi thread session replaced while tool call was pending",
      threadId,
    });
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(
    buildPiSessionParams(params),
    sessionEnv,
    threadId,
  );
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
  if (!threadSession || threadSession.stopping) {
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
  if (!threadSession || threadSession.stopping) {
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
  params: ThreadStopParams,
): Promise<PiThreadStopResult> {
  await closeThreadSession({
    message: "Pi thread stopped while tool call was pending",
    threadId: params.threadId,
  });
  return { ok: true };
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

export function handleLine(line: string): void {
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
  void handleRequest(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sendError(request.id, -32000, message);
  });
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined
    && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
}

if (isMainModule()) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", handleLine);
  rl.on("close", () => {
    // Stdin close is a process shutdown boundary; wait briefly for per-thread
    // abort/dispose so SDK work does not continue while the bridge exits.
    void closeThreadSessionsGracefully("Pi bridge shutting down while tool call was pending")
      .finally(() => {
        process.exit(0);
      });
  });
}
