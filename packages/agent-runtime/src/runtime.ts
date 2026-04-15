import type {
  DynamicTool,
  InstructionMode,
  PromptInput,
  ThreadEvent,
} from "@bb/domain";
import { z } from "zod";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import type {
  AdapterOptions,
  JsonRpcMessage,
  SyntheticUserMessageAckItem,
} from "./provider-adapter.js";
import {
  getJsonRpcStringParam,
  ignoredJsonRpcResultSchema,
  type JsonRpcObject,
  parseJsonRpcLine,
  sendJsonRpc,
  sendJsonRpcError,
  sendJsonRpcRequest,
  settleJsonRpcResponse,
} from "./runtime-json-rpc.js";
import {
  handleRuntimeProviderRequest,
  type ResolveRuntimeProviderRequestThreadIdArgs,
  type RuntimeProviderRequestKind,
} from "./runtime-provider-requests.js";
import {
  RuntimeProviderProcessManager,
  type RuntimeProviderProcess,
} from "./runtime-provider-process.js";
import {
  RuntimeThreadIdentityRegistry,
  stampThreadEventScope,
} from "./runtime-thread-identity.js";
import type {
  AgentRuntime,
  AgentRuntimeExecutionOptions,
  AgentRuntimeOptions,
  AgentRuntimeShellEnvironment,
} from "./types.js";
import {
  resolveAdapterPermissionPolicy,
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

interface ReconfigureThreadIfNeededArgs {
  instructions: string | undefined;
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

interface ResolveProviderRequestThreadIdArgs
  extends ResolveRuntimeProviderRequestThreadIdArgs {
  proc: ProviderProcess;
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

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

type ProviderProcess = RuntimeProviderProcess;

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

interface BuildThreadShellEnvironmentArgs extends ThreadShellEnvironmentArgs {
  baseShellEnv: AgentRuntimeShellEnvironment | undefined;
}

interface RuntimeParsedMessageArgs {
  parsed: JsonRpcObject;
  proc: ProviderProcess;
}

interface RuntimeJsonRpcResponseArgs extends RuntimeParsedMessageArgs {
  parsedId: string | number;
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

interface SyntheticUserMessageAck {
  itemId: string;
  item: SyntheticUserMessageAckItem;
}

interface EmitRuntimeEventArgs {
  event: ThreadEvent;
  proc: ProviderProcess;
  providerId: string;
  rawMethod?: string;
  sourceThreadId?: string;
}

interface EmitSyntheticUserMessageAckArgs {
  ack: SyntheticUserMessageAck;
  proc: ProviderProcess;
  providerId: string;
  threadId: string;
  turnId: string;
}

interface QueueSyntheticUserMessageAckArgs {
  input: PromptInput[];
  proc: ProviderProcess;
  threadId: string;
}

interface RemoveSyntheticUserMessageAckArgs {
  ack: SyntheticUserMessageAck;
  threadId: string;
}

function buildThreadShellEnvironment(
  args: BuildThreadShellEnvironmentArgs,
): Record<string, string> {
  return {
    ...(args.baseShellEnv ?? {}),
    ...(args.projectId ? { BB_PROJECT_ID: args.projectId } : {}),
    BB_THREAD_ID: args.threadId,
    BB_ENVIRONMENT_ID: args.environmentId,
  };
}

/**
 * Coordinates provider processes for an environment and bridges provider
 * JSON-RPC traffic into bb thread events, dynamic tool calls, and pending
 * interactions.
 */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  let nextRequestId = 1;
  let nextCaptureId = 1;
  const threadIdentityRegistry = new RuntimeThreadIdentityRegistry();
  const threadRuntimeConfigs = new Map<string, ThreadRuntimeConfig>();
  const activeTurnIdByThreadId = new Map<string, string>();

  function createCaptureId(): string {
    const captureId = `capture-${nextCaptureId}`;
    nextCaptureId += 1;
    return captureId;
  }

  function emitCapture(entry: AgentRuntimeCaptureEntry): void {
    options.onCapture?.(entry);
  }

  const providerProcesses = new RuntimeProviderProcessManager({
    adapterFactory: options.adapterFactory,
    bridgeBundleDir: options.bridgeBundleDir,
    createProviderIdentityState: (providerId) =>
      threadIdentityRegistry.createProviderState({ providerId }),
    emitCapture,
    env: options.env,
    getNextRequestId: () => nextRequestId++,
    handleStdoutLine: (args) =>
      handleStdoutLine(args.line, args.providerProcess),
    onProcessExit: options.onProcessExit,
    onProviderIdentityWaitersInterrupted: (providerProcess) =>
      threadIdentityRegistry.resolvePendingIdentityWaiters(providerProcess.identity),
    onProviderThreadDetached: (threadId) => {
      threadIdentityRegistry.clearThread(threadId);
      clearThreadRuntimeConfig(threadId);
      clearSyntheticUserMessageAckState(threadId);
      activeTurnIdByThreadId.delete(threadId);
    },
    onStderr: options.onStderr,
    workspacePath: options.workspacePath,
  });
  const pendingSyntheticUserMessageAcksByThreadId =
    new Map<string, SyntheticUserMessageAck[]>();
  const syntheticUserMessageAckCountersByThreadId = new Map<string, number>();

  function requireProviderProcess(providerId: string): ProviderProcess {
    return providerProcesses.requireProviderProcess(providerId);
  }

  function resolveProviderForThread(threadId: string): string {
    return threadIdentityRegistry.resolveProviderForThread(threadId);
  }

  function resolveBbThreadIdForProcess(
    proc: ProviderProcess,
    providerThreadId: string | undefined,
  ): string | undefined {
    return threadIdentityRegistry.resolveBbThreadIdForProviderThread({
      providerState: proc.identity,
      providerThreadId,
    });
  }

  function formatProviderRequestKindForSentence(
    requestKind: RuntimeProviderRequestKind,
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
    threadIdentityRegistry.recordProviderThreadIdentity({
      providerState: proc.identity,
      threadId,
      providerThreadId,
    });
  }

  function waitForProviderThreadIdentity(
    proc: ProviderProcess,
    threadId: string,
    timeoutMs: number,
  ): Promise<string | null> {
    return threadIdentityRegistry.waitForProviderThreadIdentity({
      providerState: proc.identity,
      threadId,
      timeoutMs,
    });
  }

  function nextSyntheticUserMessageAckItemId(threadId: string): string {
    const next = (syntheticUserMessageAckCountersByThreadId.get(threadId) ?? 0) + 1;
    syntheticUserMessageAckCountersByThreadId.set(threadId, next);
    return `runtime-user-${next}`;
  }

  function createSyntheticUserMessageAck(
    args: QueueSyntheticUserMessageAckArgs,
  ): SyntheticUserMessageAck | null {
    const itemId = nextSyntheticUserMessageAckItemId(args.threadId);
    const item = args.proc.adapter.buildSyntheticUserMessageAck?.({
      input: args.input,
      itemId,
    });
    if (!item) {
      return null;
    }
    return {
      item,
      itemId,
    };
  }

  function queueSyntheticUserMessageAck(
    args: QueueSyntheticUserMessageAckArgs,
  ): SyntheticUserMessageAck | null {
    const ack = createSyntheticUserMessageAck(args);
    if (!ack) {
      return null;
    }
    pendingSyntheticUserMessageAcksByThreadId.set(args.threadId, [
      ...(pendingSyntheticUserMessageAcksByThreadId.get(args.threadId) ?? []),
      ack,
    ]);
    return ack;
  }

  function removeSyntheticUserMessageAck(
    args: RemoveSyntheticUserMessageAckArgs,
  ): void {
    const pending = pendingSyntheticUserMessageAcksByThreadId.get(args.threadId);
    if (!pending) {
      return;
    }
    const next = pending.filter((ack) => ack !== args.ack);
    if (next.length === 0) {
      pendingSyntheticUserMessageAcksByThreadId.delete(args.threadId);
      return;
    }
    pendingSyntheticUserMessageAcksByThreadId.set(args.threadId, next);
  }

  function shiftSyntheticUserMessageAck(
    threadId: string,
  ): SyntheticUserMessageAck | undefined {
    const pending = pendingSyntheticUserMessageAcksByThreadId.get(threadId);
    if (!pending || pending.length === 0) {
      return undefined;
    }
    const [ack, ...remaining] = pending;
    if (remaining.length === 0) {
      pendingSyntheticUserMessageAcksByThreadId.delete(threadId);
    } else {
      pendingSyntheticUserMessageAcksByThreadId.set(threadId, remaining);
    }
    return ack;
  }

  function clearPendingSyntheticUserMessageAcks(threadId: string): void {
    pendingSyntheticUserMessageAcksByThreadId.delete(threadId);
  }

  function clearSyntheticUserMessageAckState(threadId: string): void {
    pendingSyntheticUserMessageAcksByThreadId.delete(threadId);
    syntheticUserMessageAckCountersByThreadId.delete(threadId);
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
      providerThreadId: threadIdentityRegistry.getProviderThreadId(args.threadId),
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
    settleJsonRpcResponse({
      id: args.parsedId,
      pending: args.proc.pending,
      response: args.parsed,
    });
  }

  function emitTranslatedEvents(args: EmitTranslatedEventsArgs): void {
    for (const event of args.events) {
      if (event.type !== "thread/identity" || !event.providerThreadId) {
        continue;
      }

      if (args.proc.identity.threadIds.has(event.threadId)) {
        recordProviderThreadIdentity(args.proc, event.threadId, event.providerThreadId);
        continue;
      }

      const bbThreadId = threadIdentityRegistry.resolvePendingProviderThreadIdentity(
        args.proc.identity,
      );
      if (bbThreadId) {
        recordProviderThreadIdentity(args.proc, bbThreadId, event.providerThreadId);
      }
    }

    for (const event of args.events) {
      const resolvedBbThreadId = threadIdentityRegistry.resolveProviderEventThreadId({
        eventThreadId: event.threadId,
        providerState: args.proc.identity,
        sourceThreadId: args.sourceThreadId,
      });

      if (!resolvedBbThreadId) {
        options.onStderr?.(
          `Dropping unscoped provider event ${event.type}; no bb thread could be resolved`,
        );
        continue;
      }

      const stampedEvent = stampThreadEventScope({
        event,
        providerThreadId: threadIdentityRegistry.getProviderThreadId(resolvedBbThreadId),
        threadId: resolvedBbThreadId,
      });

      emitRuntimeEvent({
        event: stampedEvent,
        proc: args.proc,
        providerId: args.providerId,
        rawCaptureId: args.rawCaptureId,
        rawMethod: args.rawMethod,
        sourceThreadId: args.sourceThreadId,
      });

      if (stampedEvent.type === "turn/started") {
        activeTurnIdByThreadId.set(resolvedBbThreadId, stampedEvent.turnId);
        const ack = shiftSyntheticUserMessageAck(resolvedBbThreadId);
        if (ack) {
          emitSyntheticUserMessageAck({
            ack,
            proc: args.proc,
            providerId: args.providerId,
            threadId: resolvedBbThreadId,
            turnId: stampedEvent.turnId,
          });
        }
      }
      if (stampedEvent.type === "turn/completed") {
        activeTurnIdByThreadId.delete(resolvedBbThreadId);
        clearPendingSyntheticUserMessageAcks(resolvedBbThreadId);
      }
    }
  }

  function emitRuntimeEvent(
    args: EmitRuntimeEventArgs & { rawCaptureId?: string },
  ): void {
    emitCapture({
      kind: "translated-thread-event",
      capturedAt: Date.now(),
      providerId: args.providerId,
      rawCaptureId: args.rawCaptureId,
      rawMethod: args.rawMethod,
      event: args.event,
    });
    options.onEvent(args.event);
  }

  function emitSyntheticUserMessageAck(
    args: EmitSyntheticUserMessageAckArgs,
  ): void {
    const providerThreadId = threadIdentityRegistry.getProviderThreadId(args.threadId);
    if (!providerThreadId) {
      throw new Error(
        `Cannot emit synthetic user message ack for ${args.threadId}; provider thread identity is not resolved.`,
      );
    }
    emitRuntimeEvent({
      event: {
        type: "item/completed",
        threadId: args.threadId,
        providerThreadId,
        turnId: args.turnId,
        item: {
          ...args.ack.item,
        },
      },
      proc: args.proc,
      providerId: args.providerId,
      rawMethod: "runtime/userMessage/ack",
      sourceThreadId: args.threadId,
    });
  }

  function handleProviderNotification(
    args: RuntimeProviderNotificationArgs,
  ): void {
    const sourceThreadId = getJsonRpcStringParam(args.parsed, "threadId");
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
    const parsedLine = parseJsonRpcLine(line);
    if (parsedLine.kind === "non_json" || parsedLine.kind === "invalid_json_rpc") {
      options.onStderr?.(line);
      return;
    }

    if (parsedLine.kind === "response") {
      handleJsonRpcResponse({
        parsed: parsedLine.parsed,
        parsedId: parsedLine.parsedId,
        proc,
      });
      return;
    }

    if (parsedLine.kind === "request") {
      handleRuntimeProviderRequest({
        createCaptureId,
        emitCapture,
        getThreadExecutionOptions: (threadId) =>
          threadRuntimeConfigs.get(threadId)?.options,
        line,
        onInteractiveRequest: options.onInteractiveRequest,
        onToolCall: options.onToolCall,
        parsedId: parsedLine.parsedId,
        parsedMethod: parsedLine.parsedMethod,
        providerProcess: proc,
        rawRequest: parsedLine.rawRequest,
        resolveThreadId: (request) =>
          resolveProviderRequestThreadId({
            ...request,
            proc,
          }),
      });
      return;
    }

    // The runtime does NOT interpret notification content — it delegates
    // entirely to the adapter's translateEvent. Each adapter knows its
    // own wire format (codex sends direct notifications, bridges wrap
    // SDK messages in sdk/message envelopes, etc.).
    handleProviderNotification({
      line,
      notificationMethod: parsedLine.notificationMethod,
      parsed: parsedLine.parsed,
      proc,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const runtime: AgentRuntime = {
    async ensureProvider({ providerId }) {
      await providerProcesses.ensureProvider({ providerId });
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
      threadIdentityRegistry.registerThreadProvider({
        providerId: pid,
        providerState: proc.identity,
        shouldWaitForProviderIdentity: true,
        threadId,
      });
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
      threadIdentityRegistry.registerThreadProvider({
        providerId: pid,
        providerState: proc.identity,
        shouldWaitForProviderIdentity: providerThreadId === undefined,
        threadId,
      });
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
          providerThreadId ?? threadIdentityRegistry.getProviderThreadId(threadId),
        options: toAdapterOptions(execOpts, instructions, envVars),
        resumePath,
        dynamicTools,
        instructionMode,
      });

      if (!cmd) {
        const currentProviderThreadId =
          providerThreadId ?? threadIdentityRegistry.getProviderThreadId(threadId);
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
        threadIdentityRegistry.getProviderThreadId(threadId);
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
        providerThreadId: threadIdentityRegistry.getProviderThreadId(threadId),
        input,
        options: toAdapterOptions(execOpts, instructions, {}),
      });

      if (!cmd) return;
      const pendingAck = queueSyntheticUserMessageAck({
        input,
        proc,
        threadId,
      });
      try {
        await sendJsonRpcRequest({
          child: proc.child,
          message: cmd,
          pending: proc.pending,
          getNextId: () => nextRequestId++,
          resultSchema: ignoredJsonRpcResultSchema,
        });
      } catch (error) {
        // If turn/started already arrived, the ack was shifted and emitted;
        // cleanup is then intentionally a no-op because emitted events are immutable.
        if (pendingAck) {
          removeSyntheticUserMessageAck({ ack: pendingAck, threadId });
        }
        throw error;
      }
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
        providerThreadId: threadIdentityRegistry.getProviderThreadId(threadId),
        expectedTurnId,
        input,
        options: toAdapterOptions(execOpts, instructions, {}),
      });

      if (!cmd) return;
      try {
        sendJsonRpc(proc.child, { ...cmd, id: nextRequestId++ });
        const ack = createSyntheticUserMessageAck({
          input,
          proc,
          threadId,
        });
        if (ack) {
          emitSyntheticUserMessageAck({
            ack,
            proc,
            providerId: pid,
            threadId,
            turnId: expectedTurnId,
          });
        }
      } catch (error) {
        clearPendingSyntheticUserMessageAcks(threadId);
        throw error;
      }
    },

    async stopThread({ threadId }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);
      const providerThreadId = threadIdentityRegistry.getProviderThreadId(threadId);
      const activeTurnId = activeTurnIdByThreadId.get(threadId);
      const shouldRestartProvider =
        proc.adapter.threadStopBehavior === "restart-provider";
      clearSyntheticUserMessageAckState(threadId);
      activeTurnIdByThreadId.delete(threadId);

      const cmd = proc.adapter.buildCommand({
        type: "thread/stop",
        threadId,
        providerThreadId,
        turnId: activeTurnId,
      });

      if (!cmd) return;
      await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      if (shouldRestartProvider) {
        await providerProcesses.shutdownProvider({ providerId: pid });
      }
    },

    async renameThread({ threadId, title }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);

      const cmd = proc.adapter.buildCommand({
        type: "thread/name/set",
        threadId,
        providerThreadId: threadIdentityRegistry.getProviderThreadId(threadId),
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
      return providerProcesses.listRunningProviders();
    },

    async shutdown() {
      pendingSyntheticUserMessageAcksByThreadId.clear();
      syntheticUserMessageAckCountersByThreadId.clear();
      await providerProcesses.shutdown();
    },
  };

  return runtime;
}
