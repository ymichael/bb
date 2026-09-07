import { spawnPortableProcess } from "@bb/process-utils";
import { resolveSupervisorPidPath } from "./dev-restart-utils.js";
import {
  removePidFileSync,
  writePidFile,
  type WritePidFileRequest,
} from "./pid-file.js";
import {
  installTerminationSignalForwarding,
  killProcessIfRunning,
  type ForwardedSignal,
  type ProcessExitResult,
  waitForProcessExit,
} from "./process-helpers.js";

export interface DevSupervisorChildSpawnRequest {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface ScheduleForcedKillArgs {
  child: DevSupervisorChildProcess;
  forceKillAfterMs: number;
  runtime: DevSupervisorRuntime;
  serviceName: string;
}

export interface DevSupervisorOptions {
  childArgs: string[];
  childCommand: string;
  childCwd: string;
  childEnv?: NodeJS.ProcessEnv;
  unexpectedRestartBackoff: DevSupervisorUnexpectedRestartBackoff;
  serviceName: string;
}

export interface DevSupervisorUnexpectedRestartBackoff {
  initialDelayMs: number;
  maxDelayMs: number;
  stableChildRuntimeMs: number;
}

export interface CalculateUnexpectedRestartDelayArgs {
  attempt: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export type DevSupervisorTimerCallback = () => void;
export type DevSupervisorRestartSignalHandler = () => void;
export type DevSupervisorSignalHandlerCleanup = () => void;
export type DevSupervisorExitHandler = () => void;
export type DevSupervisorTerminationSignalHandler = (
  signal: ForwardedSignal,
) => void;

export interface DevSupervisorChildProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): void;
  waitForExit(): Promise<ProcessExitResult>;
}

export interface DevSupervisorTimer {
  clear(): void;
  unref(): void;
}

export interface DevSupervisorRuntime {
  readonly currentPid: number;
  now(): number;
  setTimeout(
    callback: DevSupervisorTimerCallback,
    delayMs: number,
  ): DevSupervisorTimer;
  spawnChildProcess(
    request: DevSupervisorChildSpawnRequest,
  ): DevSupervisorChildProcess;
  installTerminationSignalForwarding(
    handler: DevSupervisorTerminationSignalHandler,
  ): DevSupervisorSignalHandlerCleanup;
  installRestartSignalHandler(
    handler: DevSupervisorRestartSignalHandler,
  ): DevSupervisorSignalHandlerCleanup;
  registerExitHandler(handler: DevSupervisorExitHandler): void;
  resolvePidPath(serviceName: string): string;
  writePidFile(request: WritePidFileRequest): Promise<void>;
  removePidFileSync(pidPath: string): void;
  writeStdout(message: string): void;
  writeStderr(message: string): void;
  setExitCode(code: number): void;
}

export interface RunDevSupervisorWithRuntimeArgs {
  options: DevSupervisorOptions;
  runtime: DevSupervisorRuntime;
}

interface InterruptibleDelay {
  interrupt(): void;
  wait(delayMs: number): Promise<void>;
}

const DEV_SUPERVISOR_FORCE_KILL_AFTER_MS = 5_000;
export const DEFAULT_UNEXPECTED_RESTART_BACKOFF: DevSupervisorUnexpectedRestartBackoff =
  {
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    stableChildRuntimeMs: 30_000,
  };

function formatExit(code: number, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `signal ${signal}`;
  }

  return `exit code ${code}`;
}

