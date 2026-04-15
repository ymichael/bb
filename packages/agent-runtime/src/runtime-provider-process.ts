import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { spawnPortablePipedProcess } from "@bb/process-utils";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { createProviderForId } from "./provider-registry.js";
import {
  ignoredJsonRpcResultSchema,
  type PendingJsonRpcRequest,
  sendJsonRpcRequest,
} from "./runtime-json-rpc.js";
import type { RuntimeProviderIdentityState } from "./runtime-thread-identity.js";
import type { AgentRuntimeOptions } from "./types.js";

export interface RuntimeProviderProcess {
  adapter: ProviderAdapter;
  child: ChildProcess;
  identity: RuntimeProviderIdentityState;
  interactiveRequestScope: string;
  pending: Map<string | number, PendingJsonRpcRequest>;
  stderrChunks: string[];
}

export interface RuntimeProviderProcessLineArgs {
  line: string;
  providerProcess: RuntimeProviderProcess;
}

export interface RuntimeProviderProcessManagerArgs {
  adapterFactory: AgentRuntimeOptions["adapterFactory"];
  bridgeBundleDir: string | undefined;
  createProviderIdentityState: (providerId: string) => RuntimeProviderIdentityState;
  emitCapture: (entry: AgentRuntimeCaptureEntry) => void;
  env: Record<string, string> | undefined;
  getNextRequestId: () => number;
  handleStdoutLine: (args: RuntimeProviderProcessLineArgs) => void;
  onProcessExit: AgentRuntimeOptions["onProcessExit"];
  onProviderIdentityWaitersInterrupted: (
    providerProcess: RuntimeProviderProcess,
  ) => void;
  onProviderThreadDetached: (threadId: string) => void;
  onStderr: AgentRuntimeOptions["onStderr"];
  workspacePath: string;
}

export interface EnsureRuntimeProviderArgs {
  providerId: string;
}

export interface ShutdownRuntimeProviderArgs {
  providerId: string;
  timeoutMs?: number;
}

function createAdapterTurnIdPrefix(): string {
  const adapterId = randomUUID().replaceAll("-", "").slice(0, 16);
  return `turn_${adapterId}_`;
}

export class RuntimeProviderProcessManager {
  private readonly args: RuntimeProviderProcessManagerArgs;
  private readonly processes = new Map<string, RuntimeProviderProcess>();
  private readonly providerStarting = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(args: RuntimeProviderProcessManagerArgs) {
    this.args = args;
  }

  async ensureProvider(args: EnsureRuntimeProviderArgs): Promise<void> {
    if (this.processes.has(args.providerId)) return;

    const existing = this.providerStarting.get(args.providerId);
    if (existing) {
      await existing;
      return;
    }

    const startPromise = (async () => {
      const adapter = this.getAdapter(args.providerId);
      const providerProcess = this.spawnProvider(args.providerId, adapter);

      if (providerProcess.child.exitCode !== null) {
        this.processes.delete(args.providerId);
        const stderr = providerProcess.stderrChunks.join("\n").slice(0, 500);
        throw new Error(
          `Provider "${args.providerId}" exited during startup with code ${providerProcess.child.exitCode}` +
          (stderr ? `\nstderr: ${stderr}` : ""),
        );
      }

      const initCmd = adapter.buildCommand({ type: "initialize" });
      if (initCmd) {
        await sendJsonRpcRequest({
          child: providerProcess.child,
          message: initCmd,
          pending: providerProcess.pending,
          getNextId: this.args.getNextRequestId,
          resultSchema: ignoredJsonRpcResultSchema,
        });
      }
    })();

    this.providerStarting.set(args.providerId, startPromise);
    try {
      await startPromise;
    } finally {
      this.providerStarting.delete(args.providerId);
    }
  }

  requireProviderProcess(providerId: string): RuntimeProviderProcess {
    const providerProcess = this.processes.get(providerId);
    if (!providerProcess) {
      throw new Error(`Provider "${providerId}" is not running`);
    }
    if (providerProcess.child.exitCode !== null) {
      this.processes.delete(providerId);
      throw new Error(
        `Provider "${providerId}" has exited (code ${providerProcess.child.exitCode})`,
      );
    }
    return providerProcess;
  }

  listRunningProviders(): string[] {
    return [...this.processes.keys()];
  }

