import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  DynamicTool,
  InstructionMode,
  PendingInteractionCreate,
  PendingInteractionPayload,
  PendingInteractionResolution,
  ThreadEvent,
  ToolCallRequest,
} from "@bb/domain";
import { spawnPortablePipedProcess } from "@bb/process-utils";
import { z } from "zod";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import type {
  AdapterOptions,
  JsonRpcMessage,
  ProviderAdapter,
} from "./provider-adapter.js";
import { createProviderForId } from "./provider-registry.js";
import {
  ignoredJsonRpcResultSchema,
  isJsonRpcId,
  type PendingJsonRpcRequest,
  sendJsonRpc,
  sendJsonRpcError,
  sendJsonRpcRequest,
  sendJsonRpcResult,
  sendProviderRequestDecodeErrorIfKnown,
} from "./runtime-json-rpc.js";
import type {
  AgentRuntime,
  AgentRuntimeExecutionOptions,
  AgentRuntimeOptions,
  AgentRuntimeShellEnvironment,
} from "./types.js";
import {
  resolveAdapterPermissionPolicy,
  shouldAutoDenyInteractiveRequest,
} from "./shared/permission-policy.js";

const threadIdentityResultSchema = z.object({
  providerThreadId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
});
type ThreadIdentityResult = z.infer<typeof threadIdentityResultSchema>;

interface ResolveThreadIdentityResultArgs {
  result: ThreadIdentityResult;
  threadId: string;
}

interface StampThreadEventScopeArgs {
  event: ThreadEvent;
  providerThreadId: string | undefined;
  threadId: string;
}

