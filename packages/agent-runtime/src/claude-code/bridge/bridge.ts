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
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  instructionModeValues,
  type InstructionMode,
} from "@bb/domain";
import { z } from "zod";
import {
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  jsonRpcEnvelopeSchema,
  type BridgeToolCallRequest,
} from "../../shared/bridge-tool-calls.js";
import { SdkSession, type SdkSessionOptions } from "./sdk-session.js";
import { listClaudeCodeBridgeModels } from "./model-list.js";
import {
  buildBridgeMcpServer,
  getAllowedToolNames,
  BRIDGE_MCP_SERVER_NAME,
  type ToolCallForwarder,
} from "./tool-proxy-mcp.js";
import {
  type ClaudeInteractiveResponse,
  type ClaudePermissionMode,
  type ClaudePermissionRequestApprovalParams,
  type ClaudePermissionUpdate,
  CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
  claudeInteractiveResponseSchema,
  claudePermissionModeSchema,
  claudePermissionUpdateSchema,
  shouldRequestClaudePermissionApproval,
  toPendingInteractionPermissionProfile,
} from "../interactive-contract.js";

// ---------------------------------------------------------------------------
// Command schema — defines what JSON-RPC requests this bridge accepts
// ---------------------------------------------------------------------------

const bridgeInstructionModeSchema = z.enum(instructionModeValues);

