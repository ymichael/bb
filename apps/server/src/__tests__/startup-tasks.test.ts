import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverManagedEnvironmentAgentSessionsOnBoot,
  scheduleManagedEnvironmentAgentSessionRecoveryOnBoot,
  scheduleManagedArtifactReconciliation,
} from "../startup-tasks.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startup tasks", () => {
  it("defers managed artifact reconciliation until after startup returns", async () => {
    const threadManager = {
      reconcileManagedArtifacts: vi.fn().mockResolvedValue(undefined),
    };
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    scheduleManagedArtifactReconciliation(threadManager, logger);

    expect(threadManager.reconcileManagedArtifacts).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(logger.log).toHaveBeenCalledWith(
      "Reconciling managed storage artifacts in background...",
    );
    expect(threadManager.reconcileManagedArtifacts).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "Managed artifact reconciliation complete.",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs cleanup warnings without throwing when background reconciliation fails", async () => {
    const threadManager = {
      reconcileManagedArtifacts: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    scheduleManagedArtifactReconciliation(threadManager, logger);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(threadManager.reconcileManagedArtifacts).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Managed artifact cleanup skipped: boom",
    );
  });

  it("pokes reachable env-agents and leaves unreachable sessions for heartbeat timeout handling", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:4310/")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`offline: ${url}`);
    });

    const sessionRepo = {
      listActive: vi.fn().mockReturnValue([
        {
          id: "sess-1",
          threadId: "thread-1",
          controlBaseUrl: "http://127.0.0.1:4310",
          controlAuthToken: "token-1",
          protocolVersion: 1,
          selectedCapabilities: {
            commands: [
              "provider.ensure",
              "thread.start",
              "thread.resume",
              "turn.run",
            ],
            features: [],
          },
        },
        {
          id: "sess-2",
          threadId: "thread-2",
          controlBaseUrl: "http://127.0.0.1:4311",
          controlAuthToken: "token-2",
          protocolVersion: 1,
          selectedCapabilities: {
            commands: [
              "provider.ensure",
              "thread.start",
              "thread.resume",
              "turn.run",
            ],
            features: [],
          },
        },
      ]),
    };

    const result = await recoverManagedEnvironmentAgentSessionsOnBoot({
      sessionRepo,
      logger: {
        log: vi.fn(),
        warn: vi.fn(),
      },
    });

    expect(result).toEqual({
      activeSessionCount: 2,
      pokedCount: 1,
      unreachableCount: 1,
      replaceRequiredCount: 0,
    });
  });

  it("defers env-agent startup recovery into the background", async () => {
    const sessionRepo = {
      listActive: vi.fn().mockReturnValue([]),
    };
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    scheduleManagedEnvironmentAgentSessionRecoveryOnBoot({
      sessionRepo,
      logger,
    });

    expect(sessionRepo.listActive).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(logger.log).toHaveBeenCalledWith(
      "Reconciling managed environment-agent sessions in background...",
    );
    expect(sessionRepo.listActive).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("times out slow env-agent pokes instead of hanging boot recovery", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );

    const sessionRepo = {
      listActive: vi.fn().mockReturnValue([
        {
          id: "sess-slow",
          threadId: "thread-slow",
          controlBaseUrl: "http://127.0.0.1:4310",
          controlAuthToken: "token-slow",
          protocolVersion: 1,
          selectedCapabilities: {
            commands: [
              "provider.ensure",
              "thread.start",
              "thread.resume",
              "turn.run",
            ],
            features: [],
          },
        },
      ]),
    };

    const result = await recoverManagedEnvironmentAgentSessionsOnBoot({
      sessionRepo,
      requestTimeoutMs: 10,
      logger: {
        log: vi.fn(),
        warn: vi.fn(),
      },
    });

    expect(result).toEqual({
      activeSessionCount: 1,
      pokedCount: 0,
      unreachableCount: 1,
      replaceRequiredCount: 0,
    });
  });

  it("skips replace-required sessions during boot recovery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };
    const sessionRepo = {
      listActive: vi.fn().mockReturnValue([
        {
          id: "sess-reuse",
          threadId: "thread-1",
          controlBaseUrl: "http://127.0.0.1:4310",
          controlAuthToken: "token-1",
          protocolVersion: 1,
          selectedCapabilities: {
            commands: [
              "provider.ensure",
              "thread.start",
              "thread.resume",
              "turn.run",
            ],
            features: [],
          },
        },
        {
          id: "sess-replace",
          threadId: "thread-2",
          controlBaseUrl: "http://127.0.0.1:4311",
          controlAuthToken: "token-2",
          protocolVersion: 1,
          selectedCapabilities: {
            commands: ["thread.start"],
            features: [],
          },
        },
      ]),
    };

    const result = await recoverManagedEnvironmentAgentSessionsOnBoot({
      sessionRepo,
      logger,
    });

    expect(result).toEqual({
      activeSessionCount: 2,
      pokedCount: 1,
      unreachableCount: 0,
      replaceRequiredCount: 1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "Environment-agent startup recovery poked 1/1 reusable active sessions; left 0 unreachable and 1 replace-required sessions for lazy replacement.",
    );
  });
});