  async shutdownProvider(args: ShutdownRuntimeProviderArgs): Promise<void> {
    const providerProcess = this.processes.get(args.providerId);
    if (!providerProcess || providerProcess.child.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const softTimer = setTimeout(() => {
        if (providerProcess.child.exitCode === null) {
          providerProcess.child.kill("SIGKILL");
        }
      }, args.timeoutMs ?? 5000);
      const hardTimer = setTimeout(resolve, (args.timeoutMs ?? 5000) + 1000);

      providerProcess.child.once("exit", () => {
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        resolve();
      });

      providerProcess.child.kill("SIGTERM");
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const shutdownPromises: Promise<void>[] = [];

    for (const [providerId, providerProcess] of this.processes) {
      shutdownPromises.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            providerProcess.child.kill("SIGKILL");
            resolve();
          }, 5000);

          providerProcess.child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });

          providerProcess.child.kill("SIGTERM");
        }),
      );
      for (const [, pending] of providerProcess.pending) {
        pending.reject(new Error("Runtime shutting down"));
      }
      providerProcess.pending.clear();
      this.args.onProviderIdentityWaitersInterrupted(providerProcess);

      for (const threadId of providerProcess.identity.threadIds) {
        this.args.onProviderThreadDetached(threadId);
      }
      this.processes.delete(providerId);
    }

    await Promise.all(shutdownPromises);
  }

  private getAdapter(providerId: string): ProviderAdapter {
    if (this.args.adapterFactory) {
      return this.args.adapterFactory(providerId);
    }
    return createProviderForId(providerId, {
      bridgeBundleDir: this.args.bridgeBundleDir,
      turnIdPrefix: createAdapterTurnIdPrefix(),
    });
  }

  private spawnProvider(
    providerId: string,
    adapter: ProviderAdapter,
  ): RuntimeProviderProcess {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.args.env,
    };

    const child = spawnPortablePipedProcess({
      command: adapter.process.command,
      args: adapter.process.args,
      cwd: this.args.workspacePath,
      env,
    });

    const providerProcess: RuntimeProviderProcess = {
      child,
      adapter,
      interactiveRequestScope: randomUUID(),
      identity: this.args.createProviderIdentityState(providerId),
      pending: new Map(),
      stderrChunks: [],
    };

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      this.args.handleStdoutLine({
        line,
        providerProcess,
      });
    });

    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      providerProcess.stderrChunks.push(line);
      this.args.onStderr?.(line);
      this.args.emitCapture({
        kind: "provider-stderr",
        capturedAt: Date.now(),
        providerId,
        line,
      });
    });

    child.on("error", (err) => {
      this.handleProviderProcessError({
        err,
        providerId,
        providerProcess,
      });
    });
    child.on("exit", (code, signal) => {
      this.handleProviderProcessExit({
        code: code ?? null,
        providerId,
        providerProcess,
        signal: signal ?? null,
      });
    });

    this.processes.set(providerId, providerProcess);
    return providerProcess;
  }

  private handleProviderProcessError(args: ProviderProcessErrorArgs): void {
    if (this.shuttingDown) return;
    this.processes.delete(args.providerId);
    const message = args.err.message;
    for (const [, pending] of args.providerProcess.pending) {
      pending.reject(
        new Error(
          `Provider "${args.providerId}" failed to start: ${message}`,
        ),
      );
    }
    args.providerProcess.pending.clear();
    this.args.onProviderIdentityWaitersInterrupted(args.providerProcess);

    this.args.emitCapture({
      kind: "provider-process-error",
      capturedAt: Date.now(),
      providerId: args.providerId,
      message,
    });

    this.args.onProcessExit?.({
      providerId: args.providerId,
      threadIds: [...args.providerProcess.identity.threadIds],
      code: null,
      signal: null,
    });
  }

  private handleProviderProcessExit(args: ProviderProcessExitArgs): void {
    if (this.shuttingDown) return;
    this.processes.delete(args.providerId);
    const threadIds = [...args.providerProcess.identity.threadIds];
    for (const threadId of threadIds) {
      this.args.onProviderThreadDetached(threadId);
    }
    for (const [, pending] of args.providerProcess.pending) {
      const stderr = args.providerProcess.stderrChunks.join("\n").slice(0, 500);
      pending.reject(
        new Error(
          `Provider "${args.providerId}" exited unexpectedly` +
          (stderr ? `\nstderr: ${stderr}` : ""),
        ),
      );
    }
    args.providerProcess.pending.clear();
    this.args.onProviderIdentityWaitersInterrupted(args.providerProcess);

    this.args.emitCapture({
      kind: "provider-process-exit",
      capturedAt: Date.now(),
      providerId: args.providerId,
      threadIds,
      code: args.code,
      signal: args.signal,
      stderrChunks: [...args.providerProcess.stderrChunks],
    });

    this.args.onProcessExit?.({
      providerId: args.providerId,
      threadIds,
      code: args.code,
      signal: args.signal,
    });
  }
}

interface ProviderProcessErrorArgs {
  err: Error;
  providerId: string;
  providerProcess: RuntimeProviderProcess;
}

interface ProviderProcessExitArgs {
  code: number | null;
  providerId: string;
  providerProcess: RuntimeProviderProcess;
  signal: string | null;
}
