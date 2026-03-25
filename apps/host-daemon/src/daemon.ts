import type { HostDaemonLogger } from "./logger.js";

export interface HostDaemonIdentity {
  hostId: string;
  hostName: string;
  instanceId: string;
}

export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface CreateDaemonOptions {
  identity: HostDaemonIdentity;
  logger: HostDaemonLogger;
  releaseLock: () => Promise<void>;
  flushEventBuffer?: () => Promise<void>;
  shutdownRuntimes?: () => Promise<void>;
  restart?: () => Promise<void>;
  onStart?: () => Promise<void>;
  signalSource?: SignalSource;
}

export interface HostDaemon {
  readonly identity: HostDaemonIdentity;
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  waitUntilStopped(): Promise<void>;
}

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR2";
type StopMode = "shutdown" | "restart";

export function createDaemon(options: CreateDaemonOptions): HostDaemon {
  let started = false;
  let stopPromise: Promise<void> | null = null;

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

  async function stop(mode: StopMode, reason: string): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async () => {
      unregisterSignalHandlers();
      options.logger.info(
        { mode, reason },
        mode === "restart" ? "Restarting host daemon" : "Shutting down host daemon",
      );

      let failure: unknown;
      const steps =
        mode === "restart"
          ? ([
              {
                name: "flushEventBuffer",
                run: options.flushEventBuffer,
              },
              {
                name: "shutdownRuntimes",
                run: options.shutdownRuntimes,
              },
              {
                name: "restart",
                run: options.restart,
              },
            ] as const)
          : ([
              {
                name: "flushEventBuffer",
                run: options.flushEventBuffer,
              },
              {
                name: "shutdownRuntimes",
                run: options.shutdownRuntimes,
              },
              {
                name: "releaseLock",
                run: options.releaseLock,
              },
            ] as const);

      for (const step of steps) {
        if (!step.run) {
          continue;
        }

        try {
          await step.run();
        } catch (error) {
          failure ??= error;
          options.logger.error({ err: error, step: step.name }, "Shutdown step failed");
        }
      }

      resolveStopped?.();

      if (failure) {
        throw failure;
      }
    })();

    return stopPromise;
  }

  async function shutdown(reason = "shutdown"): Promise<void> {
    return stop("shutdown", reason);
  }

  return {
    identity: options.identity,
    async start(): Promise<void> {
      if (started) {
        return;
      }

      for (const signal of TERMINATION_SIGNALS) {
        const listener = () => {
          void stop("shutdown", signal);
        };
        listeners.set(signal, listener);
        signalSource.on(signal, listener);
      }

      if (options.restart) {
        const listener = () => {
          void stop("restart", RESTART_SIGNAL);
        };
        listeners.set(RESTART_SIGNAL, listener);
        signalSource.on(RESTART_SIGNAL, listener);
      }

      try {
        await options.onStart?.();
        started = true;
        options.logger.info(
          { identity: options.identity },
          "Host daemon started",
        );
      } catch (error) {
        unregisterSignalHandlers();
        throw error;
      }
    },
    shutdown,
    waitUntilStopped(): Promise<void> {
      return stopped;
    },
  };
}
