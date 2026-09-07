import type { HostDaemonLogger } from "./logger.js";
import { normalizeCaughtError } from "./error-utils.js";

interface HostDaemonIdentity {
  hostId: string;
  hostName: string;
  instanceId: string;
}

interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): void;
  off(event: NodeJS.Signals, listener: () => void): void;
}

interface CreateDaemonOptions {
  identity: HostDaemonIdentity;
  logger: HostDaemonLogger;
  releaseLock: () => Promise<void>;
  flushEvents?: () => Promise<void>;
  shutdownRuntimes?: () => Promise<void>;
  onStart?: () => Promise<void>;
  signalSource?: SignalSource;
  exitProcess?: (code: number) => void;
  shutdownExitGraceMs?: number;
}

export interface HostDaemon {
  readonly identity: HostDaemonIdentity;
  start(): Promise<void>;
  shutdown(reason: string, exitCode: 0 | 1): Promise<void>;
  waitUntilStopped(): Promise<void>;
}

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const DEFAULT_SHUTDOWN_EXIT_GRACE_MS = 15_000;

export function createDaemon(options: CreateDaemonOptions): HostDaemon {
  let started = false;
  let startupFailed = false;
  let stopPromise: Promise<void> | null = null;
  let stopFailure: Error | null = null;
  let shutdownExitWatchdog: ReturnType<typeof setTimeout> | null = null;
  let shutdownExitReason: string | null = null;
  let shutdownExitCode: 0 | 1 = 0;

  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const signalSource = options.signalSource ?? process;
  const listeners = new Map<NodeJS.Signals, () => void>();

  function unregisterSignalHandlers(): void {
    for (const [signal, listener] of listeners) {
      signalSource.off(signal, listener);
    }
    listeners.clear();
  }

  function requestProcessExit(reason: string, exitCode: 0 | 1): void {
    if (shutdownExitReason === null || exitCode > shutdownExitCode) {
      shutdownExitReason = reason;
      shutdownExitCode = exitCode;
    }
  }

  function armShutdownExitWatchdog(): void {
    const exitProcess = options.exitProcess;
    if (!exitProcess) {
      return;
    }

    const graceMs =
      options.shutdownExitGraceMs ?? DEFAULT_SHUTDOWN_EXIT_GRACE_MS;
    shutdownExitWatchdog = setTimeout(() => {
      shutdownExitWatchdog = null;
      options.logger.error(
        {
          reason: shutdownExitReason,
          graceMs,
          activeResources: process.getActiveResourcesInfo(),
        },
        "Host daemon shutdown did not end the process; forcing exit so the service manager can restart it.",
      );
      exitProcess(shutdownExitCode);
    }, graceMs);
    shutdownExitWatchdog.unref?.();
  }

  function exitAfterCleanShutdown(): void {
    const exitProcess = options.exitProcess;
    if (startupFailed || !exitProcess) {
      return;
    }
    if (shutdownExitWatchdog !== null) {
      clearTimeout(shutdownExitWatchdog);
      shutdownExitWatchdog = null;
    }
    exitProcess(shutdownExitCode);
  }

  async function stop(reason: string, exitCode: 0 | 1): Promise<void> {
    requestProcessExit(reason, exitCode);
    if (stopPromise) {
      return stopPromise;
    }

    armShutdownExitWatchdog();

    stopPromise = (async () => {
      unregisterSignalHandlers();
      options.logger.info(
        { mode: "shutdown", reason },
        "Shutting down host daemon",
      );

      let failure: Error | null = null;
      const steps = [
        {
          name: "flushEvents",
          run: options.flushEvents,
        },
        {
          name: "shutdownRuntimes",
          run: options.shutdownRuntimes,
        },
        {
          name: "releaseLock",
          run: options.releaseLock,
        },
      ] as const;

      for (const step of steps) {
        if (!step.run) {
          continue;
        }

        try {
          await step.run();
        } catch (error) {
          const stepError = normalizeCaughtError(error);
          failure ??= stepError;
          options.logger.error(
            { err: stepError, step: step.name },
            "Shutdown step failed",
          );
        }
      }

      if (failure) {
        stopFailure = failure;
        resolveStopped?.();
        throw failure;
      }

      resolveStopped?.();
      exitAfterCleanShutdown();
    })();

    return stopPromise;
  }

  async function shutdown(reason: string, exitCode: 0 | 1): Promise<void> {
    return stop(reason, exitCode);
  }

  return {
    identity: options.identity,
    async start(): Promise<void> {
      if (started || stopPromise) {
        return;
      }

      for (const signal of TERMINATION_SIGNALS) {
        const listener = () => {
          void stop(signal, 0).catch((error) => {
            options.logger.error(
              { err: error, signal },
              "Signal-triggered host daemon shutdown failed",
            );
          });
        };
        listeners.set(signal, listener);
        signalSource.on(signal, listener);
      }

      try {
        await options.onStart?.();
        if (stopPromise) {
          return;
        }
        started = true;
        options.logger.info(
          { identity: options.identity },
          "Host daemon started",
        );
      } catch (error) {
        if (stopPromise) {
          await stop("startup-interrupted", 0).catch(() => undefined);
          return;
        }
        startupFailed = true;
        await stop("startup-failed", 1).catch(() => undefined);
        throw error;
      }
    },
    shutdown,
    async waitUntilStopped(): Promise<void> {
      await stopped;
      if (stopFailure) {
        throw stopFailure;
      }
    },
  };
}
