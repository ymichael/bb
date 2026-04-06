import { setTimeout as delay } from "node:timers/promises";
import {
  getHost,
  openSession,
  upsertHost,
} from "@bb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  destroyHost,
  resumeSuspendedHost,
  suspendIdleHost,
  waitForHostSession,
} from "../../src/services/hosts/host-lifecycle.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const resumeHostMock = vi.fn();
const resumeSandboxMock = vi.fn();
type SandboxHostMockArgs = Array<object | string | undefined>;

// Server tests treat @bb/sandbox-host as the external sandbox boundary.
// Package-level tests cover the E2B mechanics directly; these tests focus on
// server lifecycle policy and orchestration.
vi.mock("@bb/sandbox-host", () => ({
  resumeHost: (...args: SandboxHostMockArgs) => resumeHostMock(...args),
  resumeSandbox: (...args: SandboxHostMockArgs) => resumeSandboxMock(...args),
}));

interface MockSandboxHost {
  destroy: ReturnType<typeof vi.fn>;
  extendTimeout: ReturnType<typeof vi.fn>;
  externalId: string;
  hostId: string;
  resume: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
}

interface MockResumedSandbox {
  kill: ReturnType<typeof vi.fn>;
}

function createMockSandboxHost(hostId: string, externalId = "sandbox-123"): MockSandboxHost {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    extendTimeout: vi.fn().mockResolvedValue(undefined),
    externalId,
    hostId,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockResumedSandbox(): MockResumedSandbox {
  return {
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

describe("host lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resumeHostMock.mockReset();
    resumeSandboxMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a host session to open", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-wait",
        name: "Waiting Host",
        type: "ephemeral",
      });

      setTimeout(() => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 5_000,
          hostId: host.id,
          hostName: host.name,
          hostType: host.type,
          instanceId: "instance-opened",
          leaseTimeoutMs: 30_000,
          protocolVersion: 2,
        });
      }, 500);

      const waiting = waitForHostSession(harness.deps, host.id, {
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(waiting).resolves.toMatchObject({
        hostId: host.id,
        status: "active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores unrelated host events while waiting for a session", async () => {
    const harness = await createTestAppHarness();
    try {
      const targetHost = upsertHost(harness.db, harness.hub, {
        id: "host-target-wait",
        name: "Target Host",
        type: "ephemeral",
      });
      const unrelatedHost = upsertHost(harness.db, harness.hub, {
        id: "host-unrelated-wait",
        name: "Unrelated Host",
        type: "ephemeral",
      });

      setTimeout(() => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 5_000,
          hostId: unrelatedHost.id,
          hostName: unrelatedHost.name,
          hostType: unrelatedHost.type,
          instanceId: "instance-unrelated",
          leaseTimeoutMs: 30_000,
          protocolVersion: 2,
        });
      }, 500);
      setTimeout(() => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 5_000,
          hostId: targetHost.id,
          hostName: targetHost.name,
          hostType: targetHost.type,
          instanceId: "instance-target",
          leaseTimeoutMs: 30_000,
          protocolVersion: 2,
        });
      }, 1_000);

      let resolved = false;
      const waiting = waitForHostSession(harness.deps, targetHost.id, {
        timeoutMs: 5_000,
      }).then((session) => {
        resolved = true;
        return session;
      });

      await vi.advanceTimersByTimeAsync(750);
      await Promise.resolve();
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      await expect(waiting).resolves.toMatchObject({
        hostId: targetHost.id,
        status: "active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("times out when a host session never opens", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-timeout",
        name: "Timeout Host",
        type: "ephemeral",
      });

      const waiting = waitForHostSession(harness.deps, host.id, {
        timeoutMs: 2_000,
      });
      const assertion = expect(waiting).rejects.toMatchObject({
        body: {
          code: "host_connection_timeout",
        },
        status: 504,
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      await harness.cleanup();
    }
  });

  it("suspends a cached sandbox host", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostRow = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-cached-suspend",
        id: "host-cached-suspend",
        name: "Cached Suspend Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const host = createMockSandboxHost(hostRow.id, hostRow.externalId ?? undefined);
      harness.deps.sandboxRegistry.set(hostRow.id, host);

      await suspendIdleHost(harness.deps, hostRow.id);

      expect(host.suspend).toHaveBeenCalledTimes(1);
      expect(harness.deps.sandboxRegistry.get(hostRow.id)).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("resumes a sandbox host through the backend path even when cached", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostRow = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-cached-resume",
        id: "host-cached-resume",
        name: "Cached Resume Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const cachedHost = createMockSandboxHost(hostRow.id, hostRow.externalId ?? undefined);
      const resumedHost = createMockSandboxHost(hostRow.id, hostRow.externalId ?? undefined);
      harness.deps.sandboxRegistry.set(hostRow.id, cachedHost);
      resumeHostMock.mockResolvedValue(resumedHost);

      const resumed = await resumeSuspendedHost(harness.deps, hostRow.id);

      expect(cachedHost.resume).not.toHaveBeenCalled();
      expect(resumeHostMock).toHaveBeenCalledWith({
        apiKey: "test-e2b-api-key",
        authToken: harness.config.authToken,
        daemonEnv: {
          OPENAI_API_KEY: "test-openai-key",
        },
        externalId: "sandbox-cached-resume",
        hostId: hostRow.id,
        hostName: hostRow.name,
        serverUrl: harness.config.publicUrl,
      });
      expect(resumed).toBe(resumedHost);
      expect(harness.deps.sandboxRegistry.get(hostRow.id)).toBe(resumedHost);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not resume a destroyed sandbox host", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        destroyedAt: Date.now(),
        externalId: "sandbox-destroyed",
        id: "host-destroyed",
        name: "Destroyed Host",
        provider: "e2b",
        type: "ephemeral",
      });

      await expect(resumeSuspendedHost(harness.deps, host.id)).rejects.toMatchObject({
        body: {
          code: "host_not_found",
        },
        status: 404,
      });
      expect(resumeHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("returns host_not_found when resuming a missing sandbox host", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      await expect(resumeSuspendedHost(harness.deps, "host-missing")).rejects.toMatchObject({
        body: {
          code: "host_not_found",
        },
        status: 404,
      });
      expect(resumeHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("deduplicates concurrent sandbox host resumes", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-concurrent",
        id: "host-concurrent",
        name: "Concurrent Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const resumedHost = createMockSandboxHost(host.id, host.externalId ?? undefined);
      resumeHostMock.mockImplementation(async () => {
        await delay(1_000);
        return resumedHost;
      });

      const firstResume = resumeSuspendedHost(harness.deps, host.id);
      const secondResume = resumeSuspendedHost(harness.deps, host.id);

      await vi.advanceTimersByTimeAsync(1_000);
      const [firstHost, secondHost] = await Promise.all([firstResume, secondResume]);

      expect(resumeHostMock).toHaveBeenCalledTimes(1);
      expect(resumeHostMock).toHaveBeenCalledWith({
        apiKey: undefined,
        authToken: harness.config.authToken,
        daemonEnv: {
          OPENAI_API_KEY: "test-openai-key",
        },
        externalId: "sandbox-concurrent",
        hostId: host.id,
        hostName: host.name,
        serverUrl: harness.config.publicUrl,
      });
      expect(firstHost).toBe(resumedHost);
      expect(secondHost).toBe(resumedHost);
      expect(harness.deps.sandboxRegistry.get(host.id)).toBe(resumedHost);
    } finally {
      await harness.cleanup();
    }
  });

  it("destroys a cached sandbox host and marks it destroyed", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostRow = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-cached-destroy",
        id: "host-cached-destroy",
        name: "Destroy Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const host = createMockSandboxHost(hostRow.id, hostRow.externalId ?? undefined);
      harness.deps.sandboxRegistry.set(hostRow.id, host);

      await destroyHost(harness.deps, hostRow.id);

      expect(host.destroy).toHaveBeenCalledTimes(1);
      expect(harness.deps.sandboxRegistry.get(hostRow.id)).toBeUndefined();
      expect(getHost(harness.db, hostRow.id)).toMatchObject({
        destroyedAt: expect.any(Number),
        externalId: "sandbox-cached-destroy",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("destroys an uncached sandbox host through resumeSandbox", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-uncached-destroy",
        id: "host-uncached-destroy",
        name: "Destroy Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const resumedSandbox = createMockResumedSandbox();
      resumeSandboxMock.mockResolvedValue(resumedSandbox);

      await destroyHost(harness.deps, host.id);

      expect(resumeSandboxMock).toHaveBeenCalledWith("sandbox-uncached-destroy", {
        apiKey: undefined,
      });
      expect(resumedSandbox.kill).toHaveBeenCalledTimes(1);
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
        externalId: "sandbox-uncached-destroy",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("marks uncached hosts without external IDs destroyed", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-no-external-id",
        name: "Destroy Host",
        provider: "e2b",
        type: "ephemeral",
      });

      await destroyHost(harness.deps, host.id);

      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
        externalId: null,
      });
      expect(resumeSandboxMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("throws when an ephemeral sandbox host is missing a backend provider", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-missing-provider",
        id: "host-missing-provider",
        name: "Missing Provider Host",
        type: "ephemeral",
      });

      await expect(resumeSuspendedHost(harness.deps, host.id)).rejects.toMatchObject({
        body: {
          code: "internal_error",
          message: `Sandbox host ${host.id} is missing a backend provider`,
        },
        status: 500,
      });
      expect(resumeHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("silently clears missing hosts from the sandbox registry during destroy", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const cachedHost = createMockSandboxHost("host-missing");
      harness.deps.sandboxRegistry.set("host-missing", cachedHost);

      await expect(destroyHost(harness.deps, "host-missing")).resolves.toBeUndefined();

      expect(harness.deps.sandboxRegistry.get("host-missing")).toBeUndefined();
      expect(cachedHost.destroy).not.toHaveBeenCalled();
      expect(resumeSandboxMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("deduplicates concurrent sandbox host destroys", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-concurrent-destroy",
        id: "host-concurrent-destroy",
        name: "Concurrent Destroy Host",
        provider: "e2b",
        type: "ephemeral",
      });
      let resolveKill: (() => void) | null = null;
      const killPromise = new Promise<void>((resolve) => {
        resolveKill = resolve;
      });
      const resumedSandbox = {
        kill: vi.fn().mockImplementation(async () => killPromise),
      };
      resumeSandboxMock.mockResolvedValue(resumedSandbox);

      const firstDestroy = destroyHost(harness.deps, host.id);
      const secondDestroy = destroyHost(harness.deps, host.id);
      await Promise.resolve();

      expect(resumeSandboxMock).toHaveBeenCalledTimes(1);
      expect(resumedSandbox.kill).toHaveBeenCalledTimes(1);

      if (!resolveKill) {
        throw new Error("Expected destroy to start kill");
      }
      resolveKill();

      await Promise.all([firstDestroy, secondDestroy]);
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("clears a concurrently cached host after uncached destroy completes", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-racy-destroy",
        id: "host-racy-destroy",
        name: "Destroy Host",
        provider: "e2b",
        type: "ephemeral",
      });
      let resolveKill: (() => void) | null = null;
      const killPromise = new Promise<void>((resolve) => {
        resolveKill = resolve;
      });
      const resumedSandbox = {
        kill: vi.fn().mockImplementation(async () => killPromise),
      };
      const resumedHost = createMockSandboxHost(host.id, host.externalId ?? undefined);
      resumeSandboxMock.mockResolvedValue(resumedSandbox);
      resumeHostMock.mockResolvedValue(resumedHost);

      const destroying = destroyHost(harness.deps, host.id);
      await Promise.resolve();

      const loading = resumeSuspendedHost(harness.deps, host.id);
      await Promise.resolve();
      await loading;
      expect(harness.deps.sandboxRegistry.get(host.id)).toBe(resumedHost);

      if (!resolveKill) {
        throw new Error("Expected destroy to start kill");
      }
      resolveKill();
      await destroying;

      expect(harness.deps.sandboxRegistry.get(host.id)).toBeUndefined();
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
        externalId: "sandbox-racy-destroy",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
