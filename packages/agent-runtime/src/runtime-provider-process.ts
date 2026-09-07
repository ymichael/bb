import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  sanitizeInheritedChildProcessEnv,
  killProcessGroup,
  spawnPortablePipedProcess,
  stopProcessGroupLeaderFirst,
  supportsProcessGroups,
} from "@bb/process-utils";
import type { BridgeProtocolAdapter } from "./bridge-protocol-adapter.js";
import type { CreateBridgeAdapterOptions } from "./provider-adapter.js";
import { createProviderForId } from "./provider-registry.js";
import {
  ignoredJsonRpcResultSchema,
  PROVIDER_BRIDGE_RECORD_DIR_ENV,
  readBoundedLines,
  type PendingJsonRpcRequest,
  sendJsonRpcRequest,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { RuntimeProviderIdentityState } from "./runtime-thread-identity.js";
import type {
  AgentRuntimeBridgeLaunch,
  AgentRuntimeOptions,
  AgentRuntimeProcessExitThreadState,
  AgentRuntimeSkillRoot,
} from "./types.js";

export interface RuntimeProviderProcess {
  adapter: BridgeProtocolAdapter;
  child: ChildProcess;
  expectedShutdownExpectations: number;
  exitFinalized: Promise<void>;
  identity: RuntimeProviderIdentityState;
  interactiveRequestScope: string;
  pending: Map<string | number, PendingJsonRpcRequest>;
  processKey: string;
  providerId: string;
  stderrLineTail: Buffer;
  stderrTail: Buffer;
}

interface RuntimeProviderProcessLineArgs {
  line: string;
  providerProcess: RuntimeProviderProcess;
}

interface RuntimeProviderProcessManagerArgs {
  additionalWorkspaceWriteRoots: readonly string[];
  createAdapter?: (
    providerId: string,
    options: CreateBridgeAdapterOptions,
  ) => BridgeProtocolAdapter;
  bridgeBundleDir: string | undefined;
  bridgeNodeEnv?: Record<string, string>;
  bridgeNodeExecutablePath?: string;
  captureThreadExitState: (
    threadId: string,
  ) => AgentRuntimeProcessExitThreadState;
  createProviderIdentityState: (
    providerId: string,
  ) => RuntimeProviderIdentityState;
  env: Record<string, string> | undefined;
  getNextRequestId: () => number;
  handleStdoutLine: (args: RuntimeProviderProcessLineArgs) => void;
  onProcessExit: AgentRuntimeOptions["onProcessExit"];
  onProviderThreadDetached: (threadId: string) => void;
  onStderr: AgentRuntimeOptions["onStderr"];
  skillRoots: readonly AgentRuntimeSkillRoot[];
  workspacePath: string;
}

interface EnsureRuntimeProviderArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  processKey: string;
  providerId: string;
}

interface RequireRuntimeProviderProcessArgs {
  processKey: string;
  providerId: string;
}

interface ShutdownRuntimeProviderArgs {
  processKey: string;
  providerId: string;
  timeoutMs?: number;
}

interface CleanupFailedStartupArgs {
  processKey: string;
  providerId: string;
  providerProcess: RuntimeProviderProcess;
  startupError: Error;
}

interface TerminateProviderProcessArgs {
  providerProcess: RuntimeProviderProcess;
  timeoutMs?: number;
}

interface SpawnProviderArgs {
  adapter: BridgeProtocolAdapter;
  processKey: string;
  providerId: string;
}

interface ProviderProcessExitStatus {
  code: number | null;
  signal: string | null;
}

interface ProviderProcessExitedErrorArgs {
  providerId: string;
  status: ProviderProcessExitStatus;
  stderrTail: Buffer;
}

const PROVIDER_STDERR_TAIL_MAX_BYTES = 4_000;
const PROVIDER_PROCESS_CLOSE_GRACE_MS = 1_000;

class ProviderProcessExitedError extends Error {
  constructor(args: ProviderProcessExitedErrorArgs) {
    const stderr = formatProviderStderr(args.stderrTail);
    super(
      `Provider "${args.providerId}" exited unexpectedly (${formatProviderProcessExitStatus(args.status)})` +
        (stderr ? `\nstderr: ${stderr}` : ""),
    );
    this.name = "ProviderProcessExitedError";
  }
}