interface ReconfigureThreadIfNeededArgs {
  instructions: string | undefined;
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

type ProviderRequestKind = "interactive request" | "tool call";

interface ResolveProviderRequestThreadIdArgs {
  parsedId: string | number;
  proc: ProviderProcess;
  providerThreadId: string;
  requestKind: ProviderRequestKind;
  threadIdHint: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveThreadIdentityResult(
  args: ResolveThreadIdentityResultArgs,
): string | undefined {
  if (args.result.providerThreadId) {
    return args.result.providerThreadId;
  }
  if (args.result.threadId && args.result.threadId !== args.threadId) {
    return args.result.threadId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Adapter options helpers
// ---------------------------------------------------------------------------

function createAdapterTurnIdPrefix(): string {
  const adapterId = randomUUID().replaceAll("-", "").slice(0, 16);
  return `turn_${adapterId}_`;
}

function toAdapterOptions(
  execOpts: AgentRuntimeExecutionOptions,
  instructions: string | undefined,
  envVars: Record<string, string>,
): AdapterOptions {
  const permissionPolicy = resolveAdapterPermissionPolicy(execOpts);
  return {
    model: execOpts.model,
    serviceTier: execOpts.serviceTier,
    reasoningLevel: execOpts.reasoningLevel,
    ...permissionPolicy,
    instructions,
    envVars,
  };
}

function buildDeniedInteractiveResolution(
  payload: PendingInteractionPayload,
): PendingInteractionResolution {
  switch (payload.kind) {
    case "command_approval":
      return {
        kind: "command_approval",
        decision: "decline",
      };
    case "file_change_approval":
      return {
        kind: "file_change_approval",
        decision: "decline",
      };
    case "permission_request":
      return {
        kind: "permission_request",
        decision: "deny",
      };
  }
}

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

interface ProviderProcess {
  child: ChildProcess;
  adapter: ProviderAdapter;
  interactiveRequestScope: string;
  pending: Map<string | number, PendingJsonRpcRequest>;
  identityWaiters: Map<string, PendingIdentityWaiter>;
  threadIds: Set<string>;
  stderrChunks: string[];
  pendingIdentity: string[];
}

interface PendingIdentityWaiter {
  resolve: (providerThreadId: string | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ThreadRuntimeConfig {
  dynamicTools?: DynamicTool[];
  environmentId: string;
  instructionMode: InstructionMode;
  instructions?: string;
  options: AgentRuntimeExecutionOptions;
  projectId?: string;
  providerId: string;
  resumePath?: string;
  workspacePath: string;
}

interface ThreadShellEnvironmentArgs {
  environmentId: string;
  projectId?: string;
  threadId: string;
}

interface RuntimeParsedMessageArgs {
  parsed: Record<string, unknown>;
  proc: ProviderProcess;
}

interface RuntimeJsonRpcResponseArgs extends RuntimeParsedMessageArgs {
  parsedId: string | number;
}

interface RuntimeProviderRequestArgs {
  line: string;
  parsedId: string | number;
  parsedMethod: string;
  proc: ProviderProcess;
  rawRequest: JsonRpcMessage;
}

interface RuntimeProviderNotificationArgs extends RuntimeParsedMessageArgs {
  line: string;
  notificationMethod: string;
}

interface EmitTranslatedEventsArgs {
  events: ThreadEvent[];
  proc: ProviderProcess;
  providerId: string;
  rawCaptureId?: string;
  rawMethod?: string;
  sourceThreadId?: string;
}

function buildThreadShellEnvironment(
  args: ThreadShellEnvironmentArgs & {
    baseShellEnv: AgentRuntimeShellEnvironment | undefined;
  },
): Record<string, string> {
  return {
    ...(args.baseShellEnv ?? {}),
    ...(args.projectId ? { BB_PROJECT_ID: args.projectId } : {}),
    BB_THREAD_ID: args.threadId,
    BB_ENVIRONMENT_ID: args.environmentId,
  };
}

function scopeProviderRequestId(
  scope: string,
  requestId: string | number,
): string {
  return `${scope}:${String(requestId)}`;
}

/**
 * Owns provider processes for an environment and bridges provider JSON-RPC
 * traffic into bb thread events, dynamic tool calls, and pending interactions.
 */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  let nextRequestId = 1;
  let nextCaptureId = 1;
  const processes = new Map<string, ProviderProcess>();
  const providerStarting = new Map<string, Promise<void>>();
  const threadToProvider = new Map<string, string>();
  const threadToProviderThread = new Map<string, string>();
  const threadRuntimeConfigs = new Map<string, ThreadRuntimeConfig>();
  let shuttingDown = false;

  function createCaptureId(): string {
    const captureId = `capture-${nextCaptureId}`;
    nextCaptureId += 1;
    return captureId;
  }

  function emitCapture(entry: AgentRuntimeCaptureEntry): void {
    options.onCapture?.(entry);
  }

  function getAdapter(providerId: string): ProviderAdapter {
    if (options.adapterFactory) {
      return options.adapterFactory(providerId);
    }
    return createProviderForId(providerId, {
      bridgeBundleDir: options.bridgeBundleDir,
      turnIdPrefix: createAdapterTurnIdPrefix(),
    });
  }

  function requireProviderProcess(providerId: string): ProviderProcess {
    const proc = processes.get(providerId);
    if (!proc) {
      throw new Error(`Provider "${providerId}" is not running`);
    }
    if (proc.child.exitCode !== null) {
      processes.delete(providerId);
      throw new Error(
        `Provider "${providerId}" has exited (code ${proc.child.exitCode})`,
      );
    }
    return proc;
  }

  function resolveProviderForThread(threadId: string): string {
    const providerId = threadToProvider.get(threadId);
    if (!providerId) {
      throw new Error(`No provider associated with thread "${threadId}"`);
    }
    return providerId;
  }

  function resolveBbThreadIdForProcess(
    proc: ProviderProcess,
    providerThreadId: string | undefined,
  ): string | undefined {
    if (providerThreadId) {
      for (const [bbThreadId, mappedProviderThreadId] of threadToProviderThread) {
        if (
          mappedProviderThreadId === providerThreadId
          && proc.threadIds.has(bbThreadId)
        ) {
          return bbThreadId;
        }
      }
    }

    return undefined;
  }

  function formatProviderRequestKindForSentence(
    requestKind: ProviderRequestKind,
  ): string {
    return requestKind === "tool call" ? "Tool call" : "Interactive request";
  }

  function resolveProviderRequestThreadId(
    args: ResolveProviderRequestThreadIdArgs,
  ): string | null {
    const resolvedThreadId = resolveBbThreadIdForProcess(
      args.proc,
      args.providerThreadId,
    );
    if (!resolvedThreadId) {
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: `Unable to resolve BB thread id for ${args.requestKind} on provider thread "${args.providerThreadId}"`,
      });
      return null;
    }
    if (args.threadIdHint && args.threadIdHint !== resolvedThreadId) {
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: `${formatProviderRequestKindForSentence(args.requestKind)} thread hint "${args.threadIdHint}" did not match resolved BB thread "${resolvedThreadId}" for provider thread "${args.providerThreadId}"`,
      });
      return null;
    }

    return resolvedThreadId;
  }

