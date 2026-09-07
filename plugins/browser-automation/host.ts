import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { hostContract, type RuntimeState } from "./contracts.js";
import { resolveRuntime, type ResolvedRuntime } from "./runtime-pin.js";
import { createRuntime, type RuntimeSession } from "./runtime.js";

export function createHostEntry(
  factory = createRuntime,
  resolver: (args: {
    dataDir: string;
    signal: AbortSignal;
    onProgress: (detail: string) => void;
  }) => Promise<ResolvedRuntime> = resolveRuntime,
  timing = { preparePollMs: 20_000, abandonedInstallGraceMs: 15_000 },
) {
  const { preparePollMs, abandonedInstallGraceMs } = timing;
  const sessions = new Map<
    string,
    {
      runtime: Promise<RuntimeSession>;
      abort: AbortController;
      lease: ExperimentalHostWorkerLease;
      expiresAt: number;
      idleTimeoutMs: number;
      lastUsed: number;
      active: number;
    }
  >();
  let resolved: ResolvedRuntime | null = null;
  interface RuntimePreparation {
    promise: Promise<ResolvedRuntime>;
    abort: AbortController;
    waiters: number;
    detail: string;
    abandonTimer: NodeJS.Timeout | null;
  }
  let job: RuntimePreparation | null = null;
  async function attachRuntime(
    context: ExperimentalHostRpcContext,
  ): Promise<{ promise: Promise<ResolvedRuntime>; detach: () => void }> {
    if (resolved) {
      const usable = await access(resolved.binary, constants.X_OK).then(
        () => true,
        () => false,
      );
      if (usable) return { promise: Promise.resolve(resolved), detach() {} };
      resolved = null;
    }
    if (!job) {
      const abort = new AbortController();
      const lease = context.experimental_retainWorker();
      const state = {
        abort,
        waiters: 0,
        detail: "preparing the DevBrowser runtime",
      };
      const current: RuntimePreparation = Object.assign(state, {
        abandonTimer: null,
        promise: resolver({
          dataDir: context.experimental_paths.dataDir,
          signal: AbortSignal.any([
            abort.signal,
            context.lifecycle.signal,
            AbortSignal.timeout(15 * 60_000),
          ]),
          onProgress(detail) {
            state.detail = detail;
          },
        }).then((runtime) => {
          resolved = runtime;
          return runtime;
        }),
      });
      current.promise
        .catch(() => {})
        .finally(() => {
          if (job === current) job = null;
          if (current.abandonTimer) clearTimeout(current.abandonTimer);
          void lease.dispose();
        });
      job = current;
    }
    const current = job;
    current.waiters++;
    if (current.abandonTimer) {
      clearTimeout(current.abandonTimer);
      current.abandonTimer = null;
    }
    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
      context.signal.removeEventListener("abort", detach);
      current.waiters--;
      if (current.waiters > 0 || job !== current || current.abandonTimer)
        return;
      current.abandonTimer = setTimeout(() => {
        if (current.waiters === 0 && job === current) current.abort.abort();
      }, abandonedInstallGraceMs);
      current.abandonTimer.unref();
    };
    context.signal.addEventListener("abort", detach, { once: true });
    return { promise: current.promise, detach };
  }
  async function close(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.abort.abort();
    try {
      await (await session.runtime).close();
    } catch {
    } finally {
      await session.lease.dispose();
    }
  }
  const timer = setInterval(() => {
    for (const [id, session] of sessions) {
      if (
        Date.now() >= session.expiresAt ||
        (session.active === 0 &&
          Date.now() - session.lastUsed >= session.idleTimeoutMs)
      )
        void close(id);
    }
  }, 1000);
  timer.unref();
  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      async prepare(_input, context): Promise<RuntimeState> {
        context.signal.throwIfAborted();
        const { promise, detach } = await attachRuntime(context);
        try {
          const outcome = await Promise.race([
            promise,
            new Promise<null>((resolve) => {
              const timeout = setTimeout(() => resolve(null), preparePollMs);
              timeout.unref();
              promise.finally(() => clearTimeout(timeout)).catch(() => {});
            }),
          ]);
          if (outcome)
            return {
              status: "ready",
              version: outcome.version,
              source: outcome.source,
            };
          return {
            status: "installing",
            detail: job?.detail ?? "preparing the DevBrowser runtime",
          };
        } finally {
          detach();
        }
      },
      async open(input, context) {
        context.signal.throwIfAborted();
        if (sessions.has(input.sessionId))
          throw new Error("Session already exists");
        if (sessions.size >= 32)
          throw new Error("Host browser session limit reached");
        const attached = await attachRuntime(context);
        let runtime: ResolvedRuntime;
        try {
          runtime = await attached.promise;
        } finally {
          attached.detach();
        }
        const abort = new AbortController();
        const signal = AbortSignal.any([
          context.signal,
          context.lifecycle.signal,
          abort.signal,
        ]);
        const session = {
          runtime: factory({
            ...context.experimental_paths,
            runtime,
            connectionUrl: input.connectionUrl,
            signal,
          }),
          abort,
          lease: context.experimental_retainWorker(),
          expiresAt: input.expiresAt,
          idleTimeoutMs: input.idleTimeoutMs,
          lastUsed: Date.now(),
          active: 1,
        };
        sessions.set(input.sessionId, session);
        try {
          await session.runtime;
          signal.throwIfAborted();
          session.active = 0;
        } catch (error) {
          await close(input.sessionId);
          throw error;
        }
        return null;
      },
      async run(input, context) {
        const session = sessions.get(input.sessionId);
        if (!session)
          throw new Error(
            "Session stopped, expired, or worker restarted; open a new session",
          );
        session.active++;
        try {
          const runtime = await session.runtime;
          const result = await runtime.run(
            input.script,
            input.timeoutMs,
            AbortSignal.any([
              context.signal,
              context.lifecycle.signal,
              session.abort.signal,
            ]),
          );
          if (result.exitCode === 124) await close(input.sessionId);
          return result;
        } catch (error) {
          await close(input.sessionId);
          throw error;
        } finally {
          session.active--;
          session.lastUsed = Date.now();
        }
      },
      async stop({ sessionId }) {
        await close(sessionId);
        return null;
      },
      async close({ sessionId }) {
        await close(sessionId);
        return null;
      },
    },
    async dispose() {
      clearInterval(timer);
      job?.abort.abort();
      await Promise.all([...sessions.keys()].map(close));
    },
  });
}

export default createHostEntry();