export class RuntimeProviderProcessManager {
  private readonly args: RuntimeProviderProcessManagerArgs;
  private readonly processes = new Map<string, RuntimeProviderProcess>();
  private readonly providerStarting = new Map<string, Promise<void>>();
  private readonly providerRetiring = new Map<string, Promise<void>>();
  private readonly currentProcessKeyByProviderId = new Map<string, string>();
  private shuttingDown = false;

  constructor(args: RuntimeProviderProcessManagerArgs) {
    this.args = args;
  }

  async ensureProvider(args: EnsureRuntimeProviderArgs): Promise<void> {
    if (this.shuttingDown) return;
    const retirement = this.providerRetiring.get(args.processKey);
    if (retirement !== undefined) {
      await retirement;
      if (this.shuttingDown) return;
    }

    const existing = this.providerStarting.get(args.processKey);
    if (existing) {
      await existing;
      return;
    }

    const existingProcess = this.processes.get(args.processKey);
    if (existingProcess !== undefined) {
      if (!hasChildProcessExited(existingProcess.child)) return;
      await existingProcess.exitFinalized;
      if (this.shuttingDown) return;

      const concurrentStart = this.providerStarting.get(args.processKey);
      if (concurrentStart !== undefined) {
        await concurrentStart;
        return;
      }
      if (this.processes.has(args.processKey)) return;
    }

    const startPromise = (async () => {
      const adapter = this.getAdapter(args.providerId, args.bridgeLaunch);
      const providerProcess = this.spawnProvider({
        adapter,
        processKey: args.processKey,
        providerId: args.providerId,
      });

      try {
        if (hasChildProcessExited(providerProcess.child)) {
          const stderr = formatProviderStderr(
            providerProcess.stderrTail,
          )?.slice(0, 500);
          throw new Error(
            `Provider "${args.providerId}" exited during startup with ${formatChildProcessExitStatus(providerProcess.child)}` +
              (stderr ? `\nstderr: ${stderr}` : ""),
          );
        }

        for (const request of adapter.buildPostInitializeRequests()) {
          try {
            const result = await sendJsonRpcRequest({
              child: providerProcess.child,
              message: request.plan,
              pending: providerProcess.pending,
              getNextId: this.args.getNextRequestId,
              resultSchema: ignoredJsonRpcResultSchema,
            });
            request.onResult(result);
          } catch (error) {
            if (this.shuttingDown) return;
            if (request.required) throw error;
          }
        }

        if (this.args.skillRoots.length > 0) {
          const skillRootsCmd = adapter.buildCommandPlan({
            type: "skills/configure",
            skillRoots: this.args.skillRoots,
          });
          if (skillRootsCmd.kind === "request") {
            await sendJsonRpcRequest({
              child: providerProcess.child,
              message: skillRootsCmd,
              pending: providerProcess.pending,
              getNextId: this.args.getNextRequestId,
              resultSchema: ignoredJsonRpcResultSchema,
            });
          }
        }
      } catch (startupError) {
        if (this.shuttingDown) return;
        await this.cleanupFailedStartup({
          processKey: args.processKey,
          providerId: args.providerId,
          providerProcess,
          startupError:
            startupError instanceof Error
              ? startupError
              : new Error(String(startupError)),
        });
        throw startupError;
      }
    })();

    this.providerStarting.set(args.processKey, startPromise);
    try {
      await startPromise;
    } finally {
      if (this.providerStarting.get(args.processKey) === startPromise) {
        this.providerStarting.delete(args.processKey);
      }
    }
    await this.retireStaleBridgeProcesses(args);
  }

  private async retireStaleBridgeProcesses(
    args: EnsureRuntimeProviderArgs,
  ): Promise<void> {
    this.currentProcessKeyByProviderId.set(args.providerId, args.processKey);
    const staleKeys = [...this.processes.entries()]
      .filter(
        ([processKey, providerProcess]) =>
          processKey !== args.processKey &&
          providerProcess.providerId === args.providerId &&
          providerProcess.identity.threadIds.size === 0,
      )
      .map(([processKey]) => processKey);

    for (const processKey of staleKeys) {
      await this.shutdownProvider({ processKey, providerId: args.providerId });
    }
  }