  function stampThreadEventScope(args: StampThreadEventScopeArgs): ThreadEvent {
    if ("providerThreadId" in args.event && args.providerThreadId) {
      return {
        ...args.event,
        providerThreadId: args.providerThreadId,
        threadId: args.threadId,
      };
    }

    return {
      ...args.event,
      threadId: args.threadId,
    };
  }

  function sameExecutionSettings(
    left: AgentRuntimeExecutionOptions,
    right: AgentRuntimeExecutionOptions,
  ): boolean {
    return (
      left.model === right.model &&
      left.serviceTier === right.serviceTier &&
      left.reasoningLevel === right.reasoningLevel &&
      left.permissionMode === right.permissionMode &&
      left.permissionEscalation === right.permissionEscalation
    );
  }

  function setThreadRuntimeConfig(
    threadId: string,
    config: ThreadRuntimeConfig,
  ): void {
    threadRuntimeConfigs.set(threadId, config);
  }

  function clearThreadRuntimeConfig(threadId: string): void {
    threadRuntimeConfigs.delete(threadId);
  }

  function recordProviderThreadIdentity(
    proc: ProviderProcess,
    threadId: string,
    providerThreadId: string,
  ): void {
    threadToProviderThread.set(threadId, providerThreadId);
    const waiter = proc.identityWaiters.get(threadId);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timeout);
    proc.identityWaiters.delete(threadId);
    waiter.resolve(providerThreadId);
  }