function isChildRunning(child: DevSupervisorChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function calculateUnexpectedRestartDelay(
  args: CalculateUnexpectedRestartDelayArgs,
): number {
  return Math.min(
    args.initialDelayMs * 2 ** Math.max(args.attempt - 1, 0),
    args.maxDelayMs,
  );
}

function formatDurationMs(delayMs: number): string {
  if (delayMs % 1_000 === 0) {
    return `${delayMs / 1_000}s`;
  }

  return `${delayMs}ms`;
}

function scheduleForcedKill(args: ScheduleForcedKillArgs): DevSupervisorTimer {
  const timeout = args.runtime.setTimeout(() => {
    if (!isChildRunning(args.child)) {
      return;
    }

    args.runtime.writeStderr(
      `[dev-supervisor:${args.serviceName}] Child did not exit after ${args.forceKillAfterMs}ms. Forcing shutdown.\n`,
    );
    args.child.kill("SIGKILL");
  }, args.forceKillAfterMs);
  timeout.unref();
  return timeout;
}

function createInterruptibleDelay(
  runtime: DevSupervisorRuntime,
): InterruptibleDelay {
  let activeController: AbortController | null = null;

  return {
    interrupt(): void {
      activeController?.abort();
    },
    async wait(delayMs: number): Promise<void> {
      const controller = new AbortController();
      activeController = controller;

      await new Promise<void>((resolvePromise) => {
        let settled = false;
        let timeout: DevSupervisorTimer | null = null;
        const finish = () => {
          if (settled) {
            return;
          }

          settled = true;
          timeout?.clear();
          controller.signal.removeEventListener("abort", finish);
          if (activeController === controller) {
            activeController = null;
          }
          resolvePromise();
        };

        timeout = runtime.setTimeout(finish, delayMs);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
    },
  };
}

function createNodeTimer(
  callback: DevSupervisorTimerCallback,
  delayMs: number,
): DevSupervisorTimer {
  const timeout = setTimeout(callback, delayMs);
  return {
    clear(): void {
      clearTimeout(timeout);
    },
    unref(): void {
      timeout.unref();
    },
  };
}

function spawnNodeChildProcess(
  request: DevSupervisorChildSpawnRequest,
): DevSupervisorChildProcess {
  const child = spawnPortableProcess({
    args: request.args,
    command: request.command,
    cwd: request.cwd,
    env: {
      ...process.env,
      ...request.env,
    },
    stdio: "inherit",
  });

  return {
    get exitCode(): number | null {
      return child.exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return child.signalCode;
    },
    kill(signal: NodeJS.Signals): void {
      killProcessIfRunning(child, signal);
    },
    waitForExit(): Promise<ProcessExitResult> {
      return waitForProcessExit(child);
    },
  };
}

function createNodeDevSupervisorRuntime(): DevSupervisorRuntime {
  return {
    currentPid: process.pid,
    now: () => Date.now(),
    setTimeout: createNodeTimer,
    spawnChildProcess: spawnNodeChildProcess,
    installTerminationSignalForwarding,
    installRestartSignalHandler(
      handler: DevSupervisorRestartSignalHandler,
    ): DevSupervisorSignalHandlerCleanup {
      process.on("SIGUSR1", handler);
      return () => {
        process.off("SIGUSR1", handler);
      };
    },
    registerExitHandler(handler: DevSupervisorExitHandler): void {
      process.on("exit", handler);
    },
    resolvePidPath: resolveSupervisorPidPath,
    writePidFile,
    removePidFileSync,
    writeStdout(message: string): void {
      process.stdout.write(message);
    },
    writeStderr(message: string): void {
      process.stderr.write(message);
    },
    setExitCode(code: number): void {
      process.exitCode = code;
    },
  };
}

export async function runDevSupervisor(
  options: DevSupervisorOptions,
): Promise<void> {
  await runDevSupervisorWithRuntime({
    options,
    runtime: createNodeDevSupervisorRuntime(),
  });
}

export async function runDevSupervisorWithRuntime(
  args: RunDevSupervisorWithRuntimeArgs,
): Promise<void> {
  const { options, runtime } = args;
  const pidPath = runtime.resolvePidPath(options.serviceName);
  const unexpectedRestartBackoff = options.unexpectedRestartBackoff;
  const restartDelay = createInterruptibleDelay(runtime);
  let activeChild: DevSupervisorChildProcess | null = null;
  let forceKillTimeout: DevSupervisorTimer | null = null;
  let unexpectedRestartAttempt = 0;
  let stopRequested = false;
  let restartRequested = false;

  const cleanupPidFile = () => {
    runtime.removePidFileSync(pidPath);
  };

  runtime.registerExitHandler(cleanupPidFile);

  const clearForceKillTimeout = () => {
    if (!forceKillTimeout) {
      return;
    }

    forceKillTimeout.clear();
    forceKillTimeout = null;
  };

  const interruptPendingRestartDelay = () => {
    restartDelay.interrupt();
  };

  const terminateActiveChild = (signal: NodeJS.Signals) => {
    if (!activeChild || !isChildRunning(activeChild)) {
      return;
    }

    activeChild.kill(signal);
    clearForceKillTimeout();
    forceKillTimeout = scheduleForcedKill({
      child: activeChild,
      forceKillAfterMs: DEV_SUPERVISOR_FORCE_KILL_AFTER_MS,
      runtime,
      serviceName: options.serviceName,
    });
  };

  const requestStop = (signal: NodeJS.Signals) => {
    stopRequested = true;
    terminateActiveChild(signal);
    interruptPendingRestartDelay();
  };

  const removeSignalForwarding =
    runtime.installTerminationSignalForwarding(requestStop);
  const handleRestartSignal = () => {
    if (stopRequested || restartRequested) {
      return;
    }

    restartRequested = true;
    runtime.writeStdout(
      `[dev-supervisor:${options.serviceName}] Restart requested.\n`,
    );

    terminateActiveChild("SIGTERM");
    interruptPendingRestartDelay();
  };
  const removeRestartSignalHandler =
    runtime.installRestartSignalHandler(handleRestartSignal);
  const removeSignalHandlers = () => {
    removeSignalForwarding();
    removeRestartSignalHandler();
  };

  await runtime.writePidFile({
    pid: runtime.currentPid,
    pidPath,
  });

  while (true) {
    const childStartedAt = runtime.now();
    activeChild = runtime.spawnChildProcess({
      args: options.childArgs,
      command: options.childCommand,
      cwd: options.childCwd,
      env: options.childEnv,
    });

    const { code, signal } = await activeChild.waitForExit();
    clearForceKillTimeout();
    activeChild = null;

    if (stopRequested) {
      runtime.setExitCode(0);
      removeSignalHandlers();
      return;
    }

    if (restartRequested) {
      restartRequested = false;
      unexpectedRestartAttempt = 0;
      continue;
    }

    const childRuntimeMs = runtime.now() - childStartedAt;
    unexpectedRestartAttempt =
      childRuntimeMs >= unexpectedRestartBackoff.stableChildRuntimeMs
        ? 1
        : unexpectedRestartAttempt + 1;
    const restartDelayMs = calculateUnexpectedRestartDelay({
      attempt: unexpectedRestartAttempt,
      initialDelayMs: unexpectedRestartBackoff.initialDelayMs,
      maxDelayMs: unexpectedRestartBackoff.maxDelayMs,
    });
    runtime.writeStderr(
      `[dev-supervisor:${options.serviceName}] Child exited unexpectedly with ${formatExit(code, signal)}. Restarting in ${formatDurationMs(restartDelayMs)}.\n`,
    );
    await restartDelay.wait(restartDelayMs);
    if (stopRequested) {
      runtime.setExitCode(0);
      removeSignalHandlers();
      return;
    }

    if (restartRequested) {
      restartRequested = false;
      unexpectedRestartAttempt = 0;
    }
  }
}