  requireProviderProcess(
    args: RequireRuntimeProviderProcessArgs,
  ): RuntimeProviderProcess {
    const providerProcess = this.processes.get(args.processKey);
    if (!providerProcess) {
      throw new Error(`Provider "${args.providerId}" is not running`);
    }
    if (hasChildProcessExited(providerProcess.child)) {
      throw new Error(
        `Provider "${args.providerId}" has exited (${formatChildProcessExitStatus(providerProcess.child)})`,
      );
    }
    return providerProcess;
  }

  listRunningProviders(): string[] {
    return [
      ...new Set(
        [...this.processes.values()]
          .filter((proc) => !hasChildProcessExited(proc.child))
          .map((proc) => proc.providerId),
      ),
    ];
  }

  async shutdownProvider(args: ShutdownRuntimeProviderArgs): Promise<void> {
    const existingRetirement = this.providerRetiring.get(args.processKey);
    if (existingRetirement !== undefined) return existingRetirement;

    const providerProcess = this.processes.get(args.processKey);
    if (!providerProcess) {
      return;
    }

    if (hasChildProcessExited(providerProcess.child)) {
      await providerProcess.exitFinalized;
      return;
    }

    providerProcess.expectedShutdownExpectations += 1;
    const retirement = this.terminateProviderProcess({
      providerProcess,
      timeoutMs: args.timeoutMs,
    }).then(async () => {
      if (hasChildProcessExited(providerProcess.child)) {
        await providerProcess.exitFinalized;
      }
    });
    this.providerRetiring.set(args.processKey, retirement);
    await retirement.finally(() => {
      if (this.providerRetiring.get(args.processKey) === retirement) {
        this.providerRetiring.delete(args.processKey);
      }
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const shutdownPromises: Promise<void>[] = [];

    for (const [processKey, providerProcess] of this.processes) {
      if (!hasChildProcessExited(providerProcess.child)) {
        shutdownPromises.push(
          stopProcessGroupLeaderFirst({
            child: providerProcess.child,
            timeoutMs: 5000,
            killGraceMs: 0,
          }),
        );
      }
      for (const [, pending] of providerProcess.pending) {
        pending.reject(new Error("Runtime shutting down"));
      }
      providerProcess.pending.clear();

      for (const threadId of providerProcess.identity.threadIds) {
        this.args.onProviderThreadDetached(threadId);
      }
      this.processes.delete(processKey);
    }

    await Promise.all(shutdownPromises);
  }

  private getAdapter(
    providerId: string,
    bridgeLaunch: AgentRuntimeBridgeLaunch,
  ): BridgeProtocolAdapter {
    const adapterOptions = {
      additionalWorkspaceWriteRoots: this.args.additionalWorkspaceWriteRoots,
      bridgeLaunch,
      bridgeBundleDir: this.args.bridgeBundleDir,
      ...(this.args.bridgeNodeEnv !== undefined
        ? { bridgeNodeEnv: this.args.bridgeNodeEnv }
        : {}),
      ...(this.args.bridgeNodeExecutablePath !== undefined
        ? { bridgeNodeExecutablePath: this.args.bridgeNodeExecutablePath }
        : {}),
    };

    return (this.args.createAdapter ?? createProviderForId)(
      providerId,
      adapterOptions,
    );
  }

  private spawnProvider(args: SpawnProviderArgs): RuntimeProviderProcess {
    const processConfig = args.adapter.process;
    const env: NodeJS.ProcessEnv = {
      ...sanitizeInheritedChildProcessEnv({ env: process.env }),
      ...this.args.env,
      ...processConfig.env,
    };
    const recordRoot = env[PROVIDER_BRIDGE_RECORD_DIR_ENV];
    if (recordRoot !== undefined && recordRoot !== "") {
      env[PROVIDER_BRIDGE_RECORD_DIR_ENV] = join(recordRoot, args.providerId);
    }

    const child = spawnPortablePipedProcess({
      command: processConfig.command,
      args: processConfig.args,
      cwd: this.args.workspacePath,
      detached: supportsProcessGroups(),
      env,
    });
    let finalizeExit: () => void = () => undefined;
    const exitFinalized = new Promise<void>((resolve) => {
      finalizeExit = resolve;
    });

    const providerProcess: RuntimeProviderProcess = {
      child,
      adapter: args.adapter,
      expectedShutdownExpectations: 0,
      exitFinalized,
      interactiveRequestScope: randomUUID(),
      identity: this.args.createProviderIdentityState(args.providerId),
      pending: new Map(),
      processKey: args.processKey,
      providerId: args.providerId,
      stderrLineTail: Buffer.alloc(0),
      stderrTail: Buffer.alloc(0),
    };

    readBoundedLines({
      input: child.stdout,
      onLine: (line) => {
        if (
          this.shuttingDown ||
          !this.isCurrentProviderProcess({ providerProcess })
        ) {
          return;
        }
        this.args.handleStdoutLine({
          line,
          providerProcess,
        });
      },
      onOverflow: (bytes) => {
        this.args.onStderr?.(
          `Discarded an oversized JSON-RPC line (${bytes} bytes) from provider "${args.providerId}".`,
        );
      },
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (
        this.shuttingDown ||
        !this.isCurrentProviderProcess({ providerProcess })
      ) {
        return;
      }
      consumeProviderStderrChunk({
        chunk,
        onLine: this.args.onStderr,
        providerProcess,
      });
    });
    child.stderr.on("end", () => {
      if (
        this.shuttingDown ||
        !this.isCurrentProviderProcess({ providerProcess }) ||
        providerProcess.stderrLineTail.length === 0
      ) {
        return;
      }
      this.args.onStderr?.(decodeStderrLine(providerProcess.stderrLineTail));
      providerProcess.stderrLineTail = Buffer.alloc(0);
    });

    child.on("error", (err) => {
      this.handleProviderProcessError({
        err,
        providerId: args.providerId,
        providerProcess,
      });
    });
    let exitStatus: ProviderProcessExitStatus | null = null;
    let closeGraceTimer: NodeJS.Timeout | null = null;
    let exitHandled = false;
    const handleExit = (status: ProviderProcessExitStatus): void => {
      if (exitHandled) return;
      exitHandled = true;
      if (closeGraceTimer !== null) {
        clearTimeout(closeGraceTimer);
      }
      try {
        this.handleProviderProcessExit({
          code: status.code,
          providerId: args.providerId,
          providerProcess,
          signal: status.signal,
        });
      } finally {
        finalizeExit();
      }
    };

    child.on("exit", (code, signal) => {
      const status = {
        code: code ?? null,
        signal: signal ?? null,
      };
      exitStatus = status;
      closeGraceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        handleExit(status);
      }, PROVIDER_PROCESS_CLOSE_GRACE_MS);
      closeGraceTimer.unref();
    });
    child.on("close", (code, signal) => {
      handleExit(
        exitStatus ?? {
          code: code ?? null,
          signal: signal ?? null,
        },
      );
    });

    this.processes.set(args.processKey, providerProcess);
    return providerProcess;
  }