  function waitForProviderThreadIdentity(
    proc: ProviderProcess,
    threadId: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const existing = threadToProviderThread.get(threadId);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        proc.identityWaiters.delete(threadId);
        resolve(null);
      }, timeoutMs);
      proc.identityWaiters.set(threadId, {
        resolve,
        timeout,
      });
    });
  }

  function resolvePendingIdentityWaiters(proc: ProviderProcess): void {
    for (const [threadId, waiter] of proc.identityWaiters) {
      clearTimeout(waiter.timeout);
      proc.identityWaiters.delete(threadId);
      waiter.resolve(null);
    }
  }

  async function reconfigureThreadIfNeeded(
    args: ReconfigureThreadIfNeededArgs,
  ): Promise<void> {
    const currentConfig = threadRuntimeConfigs.get(args.threadId);
    if (!currentConfig) {
      return;
    }

    const nextOptions = args.options;
    const nextInstructions = args.instructions ?? currentConfig.instructions;

    if (
      sameExecutionSettings(currentConfig.options, nextOptions) &&
      currentConfig.instructions === nextInstructions
    ) {
      return;
    }

    const proc = requireProviderProcess(currentConfig.providerId);
    const envVars = buildThreadShellEnvironment({
      baseShellEnv: options.shellEnv,
      environmentId: currentConfig.environmentId,
      projectId: currentConfig.projectId,
      threadId: args.threadId,
    });

    const command = proc.adapter.buildCommand({
      type: "thread/resume",
      threadId: args.threadId,
      cwd: currentConfig.workspacePath,
      providerThreadId: threadToProviderThread.get(args.threadId),
      options: toAdapterOptions(nextOptions, nextInstructions, envVars),
      resumePath: currentConfig.resumePath,
      dynamicTools: currentConfig.dynamicTools,
      instructionMode: currentConfig.instructionMode,
    });

    if (command) {
      const result = await sendJsonRpcRequest({
        child: proc.child,
        message: command,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: threadIdentityResultSchema,
      });
      const providerThreadId = resolveThreadIdentityResult({
        result,
        threadId: args.threadId,
      });
      if (providerThreadId) {
        recordProviderThreadIdentity(proc, args.threadId, providerThreadId);
      }
    }

    setThreadRuntimeConfig(args.threadId, {
      ...currentConfig,
      instructions: nextInstructions,
      options: nextOptions,
    });
  }

  function handleJsonRpcResponse(args: RuntimeJsonRpcResponseArgs): void {
    const pending = args.proc.pending.get(args.parsedId);
    if (!pending) {
      return;
    }

    args.proc.pending.delete(args.parsedId);
    if (args.parsed.error) {
      const err = isRecord(args.parsed.error) ? args.parsed.error : null;
      pending.reject(
        new Error(
          typeof err?.message === "string"
            ? err.message
            : JSON.stringify(args.parsed.error),
        ),
      );
      return;
    }

    pending.resolve(args.parsed.result);
  }

  function handleToolCallProviderRequest(
    args: RuntimeProviderRequestArgs,
  ): boolean {
    const providerId = args.proc.adapter.id;
    let toolCallReq: ReturnType<ProviderAdapter["decodeToolCallRequest"]>;
    try {
      toolCallReq = args.proc.adapter.decodeToolCallRequest(args.rawRequest);
    } catch (error) {
      if (sendProviderRequestDecodeErrorIfKnown({
        child: args.proc.child,
        error,
        id: args.parsedId,
      })) {
        return true;
      }
      throw error;
    }
    if (!toolCallReq) {
      return false;
    }

    const resolvedThreadId = resolveProviderRequestThreadId({
      parsedId: args.parsedId,
      proc: args.proc,
      providerThreadId: toolCallReq.providerThreadId,
      requestKind: "tool call",
      threadIdHint: toolCallReq.threadId,
    });
    if (!resolvedThreadId) {
      return true;
    }

    const scopedToolCallReq: ToolCallRequest = {
      requestId: toolCallReq.requestId,
      threadId: resolvedThreadId,
      providerThreadId: toolCallReq.providerThreadId,
      turnId: toolCallReq.turnId,
      callId: toolCallReq.callId,
      tool: toolCallReq.tool,
      ...(toolCallReq.arguments !== undefined ? { arguments: toolCallReq.arguments } : {}),
    };
    const captureId = createCaptureId();
    emitCapture({
      kind: "tool-call-request",
      captureId,
      capturedAt: Date.now(),
      providerId,
      rawLine: args.line,
      rawRequest: args.rawRequest,
      request: scopedToolCallReq,
    });
    void options.onToolCall(scopedToolCallReq).then((response) => {
      emitCapture({
        kind: "tool-call-result",
        capturedAt: Date.now(),
        providerId,
        requestCaptureId: captureId,
        requestId: scopedToolCallReq.requestId,
        success: true,
        response,
      });
      sendJsonRpcResult({
        child: args.proc.child,
        id: args.parsedId,
        result: response,
      });
    }).catch((err) => {
      emitCapture({
        kind: "tool-call-result",
        capturedAt: Date.now(),
        providerId,
        requestCaptureId: captureId,
        requestId: scopedToolCallReq.requestId,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

  function handleInteractiveProviderRequest(
    args: RuntimeProviderRequestArgs,
  ): boolean {
    const providerId = args.proc.adapter.id;
    const decodeInteractiveRequest = args.proc.adapter.decodeInteractiveRequest;
    if (!decodeInteractiveRequest) {
      return false;
    }

    let interactiveReq: ReturnType<typeof decodeInteractiveRequest>;
    try {
      interactiveReq = decodeInteractiveRequest(args.rawRequest);
    } catch (error) {
      if (sendProviderRequestDecodeErrorIfKnown({
        child: args.proc.child,
        error,
        id: args.parsedId,
      })) {
        return true;
      }
      throw error;
    }
    if (!interactiveReq) {
      return false;
    }

    const resolvedThreadId = resolveProviderRequestThreadId({
      parsedId: args.parsedId,
      proc: args.proc,
      providerThreadId: interactiveReq.providerThreadId,
      requestKind: "interactive request",
      threadIdHint: interactiveReq.threadId,
    });
    if (!resolvedThreadId) {
      return true;
    }
    if (!args.proc.adapter.buildInteractiveResponse) {
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: `Provider "${providerId}" cannot encode interactive response for "${interactiveReq.method}"`,
      });
      return true;
    }
    const buildInteractiveResponse = args.proc.adapter.buildInteractiveResponse;

    const scopedInteractiveReq: PendingInteractionCreate = {
      threadId: resolvedThreadId,
      turnId: interactiveReq.turnId,
      providerId,
      providerThreadId: interactiveReq.providerThreadId,
      providerRequestId: scopeProviderRequestId(
        args.proc.interactiveRequestScope,
        interactiveReq.requestId,
      ),
      payload: interactiveReq.payload,
    };
    const captureId = createCaptureId();
    emitCapture({
      kind: "interactive-request",
      captureId,
      capturedAt: Date.now(),
      providerId,
      rawLine: args.line,
      rawRequest: args.rawRequest,
      request: scopedInteractiveReq,
    });
    const threadConfig = threadRuntimeConfigs.get(resolvedThreadId);
    if (
      // Managed/non-interactive contexts use deny escalation so providers get a
      // deterministic denial instead of waiting for a UI that will never answer.
      (threadConfig
        ? shouldAutoDenyInteractiveRequest(threadConfig.options)
        : false)
      || !options.onInteractiveRequest
    ) {
      const resolution = buildDeniedInteractiveResolution(interactiveReq.payload);
      emitCapture({
        kind: "interactive-result",
        capturedAt: Date.now(),
        providerId,
        requestCaptureId: captureId,
        requestId: scopedInteractiveReq.providerRequestId,
        success: true,
        resolution,
      });
      sendJsonRpcResult({
        child: args.proc.child,
        id: args.parsedId,
        result: buildInteractiveResponse({
          request: interactiveReq,
          resolution,
        }),
      });
      return true;
    }

    void options.onInteractiveRequest(scopedInteractiveReq).then((resolution) => {
      emitCapture({
        kind: "interactive-result",
        capturedAt: Date.now(),
        providerId,
        requestCaptureId: captureId,
        requestId: scopedInteractiveReq.providerRequestId,
        success: true,
        resolution,
      });
      sendJsonRpcResult({
        child: args.proc.child,
        id: args.parsedId,
        result: buildInteractiveResponse({
          request: interactiveReq,
          resolution,
        }),
      });
    }).catch((err) => {
      emitCapture({
        kind: "interactive-result",
        capturedAt: Date.now(),
        providerId,
        requestCaptureId: captureId,
        requestId: scopedInteractiveReq.providerRequestId,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

  function handleProviderRequest(args: RuntimeProviderRequestArgs): void {
    if (handleToolCallProviderRequest(args)) {
      return;
    }
    if (handleInteractiveProviderRequest(args)) {
      return;
    }

    sendJsonRpcError({
      child: args.proc.child,
      id: args.parsedId,
      message: `Unsupported provider request "${args.parsedMethod}"`,
      code: -32601,
    });
  }

  function emitTranslatedEvents(args: EmitTranslatedEventsArgs): void {
    for (const event of args.events) {
      if (event.type !== "thread/identity" || !event.providerThreadId) {
        continue;
      }

      if (args.proc.threadIds.has(event.threadId)) {
        recordProviderThreadIdentity(args.proc, event.threadId, event.providerThreadId);
        continue;
      }

      if (args.proc.pendingIdentity.length > 0) {
        const bbThreadId = args.proc.pendingIdentity.shift();
        if (bbThreadId) {
          recordProviderThreadIdentity(args.proc, bbThreadId, event.providerThreadId);
        }
      }
    }

    for (const event of args.events) {
      let resolvedBbThreadId: string | undefined;
      if (args.sourceThreadId && args.proc.threadIds.has(args.sourceThreadId)) {
        resolvedBbThreadId = args.sourceThreadId;
      } else if (event.threadId && args.proc.threadIds.has(event.threadId)) {
        resolvedBbThreadId = event.threadId;
      } else {
        const lookupId = args.sourceThreadId || event.threadId;
        if (lookupId) {
          for (const [bbId, provId] of threadToProviderThread) {
            if (provId === lookupId && args.proc.threadIds.has(bbId)) {
              resolvedBbThreadId = bbId;
              break;
            }
          }
        }
      }
      if (!resolvedBbThreadId && args.proc.threadIds.size === 1) {
        resolvedBbThreadId = [...args.proc.threadIds][0];
      }

      if (!resolvedBbThreadId) {
        options.onStderr?.(
          `Dropping unscoped provider event ${event.type}; no bb thread could be resolved`,
        );
        continue;
      }

      const stampedEvent = stampThreadEventScope({
        event,
        providerThreadId: threadToProviderThread.get(resolvedBbThreadId),
        threadId: resolvedBbThreadId,
      });

      emitCapture({
        kind: "translated-thread-event",
        capturedAt: Date.now(),
        providerId: args.providerId,
        rawCaptureId: args.rawCaptureId,
        rawMethod: args.rawMethod,
        event: stampedEvent,
      });
      options.onEvent(stampedEvent);
    }
  }

  function handleProviderNotification(
    args: RuntimeProviderNotificationArgs,
  ): void {
    const params = isRecord(args.parsed.params) ? args.parsed.params : undefined;
    const sourceThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const rawCaptureId = createCaptureId();
    const rawEvent: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: args.notificationMethod,
      ...(Object.hasOwn(args.parsed, "params") ? { params: args.parsed.params } : {}),
    };
    const providerId = args.proc.adapter.id;
    emitCapture({
      kind: "raw-provider-event",
      captureId: rawCaptureId,
      capturedAt: Date.now(),
      providerId,
      rawLine: args.line,
      rawEvent,
      sourceThreadId,
    });
    emitTranslatedEvents({
      events: args.proc.adapter.translateEvent(args.parsed, { threadId: sourceThreadId }),
      proc: args.proc,
      providerId,
      sourceThreadId,
      rawCaptureId,
      rawMethod: rawEvent.method,
    });
  }

  function handleStdoutLine(
    line: string,
    proc: ProviderProcess,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON — treat as stderr-like output
      options.onStderr?.(line);
      return;
    }

    if (!isRecord(parsed)) {
      options.onStderr?.(line);
      return;
    }

    // JSON-RPC response (has id, has result or error, no method)
    const parsedId = parsed.id;
    if (isJsonRpcId(parsedId) && !parsed.method) {
      handleJsonRpcResponse({ parsed, parsedId, proc });
      return;
    }

    // JSON-RPC request from provider (has id AND method).
    const parsedMethod = parsed.method;
    if (isJsonRpcId(parsedId) && typeof parsedMethod === "string") {
      const rawRequest: JsonRpcMessage = {
        jsonrpc: "2.0",
        id: parsedId,
        method: parsedMethod,
        ...(Object.hasOwn(parsed, "params") ? { params: parsed.params } : {}),
      };
      handleProviderRequest({
        line,
        parsedId,
        parsedMethod,
        proc,
        rawRequest,
      });
      return;
    }

    // JSON-RPC notification (no id, has method) — provider event.
    // The runtime does NOT interpret notification content — it delegates
    // entirely to the adapter's translateEvent. Each adapter knows its
    // own wire format (codex sends direct notifications, bridges wrap
    // SDK messages in sdk/message envelopes, etc.).
    const notificationMethod = parsed.method;
    if (typeof notificationMethod === "string") {
      handleProviderNotification({
        line,
        notificationMethod,
        parsed,
        proc,
      });
    }
  }

  function spawnProvider(
    providerId: string,
    adapter: ProviderAdapter,
  ): ProviderProcess {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
    };

    const child = spawnPortablePipedProcess({
      command: adapter.process.command,
      args: adapter.process.args,
      cwd: options.workspacePath,
      env,
    });

    const proc: ProviderProcess = {
      child,
      adapter,
      interactiveRequestScope: randomUUID(),
      pending: new Map(),
      identityWaiters: new Map(),
      threadIds: new Set(),
      stderrChunks: [],
      pendingIdentity: [],
    };

    // Read stdout line by line
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => handleStdoutLine(line, proc));

    // Forward stderr
    const stderrRl = createInterface({ input: child.stderr });
    stderrRl.on("line", (line) => {
      proc.stderrChunks.push(line);
      options.onStderr?.(line);
      emitCapture({
        kind: "provider-stderr",
        capturedAt: Date.now(),
        providerId,
        line,
      });
    });

    // Handle spawn errors (e.g., binary not found)
    child.on("error", (err) => {
      if (shuttingDown) return;
      processes.delete(providerId);
      for (const [, pending] of proc.pending) {
        pending.reject(new Error(`Provider "${providerId}" failed to start: ${err.message}`));
      }
      proc.pending.clear();
      resolvePendingIdentityWaiters(proc);
      proc.pendingIdentity = [];

      emitCapture({
        kind: "provider-process-error",
        capturedAt: Date.now(),
        providerId,
        message: err.message,
      });

      options.onProcessExit?.({
        providerId,
        threadIds: [...proc.threadIds],
        code: null,
        signal: null,
      });
    });

    // Handle exit
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      processes.delete(providerId);
      const threadIds = [...proc.threadIds];
      for (const tid of threadIds) {
        threadToProvider.delete(tid);
        threadToProviderThread.delete(tid);
        clearThreadRuntimeConfig(tid);
      }
      proc.pendingIdentity = [];
      // Reject any pending requests
      for (const [, pending] of proc.pending) {
        pending.reject(new Error(`Provider "${providerId}" exited unexpectedly`));
      }
      proc.pending.clear();
      resolvePendingIdentityWaiters(proc);

      emitCapture({
        kind: "provider-process-exit",
        capturedAt: Date.now(),
        providerId,
        threadIds,
        code: code ?? null,
        signal: signal ?? null,
        stderrChunks: [...proc.stderrChunks],
      });

      options.onProcessExit?.({
        providerId,
        threadIds,
        code: code ?? null,
        signal: signal ?? null,
      });
    });

    processes.set(providerId, proc);
    return proc;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const runtime: AgentRuntime = {
    async ensureProvider({ providerId }) {
      if (processes.has(providerId)) return;

      const existing = providerStarting.get(providerId);
      if (existing) {
        await existing;
        return;
      }

      const startPromise = (async () => {
        const adapter = getAdapter(providerId);
        const proc = spawnProvider(providerId, adapter);

        // Check for immediate startup failure
        if (proc.child.exitCode !== null) {
          processes.delete(providerId);
          const stderr = proc.stderrChunks.join("\n").slice(0, 500);
          throw new Error(
            `Provider "${providerId}" exited during startup with code ${proc.child.exitCode}` +
            (stderr ? `\nstderr: ${stderr}` : ""),
          );
        }

        // Send initialize command
        const initCmd = adapter.buildCommand({ type: "initialize" });
        if (initCmd) {
          await sendJsonRpcRequest({
            child: proc.child,
            message: initCmd,
            pending: proc.pending,
            getNextId: () => nextRequestId++,
            resultSchema: ignoredJsonRpcResultSchema,
          });
        }
      })();

      providerStarting.set(providerId, startPromise);
      try {
        await startPromise;
      } finally {
        providerStarting.delete(providerId);
      }
    },

    async startThread({
      environmentId,
      threadId,
      projectId,
      providerId,
      input,
      options: execOpts,
      instructions,
      dynamicTools,
      instructionMode = "append",
    }) {
      const pid = providerId ?? "codex";
      await runtime.ensureProvider({ providerId: pid });

      const proc = requireProviderProcess(pid);
      threadToProvider.set(threadId, pid);
      proc.threadIds.add(threadId);
      proc.pendingIdentity.push(threadId);
      setThreadRuntimeConfig(threadId, {
        dynamicTools,
        environmentId,
        instructionMode,
        instructions,
        options: execOpts,
        projectId,
        providerId: pid,
        workspacePath: options.workspacePath,
      });

      const envVars = buildThreadShellEnvironment({
        baseShellEnv: options.shellEnv,
        environmentId,
        projectId,
        threadId,
      });

      const cmd = proc.adapter.buildCommand({
        type: "thread/start",
        threadId,
        cwd: options.workspacePath,
        options: toAdapterOptions(execOpts, instructions, envVars),
        dynamicTools,
        instructionMode,
      });

      if (!cmd) {
        throw new Error(`Adapter "${pid}" returned null for thread/start`);
      }

      const result = await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: threadIdentityResultSchema,
      });
      const providerThreadId = resolveThreadIdentityResult({
        result,
        threadId,
      });
      if (providerThreadId) {
        recordProviderThreadIdentity(proc, threadId, providerThreadId);
      }

      const resolved = await waitForProviderThreadIdentity(proc, threadId, 5000);
      if (!resolved) {
        throw new Error(
          `Provider "${pid}" did not return a providerThreadId for thread "${threadId}" within 5 seconds`,
        );
      }

      if (input && input.length > 0) {
        await runtime.runTurn({
          threadId,
          input,
          options: execOpts,
          instructions,
        });
      }

      return { providerThreadId: resolved };
    },

    async resumeThread({
      environmentId,
      threadId,
      projectId,
      providerThreadId,
      providerId,
      options: execOpts,
      instructions,
      resumePath,
      dynamicTools,
      instructionMode = "append",
    }) {
      const pid = providerId ?? resolveProviderForThread(threadId);
      await runtime.ensureProvider({ providerId: pid });

      const proc = requireProviderProcess(pid);
      threadToProvider.set(threadId, pid);
      proc.threadIds.add(threadId);
      setThreadRuntimeConfig(threadId, {
        dynamicTools,
        environmentId,
        instructionMode,
        instructions,
        options: execOpts,
        projectId,
        providerId: pid,
        resumePath,
        workspacePath: options.workspacePath,
      });

      if (providerThreadId) {
        recordProviderThreadIdentity(proc, threadId, providerThreadId);
      } else {
        proc.pendingIdentity.push(threadId);
      }

      const envVars = buildThreadShellEnvironment({
        baseShellEnv: options.shellEnv,
        environmentId,
        projectId,
        threadId,
      });

      const cmd = proc.adapter.buildCommand({
        type: "thread/resume",
        threadId,
        cwd: options.workspacePath,
        providerThreadId:
          providerThreadId ?? threadToProviderThread.get(threadId),
        options: toAdapterOptions(execOpts, instructions, envVars),
        resumePath,
        dynamicTools,
        instructionMode,
      });

      if (!cmd) {
        const currentProviderThreadId =
          providerThreadId ?? threadToProviderThread.get(threadId);
        if (!currentProviderThreadId) {
          throw new Error(`No provider thread id available for ${threadId}`);
        }
        return { providerThreadId: currentProviderThreadId };
      }

      const result = await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: threadIdentityResultSchema,
      });
      const resolvedId =
        resolveThreadIdentityResult({ result, threadId }) ??
        providerThreadId ??
        threadToProviderThread.get(threadId);
      if (!resolvedId) {
        throw new Error(`Provider resume did not return a thread id for ${threadId}`);
      }
      recordProviderThreadIdentity(proc, threadId, resolvedId);

      return { providerThreadId: resolvedId };
    },

    async runTurn({ threadId, input, options: execOpts, instructions }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);
      await reconfigureThreadIfNeeded({
        threadId,
        options: execOpts,
        instructions,
      });

      const cmd = proc.adapter.buildCommand({
        type: "turn/start",
        threadId,
        providerThreadId: threadToProviderThread.get(threadId),
        input,
        options: toAdapterOptions(execOpts, instructions, {}),
      });

      if (!cmd) return;
      await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
    },

    async steerTurn({ threadId, expectedTurnId, input, options: execOpts, instructions }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);
      await reconfigureThreadIfNeeded({
        threadId,
        options: execOpts,
        instructions,
      });

      const cmd = proc.adapter.buildCommand({
        type: "turn/steer",
        threadId,
        providerThreadId: threadToProviderThread.get(threadId),
        expectedTurnId,
        input,
        options: toAdapterOptions(execOpts, instructions, {}),
      });

      if (!cmd) return;
      sendJsonRpc(proc.child, { ...cmd, id: nextRequestId++ });
    },

    async stopThread({ threadId }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);

      const cmd = proc.adapter.buildCommand({
        type: "thread/stop",
        threadId,
      });

      if (cmd) {
        sendJsonRpc(proc.child, { ...cmd, id: nextRequestId++ });
      }
    },

    async renameThread({ threadId, title }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);

      const cmd = proc.adapter.buildCommand({
        type: "thread/name/set",
        threadId,
        providerThreadId: threadToProviderThread.get(threadId),
        title,
      });

      if (!cmd) return;
      await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
    },

    async listModels({ providerId }) {
      await runtime.ensureProvider({ providerId });
      const proc = requireProviderProcess(providerId);
      const command = proc.adapter.buildCommand({ type: "model/list" });
      if (!command) {
        throw new Error(`Provider "${providerId}" does not support model/list`);
      }
      const result = await sendJsonRpcRequest({
        child: proc.child,
        message: command,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      return proc.adapter.parseModelListResult(result);
    },

    listRunningProviders() {
      return [...processes.keys()];
    },

    async shutdown() {
      shuttingDown = true;
      const shutdownPromises: Promise<void>[] = [];

      for (const [providerId, proc] of processes) {
        shutdownPromises.push(
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              proc.child.kill("SIGKILL");
              resolve();
            }, 5000);

            proc.child.on("exit", () => {
              clearTimeout(timer);
              resolve();
            });

            proc.child.kill("SIGTERM");
          }),
        );
        // Reject pending requests
        for (const [, pending] of proc.pending) {
          pending.reject(new Error(`Runtime shutting down`));
        }
        proc.pending.clear();
        resolvePendingIdentityWaiters(proc);

        // Clean up mappings
        for (const tid of proc.threadIds) {
          threadToProvider.delete(tid);
          threadToProviderThread.delete(tid);
          clearThreadRuntimeConfig(tid);
        }
        proc.pendingIdentity = [];
        processes.delete(providerId);
      }

      await Promise.all(shutdownPromises);
    },
  };

  return runtime;
}