const claudeCodeCommandSchema = z.discriminatedUnion("method", [
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
      threadId: z.string(),
      cwd: z.string(),
      baseInstructions: z.string(),
      permissionMode: claudePermissionModeSchema,
      config: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      instructionMode: bridgeInstructionModeSchema,
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
      providerThreadId: z.string().nullable(),
      baseInstructions: z.string().optional(),
      permissionMode: claudePermissionModeSchema,
      config: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      instructionMode: bridgeInstructionModeSchema,
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

type ClaudeCodeJsonRpcRequest = ClaudeCodeCommand & {
  jsonrpc: "2.0";
  id: string | number;
};

function decodeClaudeCodeJsonRpcRequest(
  raw: unknown,
): ClaudeCodeJsonRpcRequest | null {
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

interface ThreadIdRef {
  current: string;
}

interface PendingInteractiveRequest {
  itemId: string;
  kind: "permission_request";
  originalInput: Record<string, unknown>;
  resolve: (value: PermissionResult) => void;
}

interface ThreadSession {
  session: SdkSession;
  pendingToolCalls: Map<string | number, PendingToolCall>;
  pendingInteractiveRequests: Map<string | number, PendingInteractiveRequest>;
  permissionMode: ClaudePermissionMode;
  providerThreadId?: string;
}

interface ClaudeCanUseToolDecisionContext {
  blockedPath: string | undefined;
  decisionReason: string | undefined;
  suggestions: ClaudePermissionUpdate[] | undefined;
  toolName: string;
}

interface BuildInteractiveRequestParamsArgs {
  providerThreadId: string;
  threadId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  decisionReason: string | undefined;
  blockedPath: string | undefined;
  suggestions: ClaudePermissionUpdate[] | undefined;
}

interface BuildSessionOptionsArgs {
  baseInstructions?: string;
  cwd: string;
  instructionMode: InstructionMode;
  model?: string;
  permissionMode: ClaudePermissionMode;
}

interface ForwardInteractiveRequestArgs extends BuildInteractiveRequestParamsArgs {
  signal: AbortSignal;
}

const sessions = new Map<string, ThreadSession>();
let toolCallRequestIdCounter = 0;

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

function createOnSdkMessage(
  threadIdRef: ThreadIdRef,
): (message: SDKMessage) => void {
  return (message: SDKMessage) => {
    if (!sessions.has(threadIdRef.current)) return;
    sendSdkMessage(threadIdRef.current, message);
  };
}

function createOnSdkDone(
  threadIdRef: ThreadIdRef,
): (error?: unknown) => void {
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

function createForwardToolCall(threadIdRef: ThreadIdRef): ToolCallForwarder {
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
          providerThreadId: threadSession.providerThreadId ?? threadIdRef.current,
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

function findSessionByPendingInteractiveRequest(
  id: string | number,
): ThreadSession | undefined {
  for (const session of sessions.values()) {
    if (session.pendingInteractiveRequests.has(id)) {
      return session;
    }
  }

  return undefined;
}

function resolvePendingInteractiveRequests(
  threadSession: ThreadSession,
  message: string,
): void {
  for (const [requestId, pending] of threadSession.pendingInteractiveRequests) {
    threadSession.pendingInteractiveRequests.delete(requestId);
    pending.resolve({
      behavior: "deny",
      interrupt: true,
      message,
      toolUseID: pending.itemId,
    });
  }
}

function stopThreadSession(threadId: string, message: string): void {
  const threadSession = sessions.get(threadId);
  if (!threadSession) {
    return;
  }

  resolvePendingInteractiveRequests(threadSession, message);
  threadSession.session.stop();
  sessions.delete(threadId);
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

function parseClaudePermissionUpdates(
  value: unknown,
): ClaudePermissionUpdate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsedUpdates = value.flatMap((entry) => {
    const parsed = claudePermissionUpdateSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });

  return parsedUpdates.length > 0 ? parsedUpdates : undefined;
}

function buildInteractiveRequestParams(
  args: BuildInteractiveRequestParamsArgs,
): ClaudePermissionRequestApprovalParams {
  return {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    turnId: "",
    itemId: args.toolUseId,
    toolName: args.toolName,
    reason: args.decisionReason ?? null,
    permissions: toPendingInteractionPermissionProfile({
      toolName: args.toolName,
      blockedPath: args.blockedPath,
      suggestions: args.suggestions,
    }),
  };
}

function buildInteractivePermissionResult(
  pending: PendingInteractiveRequest,
  response: ClaudeInteractiveResponse,
): PermissionResult {
  if (pending.kind !== response.kind) {
    return {
      behavior: "deny",
      message: "Interactive response kind mismatch",
      toolUseID: pending.itemId,
    };
  }

  switch (response.kind) {
    case "permission_request":
      if (response.behavior === "deny") {
        return {
          behavior: "deny",
          message: response.message,
          ...(response.interrupt === undefined
            ? {}
            : { interrupt: response.interrupt }),
          toolUseID: pending.itemId,
        };
      }
      return {
        behavior: "allow",
        updatedInput: pending.originalInput,
        ...(response.updatedPermissions === undefined
          ? {}
          : { updatedPermissions: response.updatedPermissions }),
        toolUseID: pending.itemId,
      };
  }
}

function createForwardInteractiveRequest(
  threadIdRef: ThreadIdRef,
): (args: ForwardInteractiveRequestArgs) => Promise<PermissionResult> {
  return (args) => new Promise<PermissionResult>((resolve) => {
    const threadSession = sessions.get(threadIdRef.current);
    if (!threadSession) {
      resolve({
        behavior: "deny",
        message: "Thread session not found",
        toolUseID: args.toolUseId,
      });
      return;
    }

    let params: ClaudePermissionRequestApprovalParams;
    try {
      params = buildInteractiveRequestParams(args);
    } catch (error) {
      resolve({
        behavior: "deny",
        message: error instanceof Error ? error.message : String(error),
        toolUseID: args.toolUseId,
      });
      return;
    }

    toolCallRequestIdCounter += 1;
    const requestId = toolCallRequestIdCounter;

    const finish = (result: PermissionResult): void => {
      args.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      if (!threadSession.pendingInteractiveRequests.delete(requestId)) {
        return;
      }
      finish({
        behavior: "deny",
        message: "Interactive request cancelled",
        toolUseID: args.toolUseId,
      });
    };

    args.signal.addEventListener("abort", onAbort, { once: true });
    threadSession.pendingInteractiveRequests.set(requestId, {
      itemId: args.toolUseId,
      kind: "permission_request",
      originalInput: args.input,
      resolve: finish,
    });

    send({
      jsonrpc: "2.0",
      id: requestId,
      method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
      params,
    });
  });
}

function createCanUseTool(
  threadIdRef: ThreadIdRef,
): CanUseTool {
  const forwardInteractiveRequest = createForwardInteractiveRequest(threadIdRef);

  return async (toolName, input, options) => {
    const threadSession = sessions.get(threadIdRef.current);
    if (!threadSession) {
      return {
        behavior: "deny",
        message: "Thread session not found",
        toolUseID: options.toolUseID,
      };
    }
    const suggestions = parseClaudePermissionUpdates(options.suggestions);

    const requestContext: ClaudeCanUseToolDecisionContext = {
      toolName,
      blockedPath: options.blockedPath,
      decisionReason: options.decisionReason,
      suggestions,
    };
    const shouldRequestApproval =
      shouldRequestClaudePermissionApproval(requestContext)
      || (options.suggestions?.length ?? 0) > 0;

    if (!shouldRequestApproval) {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
      };
    }

    if (threadSession.permissionMode === "bypassPermissions") {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
      };
    }

    if (threadSession.permissionMode === "dontAsk") {
      return {
        behavior: "deny",
        message:
          options.decisionReason
          ?? `Tool ${toolName} is denied by the thread approval policy`,
        toolUseID: options.toolUseID,
      };
    }

    return forwardInteractiveRequest({
      threadId: threadIdRef.current,
      providerThreadId:
        threadSession.providerThreadId ?? threadIdRef.current,
      toolName,
      toolUseId: options.toolUseID,
      input,
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      suggestions,
      signal: options.signal,
    });
  };
}

export function buildSessionOptions(
  params: BuildSessionOptionsArgs,
  env: NodeJS.ProcessEnv,
): SdkSessionOptions {
  const systemPrompt: Exclude<Options["systemPrompt"], undefined> =
    params.instructionMode === "replace"
      ? (params.baseInstructions ?? "You are a helpful coding assistant.")
      : {
          type: "preset",
          preset: "claude_code",
          ...(params.baseInstructions && params.baseInstructions.length > 0
            ? { append: params.baseInstructions }
            : {}),
        };
  const model = params.model;

  return {
    cwd: params.cwd,
    systemPrompt,
    model,
    env,
    permissionMode: params.permissionMode,
  };
}

async function handleRequest(request: ClaudeCodeJsonRpcRequest): Promise<void> {
  switch (request.method) {
    case "initialize":
      sendResult(request.id, { ok: true });
      break;
    case "model/list":
      sendResult(request.id, await listClaudeCodeBridgeModels());
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
    stopThreadSession(
      threadIdRef.current,
      "Thread session replaced while awaiting permission approval",
    );
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  sessionOptions.canUseTool = createCanUseTool(threadIdRef);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(threadIdRef),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }

  const session = new SdkSession(
    sessionOptions,
    createOnSdkMessage(threadIdRef),
    createOnSdkDone(threadIdRef),
  );

  const threadSession: ThreadSession = {
    session,
    pendingToolCalls: new Map(),
    pendingInteractiveRequests: new Map(),
    permissionMode: params.permissionMode,
  };
  sessions.set(threadIdRef.current, threadSession);
  session.start();

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
    stopThreadSession(
      threadId,
      "Thread session replaced while awaiting permission approval",
    );
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const threadIdRef = { current: threadId };
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  sessionOptions.canUseTool = createCanUseTool(threadIdRef);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(threadIdRef),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }
  const session = new SdkSession(
    sessionOptions,
    createOnSdkMessage(threadIdRef),
    createOnSdkDone(threadIdRef),
  );

  const threadSession: ThreadSession = {
    session,
    pendingToolCalls: new Map(),
    pendingInteractiveRequests: new Map(),
    permissionMode: params.permissionMode,
    ...(providerThreadId ? { providerThreadId } : {}),
  };
  sessions.set(threadId, threadSession);
  session.start(providerThreadId);

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
    stopThreadSession(
      params.threadId,
      "Thread stopped while awaiting permission approval",
    );
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

  if (response && findSessionByPendingInteractiveRequest(response.id)) {
    const threadSession = findSessionByPendingInteractiveRequest(response.id)!;
    const pending = threadSession.pendingInteractiveRequests.get(response.id)!;
    threadSession.pendingInteractiveRequests.delete(response.id);
    if ("error" in response) {
      pending.resolve({
        behavior: "deny",
        message: response.error.message ?? "Interactive request failed",
        toolUseID: pending.itemId,
      });
      return;
    }

    const parsedResponse = claudeInteractiveResponseSchema.safeParse(
      response.result,
    );
    if (!parsedResponse.success) {
      pending.resolve({
        behavior: "deny",
        message: "Invalid interactive response payload",
        toolUseID: pending.itemId,
      });
      return;
    }

    pending.resolve(
      buildInteractivePermissionResult(pending, parsedResponse.data),
    );
    return;
  }

  const request = decodeClaudeCodeJsonRpcRequest(parsed);
  if (!request) return;
  void handleRequest(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sendError(request.id, -32000, message);
  });
}

// Main entry point
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", handleLine);
rl.on("close", () => {
  for (const threadId of [...sessions.keys()]) {
    stopThreadSession(
      threadId,
      "Bridge closed while awaiting permission approval",
    );
  }
  process.exit(0);
});
