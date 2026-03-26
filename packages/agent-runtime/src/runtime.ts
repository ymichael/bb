import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ThreadRuntimeExecutionOptions } from "@bb/domain";
import type {
  AdapterOptions,
  JsonRpcMessage,
  ProviderAdapter,
} from "./provider-adapter.js";
import { createProviderForId } from "./provider-registry.js";
import type { AgentRuntime, AgentRuntimeOptions } from "./types.js";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

function sendJsonRpc(
  child: ChildProcess,
  message: JsonRpcMessage,
): void {
  const line = JSON.stringify(message);
  child.stdin?.write(line + "\n");
}

function sendRequest(
  child: ChildProcess,
  message: JsonRpcMessage,
  pending: Map<string | number, PendingRequest>,
  getNextId: () => number,
  timeoutMs = 30_000,
): Promise<unknown> {
  const id = getNextId();
  const withId = { ...message, id };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`JSON-RPC request timed out: ${message.method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    sendJsonRpc(child, withId as JsonRpcMessage);
  });
}

// ---------------------------------------------------------------------------
// Adapter options helpers
// ---------------------------------------------------------------------------

function toAdapterOptions(
  execOpts: ThreadRuntimeExecutionOptions | undefined,
  envVars: Record<string, string>,
): AdapterOptions | undefined {
  if (!execOpts && Object.keys(envVars).length === 0) return undefined;
  return {
    model: execOpts?.model,
    serviceTier: execOpts?.serviceTier,
    reasoningLevel: execOpts?.reasoningLevel,
    sandboxMode: execOpts?.sandboxMode,
    instructions: execOpts?.instructions,
    envVars,
  };
}

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

interface ProviderProcess {
  child: ChildProcess;
  adapter: ProviderAdapter;
  pending: Map<string | number, PendingRequest>;
  threadIds: Set<string>;
  stderrChunks: string[];
  pendingIdentity: string[];
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  let nextRequestId = 1;
  const processes = new Map<string, ProviderProcess>();
  const providerStarting = new Map<string, Promise<void>>();
  const threadToProvider = new Map<string, string>();
  const threadToProviderThread = new Map<string, string>();
  let shuttingDown = false;

  function getAdapter(providerId: string): ProviderAdapter {
    if (options.adapterFactory) {
      return options.adapterFactory(providerId);
    }
    return createProviderForId(providerId);
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

  function handleStdoutLine(
    line: string,
    proc: ProviderProcess,
  ): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not JSON — treat as stderr-like output
      options.onStderr?.(line);
      return;
    }

    // JSON-RPC response (has id, has result or error, no method)
    if (parsed.id !== undefined && !parsed.method) {
      const pending = proc.pending.get(parsed.id as string | number);
      if (pending) {
        proc.pending.delete(parsed.id as string | number);
        if (parsed.error) {
          const err = parsed.error as { message?: string };
          pending.reject(
            new Error(err.message ?? JSON.stringify(parsed.error)),
          );
        } else {
          pending.resolve(parsed.result);
        }
      }
      return;
    }

    // JSON-RPC request from provider (has id AND method) — tool call
    if (parsed.id !== undefined && parsed.method) {
      const toolCallReq = proc.adapter.decodeToolCallRequest(
        parsed as unknown as JsonRpcMessage,
      );
      if (toolCallReq) {
        void options.onToolCall(toolCallReq).then((response) => {
          const rpcResponse = {
            jsonrpc: "2.0",
            id: parsed.id,
            result: response,
          };
          proc.child.stdin?.write(JSON.stringify(rpcResponse) + "\n");
        }).catch((err) => {
          const rpcError = {
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          };
          proc.child.stdin?.write(JSON.stringify(rpcError) + "\n");
        });
      }
      return;
    }

    // Helper: emit translated events and intercept thread/identity to update
    // the providerThreadId mapping (used by codex, which emits identity via
    // thread/started notification translated to a ThreadEvent).
    function emitTranslatedEvents(
      events: import("@bb/domain").ThreadEvent[],
      sourceThreadId?: string,
    ): void {
      for (const event of events) {
        if (event.type !== "thread/identity" || !event.providerThreadId) {
          continue;
        }

        if (proc.threadIds.has(event.threadId)) {
          threadToProviderThread.set(event.threadId, event.providerThreadId);
          continue;
        }

        if (proc.pendingIdentity.length > 0) {
          const bbThreadId = proc.pendingIdentity.shift()!;
          threadToProviderThread.set(bbThreadId, event.providerThreadId);
        }
      }

      for (const event of events) {
        // Stamp every event with the bb threadId and providerThreadId.
        // The adapter may set threadId to "" or the provider's internal ID.
        // The runtime resolves the correct bb threadId using its mappings.
        const eventRecord = event as Record<string, unknown>;

        // Resolve bb threadId:
        // 1. If sourceThreadId (from JSON-RPC params) is a bb threadId, use it
        // 2. If the event's threadId is a bb threadId, use it
        // 3. If the event's threadId is a providerThreadId, reverse-map it
        // 4. If only one thread on this process, use it
        let resolvedBbThreadId: string | undefined;
        if (sourceThreadId && proc.threadIds.has(sourceThreadId)) {
          resolvedBbThreadId = sourceThreadId;
        } else if (event.threadId && proc.threadIds.has(event.threadId)) {
          resolvedBbThreadId = event.threadId;
        } else {
          // Reverse-map: event.threadId or sourceThreadId might be a provider ID
          const lookupId = sourceThreadId || event.threadId;
          if (lookupId) {
            for (const [bbId, provId] of threadToProviderThread) {
              if (provId === lookupId && proc.threadIds.has(bbId)) {
                resolvedBbThreadId = bbId;
                break;
              }
            }
          }
        }
        if (!resolvedBbThreadId && proc.threadIds.size === 1) {
          resolvedBbThreadId = [...proc.threadIds][0];
        }

        if (resolvedBbThreadId) {
          eventRecord.threadId = resolvedBbThreadId;
        }

        // Always stamp providerThreadId from the mapping
        if (resolvedBbThreadId) {
          const provId = threadToProviderThread.get(resolvedBbThreadId);
          if (provId) {
            eventRecord.providerThreadId = provId;
          }
        }

        if (
          typeof eventRecord.threadId !== "string" ||
          eventRecord.threadId.length === 0
        ) {
          options.onStderr?.(
            `Dropping unscoped provider event ${event.type}; no bb thread could be resolved`,
          );
          continue;
        }

        options.onEvent(event);
      }
    }

    // JSON-RPC notification (no id, has method) — provider event.
    // The runtime does NOT interpret notification content — it delegates
    // entirely to the adapter's translateEvent. Each adapter knows its
    // own wire format (codex sends direct notifications, bridges wrap
    // SDK messages in sdk/message envelopes, etc.).
    if (parsed.method) {
      // Extract source threadId from the notification params if available.
      // Bridges include threadId in params; codex notifications may not.
      const params = parsed.params as Record<string, unknown> | undefined;
      const sourceThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
      emitTranslatedEvents(proc.adapter.translateEvent(parsed, { threadId: sourceThreadId }), sourceThreadId);
    }
  }

  function spawnProvider(
    providerId: string,
    adapter: ProviderAdapter,
  ): ProviderProcess {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...options.env,
    };

    const child = spawn(adapter.process.command, adapter.process.args, {
      cwd: options.workspacePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const proc: ProviderProcess = {
      child,
      adapter,
      pending: new Map(),
      threadIds: new Set(),
      stderrChunks: [],
      pendingIdentity: [],
    };

    // Read stdout line by line
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => handleStdoutLine(line, proc));

    // Forward stderr
    if (child.stderr) {
      const stderrRl = createInterface({ input: child.stderr });
      stderrRl.on("line", (line) => {
        proc.stderrChunks.push(line);
        options.onStderr?.(line);
      });
    }

    // Handle spawn errors (e.g., binary not found)
    child.on("error", (err) => {
      if (shuttingDown) return;
      processes.delete(providerId);
      for (const [, pending] of proc.pending) {
        pending.reject(new Error(`Provider "${providerId}" failed to start: ${err.message}`));
      }
      proc.pending.clear();
      proc.pendingIdentity = [];

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
      }
      proc.pendingIdentity = [];
      // Reject any pending requests
      for (const [, pending] of proc.pending) {
        pending.reject(new Error(`Provider "${providerId}" exited unexpectedly`));
      }
      proc.pending.clear();

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
          await sendRequest(proc.child, initCmd, proc.pending, () => nextRequestId++);
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
      threadId,
      projectId,
      providerId,
      input,
      options: execOpts,
      dynamicTools,
    }) {
      const pid = providerId ?? "codex";
      await runtime.ensureProvider({ providerId: pid });

      const proc = requireProviderProcess(pid);
      threadToProvider.set(threadId, pid);
      proc.threadIds.add(threadId);
      proc.pendingIdentity.push(threadId);

      const envVars: Record<string, string> = {
        BB_PROJECT_ID: projectId,
        BB_THREAD_ID: threadId,
      };

      const cmd = proc.adapter.buildCommand({
        type: "thread/start",
        threadId,
        options: toAdapterOptions(execOpts, envVars),
        dynamicTools,
      });

      if (!cmd) {
        throw new Error(`Adapter "${pid}" returned null for thread/start`);
      }

      const result = await sendRequest(proc.child, cmd, proc.pending, () => nextRequestId++);
      const res = result as { threadId?: string; providerThreadId?: string } | undefined;
      const providerThreadId =
        res?.providerThreadId ?? res?.threadId ?? undefined;
      if (providerThreadId) {
        threadToProviderThread.set(threadId, providerThreadId);
      }

      // Allow any pending notifications (e.g. codex thread/started carrying the
      // real provider thread ID) to be processed before returning.
      if (!threadToProviderThread.has(threadId)) {
        await new Promise<void>((resolve) => {
          const start = Date.now();
          const check = () => {
            if (threadToProviderThread.has(threadId) || Date.now() - start > 5000 || proc.child.exitCode !== null) {
              resolve();
              return;
            }
            setTimeout(check, 50);
          };
          check();
        });
      }

      const resolved = threadToProviderThread.get(threadId);
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
        });
      }

      return { providerThreadId: resolved };
    },

    async resumeThread({
      threadId,
      projectId,
      providerThreadId,
      providerId,
      options: execOpts,
      resumePath,
      dynamicTools,
    }) {
      const pid = providerId ?? resolveProviderForThread(threadId);
      await runtime.ensureProvider({ providerId: pid });

      const proc = requireProviderProcess(pid);
      threadToProvider.set(threadId, pid);
      proc.threadIds.add(threadId);

      if (providerThreadId) {
        threadToProviderThread.set(threadId, providerThreadId);
      } else {
        proc.pendingIdentity.push(threadId);
      }

      const envVars: Record<string, string> = {
        BB_THREAD_ID: threadId,
        ...(projectId ? { BB_PROJECT_ID: projectId } : {}),
      };

      const cmd = proc.adapter.buildCommand({
        type: "thread/resume",
        threadId,
        providerThreadId:
          providerThreadId ?? threadToProviderThread.get(threadId),
        options: toAdapterOptions(execOpts, envVars),
        resumePath,
        dynamicTools,
      });

      if (!cmd) return { providerThreadId: undefined };

      const result = await sendRequest(proc.child, cmd, proc.pending, () => nextRequestId++);
      const res = result as { threadId?: string; providerThreadId?: string } | undefined;
      const resolvedId = res?.providerThreadId ?? res?.threadId;
      if (resolvedId) {
        threadToProviderThread.set(threadId, resolvedId);
      }

      return { providerThreadId: resolvedId };
    },

    async runTurn({ threadId, input, options: execOpts }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);

      const cmd = proc.adapter.buildCommand({
        type: "turn/start",
        threadId,
        providerThreadId: threadToProviderThread.get(threadId),
        input,
        options: toAdapterOptions(execOpts, {}),
      });

      if (!cmd) return;
      await sendRequest(proc.child, cmd, proc.pending, () => nextRequestId++);
    },

    async steerTurn({ threadId, expectedTurnId, input }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);

      const cmd = proc.adapter.buildCommand({
        type: "turn/steer",
        threadId,
        providerThreadId: threadToProviderThread.get(threadId),
        expectedTurnId,
        input,
      });

      if (!cmd) return;
      sendJsonRpc(proc.child, { ...cmd, id: nextRequestId++ } as JsonRpcMessage);
    },

    async stopThread({ threadId }) {
      const pid = resolveProviderForThread(threadId);
      const proc = requireProviderProcess(pid);

      const cmd = proc.adapter.buildCommand({
        type: "thread/stop",
        threadId,
      });

      if (cmd) {
        sendJsonRpc(proc.child, { ...cmd, id: nextRequestId++ } as JsonRpcMessage);
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
      await sendRequest(proc.child, cmd, proc.pending, () => nextRequestId++);
    },

    async listModels({ providerId }) {
      await runtime.ensureProvider({ providerId });
      const proc = requireProviderProcess(providerId);
      return proc.adapter.listModels();
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

        // Clean up mappings
        for (const tid of proc.threadIds) {
          threadToProvider.delete(tid);
          threadToProviderThread.delete(tid);
        }
        proc.pendingIdentity = [];
        processes.delete(providerId);
      }

      await Promise.all(shutdownPromises);
    },
  };

  return runtime;
}
