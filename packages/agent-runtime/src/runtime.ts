import type {
  DynamicTool,
  InstructionMode,
  ThreadEvent,
} from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import type { AdapterCommand, JsonRpcMessage } from "./provider-adapter.js";
import {
  assertProviderSupportsExecutionOptions,
  sameExecutionSettings,
  toAdapterOptions,
} from "./execution-options.js";
import {
  getJsonRpcStringParam,
  ignoredJsonRpcResultSchema,
  type JsonRpcObject,
  parseJsonRpcLine,
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
} from "./types.js";
import {
  buildThreadShellEnvironment,
} from "./thread-shell-environment.js";
import {
  resolveThreadIdentityResult,
  threadIdentityResultSchema,
} from "./thread-identity.js";

interface ReconfigureThreadIfNeededArgs {
  instructions: string | undefined;
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

interface ResolveProviderRequestThreadIdArgs
  extends ResolveRuntimeProviderRequestThreadIdArgs {
  proc: ProviderProcess;
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

interface EmitRuntimeEventArgs {
  event: ThreadEvent;
  proc: ProviderProcess;
  providerId: string;
  rawMethod?: string;
  sourceThreadId?: string;
}

interface EmitAcceptedCommandEventsArgs {
  command: AdapterCommand;
  proc: ProviderProcess;
  providerId: string;
  rawMethod: string;
  sourceThreadId?: string;
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
  const completedTurnIdsByThreadId = new Map<string, Set<string>>();

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
      activeTurnIdByThreadId.delete(threadId);
      completedTurnIdsByThreadId.delete(threadId);
    },
    onStderr: options.onStderr,
    workspacePath: options.workspacePath,
  });
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

  function recordCompletedTurn(threadId: string, turnId: string): void {
    const completedTurnIds =
      completedTurnIdsByThreadId.get(threadId) ?? new Set<string>();
    completedTurnIds.add(turnId);
    completedTurnIdsByThreadId.set(threadId, completedTurnIds);
  }

  function hasCompletedTurn(threadId: string, turnId: string): boolean {
    return completedTurnIdsByThreadId.get(threadId)?.has(turnId) ?? false;
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
      sameExecutionSettings({
        left: currentConfig.options,
        right: nextOptions,
      }) &&
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

    const adapterCommand: AdapterCommand = {
      type: "thread/resume",
      threadId: args.threadId,
      cwd: currentConfig.workspacePath,
      providerThreadId: threadIdentityRegistry.getProviderThreadId(args.threadId),
      options: toAdapterOptions({
        envVars,
        execOpts: nextOptions,
        instructions: nextInstructions,
      }),
      resumePath: currentConfig.resumePath,
      dynamicTools: currentConfig.dynamicTools,
      instructionMode: currentConfig.instructionMode,
    };
    const command = proc.adapter.buildCommand(adapterCommand);

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
      emitAcceptedCommandEvents({
        command: adapterCommand,
        proc,
        providerId: currentConfig.providerId,
        rawMethod: command.method,
        sourceThreadId: args.threadId,
      });
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

      const activeTurnId = activeTurnIdByThreadId.get(resolvedBbThreadId);

      emitRuntimeEvent({
        event: stampedEvent,
        proc: args.proc,
        providerId: args.providerId,
        rawCaptureId: args.rawCaptureId,
        rawMethod: args.rawMethod,
        sourceThreadId: args.sourceThreadId,
      });

      if (stampedEvent.type === "turn/started") {
        if (hasCompletedTurn(resolvedBbThreadId, stampedEvent.turnId)) {
          options.onStderr?.(
            `Skipping active turn update for replayed turn/started on already completed turn "${stampedEvent.turnId}" in thread "${resolvedBbThreadId}".`,
          );
        } else {
          activeTurnIdByThreadId.set(resolvedBbThreadId, stampedEvent.turnId);
        }
      }
      if (stampedEvent.type === "turn/completed") {
        recordCompletedTurn(resolvedBbThreadId, stampedEvent.turnId);
        if (activeTurnId === stampedEvent.turnId) {
          activeTurnIdByThreadId.delete(resolvedBbThreadId);
        }
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

  function emitAcceptedCommandEvents(
    args: EmitAcceptedCommandEventsArgs,
  ): void {
    const events = args.proc.adapter.translateAcceptedCommand({
      command: args.command,
    });
    if (events.length === 0) {
      return;
    }
    emitTranslatedEvents({
      events,
      proc: args.proc,
      providerId: args.providerId,
      rawMethod: `${args.rawMethod}/result`,
      sourceThreadId: args.sourceThreadId,
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
      assertProviderSupportsExecutionOptions({
        adapter: proc.adapter,
        options: execOpts,
        providerId: pid,
      });
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

      const adapterCommand: AdapterCommand = {
        type: "thread/start",
        threadId,
        cwd: options.workspacePath,
        options: toAdapterOptions({
          envVars,
          execOpts,
          instructions,
        }),
        dynamicTools,
        instructionMode,
      };
      const cmd = proc.adapter.buildCommand(adapterCommand);

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
      emitAcceptedCommandEvents({
        command: adapterCommand,
        proc,
        providerId: pid,
        rawMethod: cmd.method,
        sourceThreadId: threadId,
      });

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
      assertProviderSupportsExecutionOptions({
        adapter: proc.adapter,
        options: execOpts,
        providerId: pid,
      });
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

      const adapterCommand: AdapterCommand = {
        type: "thread/resume",
        threadId,
        cwd: options.workspacePath,
        providerThreadId:
          providerThreadId ?? threadIdentityRegistry.getProviderThreadId(threadId),
        options: toAdapterOptions({
          envVars,
          execOpts,
          instructions,
        }),
        resumePath,
        dynamicTools,
        instructionMode,
      };
      const cmd = proc.adapter.buildCommand(adapterCommand);

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
      emitAcceptedCommandEvents({
        command: adapterCommand,
        proc,
        providerId: pid,
        rawMethod: cmd.method,
        sourceThreadId: threadId,
      });

      return { providerThreadId: resolvedId };
    },

    async runTurn({
      threadId,
      input,
      clientRequestSequence,
      options: execOpts,
      instructions,
    }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);
      assertProviderSupportsExecutionOptions({
        adapter: proc.adapter,
        options: execOpts,
        providerId: pid,
      });
      await reconfigureThreadIfNeeded({
        threadId,
        options: execOpts,
        instructions,
      });

      const adapterCommand: AdapterCommand = {
        type: "turn/start",
        threadId,
        providerThreadId: threadIdentityRegistry.getProviderThreadId(threadId),
        input,
        ...(clientRequestSequence !== undefined ? { clientRequestSequence } : {}),
        options: toAdapterOptions({
          envVars: {},
          execOpts,
          instructions,
        }),
      };
      const cmd = proc.adapter.buildCommand(adapterCommand);

      if (!cmd) {
        throw new Error(`Adapter "${pid}" returned null for turn/start`);
      }
      await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      emitAcceptedCommandEvents({
        command: adapterCommand,
        proc,
        providerId: pid,
        rawMethod: cmd.method,
        sourceThreadId: threadId,
      });
    },

    async steerTurn({
      threadId,
      expectedTurnId,
      input,
      clientRequestSequence,
      options: execOpts,
      instructions,
    }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);
      assertProviderSupportsExecutionOptions({
        adapter: proc.adapter,
        options: execOpts,
        providerId: pid,
      });
      await reconfigureThreadIfNeeded({
        threadId,
        options: execOpts,
        instructions,
      });

      const activeTurnId = activeTurnIdByThreadId.get(threadId);
      if (activeTurnId !== expectedTurnId) {
        options.onStderr?.(
          `Ignoring stale steer for thread "${threadId}" on turn "${expectedTurnId}"; active turn is ${activeTurnId ?? "none"}.`,
        );
        return;
      }

      const adapterCommand: AdapterCommand = {
        type: "turn/steer",
        threadId,
        providerThreadId: threadIdentityRegistry.getProviderThreadId(threadId),
        expectedTurnId,
        input,
        ...(clientRequestSequence !== undefined ? { clientRequestSequence } : {}),
        options: toAdapterOptions({
          envVars: {},
          execOpts,
          instructions,
        }),
      };
      const cmd = proc.adapter.buildCommand(adapterCommand);

      if (!cmd) {
        throw new Error(`Adapter "${pid}" returned null for turn/steer`);
      }
      await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      emitAcceptedCommandEvents({
        command: adapterCommand,
        proc,
        providerId: pid,
        rawMethod: cmd.method,
        sourceThreadId: threadId,
      });
    },

    async stopThread({ threadId }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);
      const providerThreadId = threadIdentityRegistry.getProviderThreadId(threadId);
      if (!providerThreadId) {
        throw new Error(`No provider thread id available for ${threadId}`);
      }
      const activeTurnId = activeTurnIdByThreadId.get(threadId);
      const shouldRestartProvider =
        proc.adapter.threadStopBehavior === "restart-provider";
      const adapterCommand: AdapterCommand = {
        type: "thread/stop",
        threadId,
        providerThreadId,
        activeTurnId: activeTurnId ?? null,
      };
      const cmd = proc.adapter.buildCommand(adapterCommand);

      if (!cmd) {
        if (activeTurnId === undefined) {
          completedTurnIdsByThreadId.delete(threadId);
          return;
        }
        throw new Error(
          `Adapter "${pid}" returned null for thread/stop with active turn "${activeTurnId}"`,
        );
      }
      await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      emitAcceptedCommandEvents({
        command: adapterCommand,
        proc,
        providerId: pid,
        rawMethod: cmd.method,
        sourceThreadId: threadId,
      });
      activeTurnIdByThreadId.delete(threadId);
      completedTurnIdsByThreadId.delete(threadId);
      if (shouldRestartProvider) {
        await providerProcesses.shutdownProvider({ providerId: pid });
      }
    },

    async renameThread({ threadId, title }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);
      if (!proc.adapter.capabilities.supportsRename) {
        throw new Error(`Provider "${pid}" does not support thread rename.`);
      }

      const adapterCommand: AdapterCommand = {
        type: "thread/name/set",
        threadId,
        providerThreadId: threadIdentityRegistry.getProviderThreadId(threadId),
        title,
      };
      const cmd = proc.adapter.buildCommand(adapterCommand);

      if (!cmd) {
        throw new Error(`Adapter "${pid}" returned null for thread/name/set`);
      }
      await sendJsonRpcRequest({
        child: proc.child,
        message: cmd,
        pending: proc.pending,
        getNextId: () => nextRequestId++,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      emitAcceptedCommandEvents({
        command: adapterCommand,
        proc,
        providerId: pid,
        rawMethod: cmd.method,
        sourceThreadId: threadId,
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
      completedTurnIdsByThreadId.clear();
      await providerProcesses.shutdown();
    },
  };

  return runtime;
}