  private async cleanupFailedStartup(
    args: CleanupFailedStartupArgs,
  ): Promise<void> {
    if (this.processes.get(args.processKey) !== args.providerProcess) {
      return;
    }

    this.processes.delete(args.processKey);
    args.providerProcess.expectedShutdownExpectations += 1;
    for (const [, pending] of args.providerProcess.pending) {
      pending.reject(args.startupError);
    }
    args.providerProcess.pending.clear();

    await this.terminateProviderProcess({
      providerProcess: args.providerProcess,
    });
  }

  private async terminateProviderProcess(
    args: TerminateProviderProcessArgs,
  ): Promise<void> {
    if (hasChildProcessExited(args.providerProcess.child)) {
      return;
    }

    await stopProcessGroupLeaderFirst({
      child: args.providerProcess.child,
      timeoutMs: args.timeoutMs ?? 5000,
      killGraceMs: 1000,
    });
  }

  private handleProviderProcessError(args: ProviderProcessErrorArgs): void {
    if (this.shuttingDown) return;
    if (!this.isCurrentProviderProcess(args)) return;
    const expected = consumeExpectedProviderProcessShutdown(
      args.providerProcess,
    );
    this.processes.delete(args.providerProcess.processKey);
    const message = args.err.message;
    for (const [, pending] of args.providerProcess.pending) {
      pending.reject(
        new Error(`Provider "${args.providerId}" failed to start: ${message}`),
      );
    }
    args.providerProcess.pending.clear();

    this.args.onProcessExit?.({
      providerId: args.providerId,
      threads: [...args.providerProcess.identity.threadIds].map((threadId) =>
        this.args.captureThreadExitState(threadId),
      ),
      code: null,
      expected,
      signal: null,
      stderr: null,
    });
  }

  private handleProviderProcessExit(args: ProviderProcessExitArgs): void {
    if (this.shuttingDown) return;
    if (!this.isCurrentProviderProcess(args)) return;
    const expected = consumeExpectedProviderProcessShutdown(
      args.providerProcess,
    );
    this.processes.delete(args.providerProcess.processKey);
    if (!expected) {
      killProcessGroup({
        child: args.providerProcess.child,
        signal: "SIGTERM",
      });
    }
    const threadIds = [...args.providerProcess.identity.threadIds];
    const threads = threadIds.map((threadId) =>
      this.args.captureThreadExitState(threadId),
    );
    for (const threadId of threadIds) {
      this.args.onProviderThreadDetached(threadId);
    }
    for (const [, pending] of args.providerProcess.pending) {
      pending.reject(
        new ProviderProcessExitedError({
          providerId: args.providerId,
          status: { code: args.code, signal: args.signal },
          stderrTail: args.providerProcess.stderrTail,
        }),
      );
    }
    args.providerProcess.pending.clear();

    this.args.onProcessExit?.({
      providerId: args.providerId,
      threads,
      code: args.code,
      expected,
      signal: args.signal,
      stderr: formatProviderStderr(args.providerProcess.stderrTail),
    });
  }

  private isCurrentProviderProcess(
    args: Pick<ProviderProcessExitArgs, "providerProcess">,
  ): boolean {
    return (
      this.processes.get(args.providerProcess.processKey) ===
      args.providerProcess
    );
  }
}

export function hasChildProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function getChildProcessExitStatus(
  child: ChildProcess,
): ProviderProcessExitStatus {
  return { code: child.exitCode, signal: child.signalCode };
}

function formatChildProcessExitStatus(child: ChildProcess): string {
  return formatProviderProcessExitStatus(getChildProcessExitStatus(child));
}

function formatProviderProcessExitStatus(
  status: ProviderProcessExitStatus,
): string {
  if (status.code !== null) {
    return `code ${status.code}`;
  }
  if (status.signal !== null) {
    return `signal ${status.signal}`;
  }
  return "unknown status";
}

function formatProviderStderr(stderrTail: Buffer): string | null {
  const stderr = stderrTail.toString("utf8").trim();
  if (stderr.length === 0) {
    return null;
  }
  return stderr;
}

function appendBoundedStderrBytes(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= PROVIDER_STDERR_TAIL_MAX_BYTES) {
    return Buffer.from(
      chunk.subarray(chunk.length - PROVIDER_STDERR_TAIL_MAX_BYTES),
    );
  }
  const currentBytesToKeep = Math.min(
    current.length,
    PROVIDER_STDERR_TAIL_MAX_BYTES - chunk.length,
  );
  return Buffer.concat([
    current.subarray(current.length - currentBytesToKeep),
    chunk,
  ]);
}

function decodeStderrLine(line: Buffer): string {
  const end = line.at(-1) === 0x0d ? line.length - 1 : line.length;
  return line.toString("utf8", 0, end);
}

function consumeProviderStderrChunk(args: {
  chunk: Buffer;
  onLine: AgentRuntimeOptions["onStderr"];
  providerProcess: RuntimeProviderProcess;
}): void {
  args.providerProcess.stderrTail = appendBoundedStderrBytes(
    args.providerProcess.stderrTail,
    args.chunk,
  );

  let offset = 0;
  let newline = args.chunk.indexOf(0x0a, offset);
  while (newline !== -1) {
    args.providerProcess.stderrLineTail = appendBoundedStderrBytes(
      args.providerProcess.stderrLineTail,
      args.chunk.subarray(offset, newline),
    );
    args.onLine?.(decodeStderrLine(args.providerProcess.stderrLineTail));
    args.providerProcess.stderrLineTail = Buffer.alloc(0);
    offset = newline + 1;
    newline = args.chunk.indexOf(0x0a, offset);
  }

  if (offset < args.chunk.length) {
    args.providerProcess.stderrLineTail = appendBoundedStderrBytes(
      args.providerProcess.stderrLineTail,
      args.chunk.subarray(offset),
    );
  }
}

function consumeExpectedProviderProcessShutdown(
  providerProcess: RuntimeProviderProcess,
): boolean {
  const expected = providerProcess.expectedShutdownExpectations > 0;
  providerProcess.expectedShutdownExpectations = 0;
  return expected;
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
