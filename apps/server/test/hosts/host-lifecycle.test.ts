import {
  getActiveSession,
  getHost,
  hostDaemonCommands,
  markEphemeralHostActivity,
  openSession,
  upsertHost,
} from "@bb/db";
import {
  markHostSuspended,
} from "@bb/db/internal-lifecycle";
import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  destroyHost,
  ensureSandboxHostSessionReady,
  markSandboxActivity,
  maybeSuspendIdleSandbox,
  waitForHostSession,
} from "../../src/services/hosts/host-lifecycle.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const provisionHostMock = vi.fn();
const resumeHostMock = vi.fn();
const resumeSandboxMock = vi.fn();
type SandboxHostMockArgs = Array<object | string | undefined>;

// Server tests treat @bb/sandbox-host as the external sandbox boundary.
// Package-level tests cover the E2B mechanics directly; these tests focus on
// server lifecycle policy and orchestration.
vi.mock("@bb/sandbox-host", () => ({
  DEFAULT_SANDBOX_TIMEOUT_MS: 15 * 60 * 1000,
  provisionHost: (...args: SandboxHostMockArgs) => provisionHostMock(...args),
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

interface ProvisionHostMockArgs {
  hostId: string;
  progressCallbacks?: SandboxHostProgressCallbacks;
}

function createMockSandboxHost(
  hostId: string,
  externalId = "sandbox-123",
): MockSandboxHost {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    extendTimeout: vi.fn().mockResolvedValue(undefined),
    externalId,
    hostId,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
  };
}

describe("host lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    provisionHostMock.mockReset();
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
          dataDir: "/tmp/bb-test-data",
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
          dataDir: "/tmp/bb-test-data",
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
          dataDir: "/tmp/bb-test-data",
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
      const resumedSandbox = {
        kill: vi.fn().mockResolvedValue(undefined),
      };
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

  it("throws when a sandbox host is missing a backend provider during destroy", async () => {
    const harness = await createTestAppHarness({ e2bApiKey: "" });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-missing-provider",
        id: "host-missing-provider",
        name: "Missing Provider Host",
        type: "ephemeral",
      });

      await expect(destroyHost(harness.deps, host.id)).rejects.toMatchObject({
        body: {
          code: "internal_error",
          message: `Sandbox host ${host.id} is missing a backend provider`,
        },
        status: 500,
      });
      expect(resumeSandboxMock).not.toHaveBeenCalled();
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
      await vi.waitFor(() => {
        expect(resumeSandboxMock).toHaveBeenCalledTimes(1);
        expect(resumedSandbox.kill).toHaveBeenCalledTimes(1);
      });

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

  it("fans out sandbox host progress callbacks across concurrent ready calls", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-concurrent-ready",
        name: "Concurrent Ready Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(
        host.id,
        "sandbox-concurrent-ready",
      );
      const firstProgressEvents: string[] = [];
      const secondProgressEvents: string[] = [];

      provisionHostMock.mockImplementation(async (args: ProvisionHostMockArgs) => {
        setTimeout(() => {
          args.progressCallbacks?.onProgress?.({
            stage: "host",
            status: "started",
          });
        }, 10);
        setTimeout(() => {
          args.progressCallbacks?.onSandboxCreated?.({
            externalId: sandboxHost.externalId,
          });
          args.progressCallbacks?.onProgress?.({
            stage: "host",
            status: "completed",
          });
        }, 20);
        return sandboxHost;
      });

      setTimeout(() => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 5_000,
          hostId: host.id,
          hostName: host.name,
          hostType: host.type,
          instanceId: "instance-concurrent-ready",
          leaseTimeoutMs: 30_000,
          protocolVersion: 2,
          dataDir: "/tmp/bb-test-data",
        });
      }, 50);

      const firstReady = ensureSandboxHostSessionReady(harness.deps, {
        hostId: host.id,
        progressCallbacks: {
          onProgress: (event) => {
            firstProgressEvents.push(`${event.stage}:${event.status}`);
          },
          onSandboxCreated: ({ externalId }) => {
            firstProgressEvents.push(`created:${externalId}`);
          },
        },
      });

      await vi.advanceTimersByTimeAsync(15);

      const secondReady = ensureSandboxHostSessionReady(harness.deps, {
        hostId: host.id,
        progressCallbacks: {
          onProgress: (event) => {
            secondProgressEvents.push(`${event.stage}:${event.status}`);
          },
          onSandboxCreated: ({ externalId }) => {
            secondProgressEvents.push(`created:${externalId}`);
          },
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      const queuedRuntimeSync = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id && command.type === "host.sync_runtime_material",
      );
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queuedRuntimeSync,
        {
          appliedVersion: queuedRuntimeSync.command.version,
        },
        {
          hostId: host.id,
          hostType: "ephemeral",
        },
      );
      expect(reportResponse.status).toBe(200);
      await Promise.all([firstReady, secondReady]);

      expect(provisionHostMock).toHaveBeenCalledTimes(1);
      expect(firstProgressEvents).toEqual([
        "host:started",
        "created:sandbox-concurrent-ready",
        "host:completed",
      ]);
      expect(secondProgressEvents).toEqual(
        expect.arrayContaining([
          "created:sandbox-concurrent-ready",
          "host:completed",
        ]),
      );
      expect(getHost(harness.db, host.id)).toMatchObject({
        externalId: "sandbox-concurrent-ready",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("extends sandbox lifetime on activity at most once per debounce window", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-activity",
        id: "host-activity",
        name: "Activity Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(host.id, host.externalId ?? undefined);
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);

      await markSandboxActivity(harness.deps, {
        at: 1_000,
        hostId: host.id,
        source: "events",
      });
      await markSandboxActivity(harness.deps, {
        at: 5_000,
        hostId: host.id,
        source: "command-result",
      });
      await markSandboxActivity(harness.deps, {
        at: 35_000,
        hostId: host.id,
        source: "commands",
      });

      expect(getHost(harness.db, host.id)).toMatchObject({
        lastActivityAt: 35_000,
      });
      expect(sandboxHost.extendTimeout).toHaveBeenCalledTimes(2);
      expect(sandboxHost.extendTimeout).toHaveBeenNthCalledWith(1, 15 * 60 * 1000);
      expect(sandboxHost.extendTimeout).toHaveBeenNthCalledWith(2, 15 * 60 * 1000);
    } finally {
      await harness.cleanup();
    }
  });

  it("persists activity even when timeout extension fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-activity-failure",
        id: "host-activity-failure",
        name: "Activity Failure Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(host.id, host.externalId ?? undefined);
      sandboxHost.extendTimeout.mockRejectedValueOnce(new Error("extend failed"));
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);

      await expect(markSandboxActivity(harness.deps, {
        at: 10_000,
        hostId: host.id,
        source: "events",
      })).resolves.toBeUndefined();

      expect(getHost(harness.db, host.id)).toMatchObject({
        lastActivityAt: 10_000,
      });
      expect(sandboxHost.extendTimeout).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("resumes cached suspended sandboxes before waiting for the daemon session", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-suspended-cached",
        id: "host-suspended-cached",
        name: "Suspended Cached Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(host.id, host.externalId ?? undefined);
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);
      const resumedSandboxHost = createMockSandboxHost(
        host.id,
        host.externalId ?? undefined,
      );
      resumeHostMock.mockResolvedValue(resumedSandboxHost);
      markHostSuspended(harness.db, {
        hostId: host.id,
        suspendedAt: 1_000,
      });

      setTimeout(() => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 5_000,
          hostId: host.id,
          hostName: host.name,
          hostType: host.type,
          instanceId: "instance-suspended-cached",
          leaseTimeoutMs: 30_000,
          protocolVersion: 2,
          dataDir: "/tmp/bb-test-data",
        });
      }, 10);

      const readyPromise = ensureSandboxHostSessionReady(harness.deps, {
        hostId: host.id,
      });
      await vi.advanceTimersByTimeAsync(20);
      const queuedRuntimeSync = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id && command.type === "host.sync_runtime_material",
      );
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queuedRuntimeSync,
        {
          appliedVersion: queuedRuntimeSync.command.version,
        },
        {
          hostId: host.id,
          hostType: "ephemeral",
        },
      );
      expect(reportResponse.status).toBe(200);

      await readyPromise;

      expect(resumeHostMock).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: "test-e2b-api-key",
        externalId: "sandbox-suspended-cached",
        hostId: host.id,
        hostName: host.name,
        progressCallbacks: expect.any(Object),
        serverUrl: harness.deps.config.publicUrl!,
      }));
      expect(harness.deps.sandboxRegistry.get(host.id)).toBe(resumedSandboxHost);
      expect(sandboxHost.resume).not.toHaveBeenCalled();
      expect(getHost(harness.db, host.id)).toMatchObject({
        suspendedAt: null,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("suspends idle sandbox hosts when no work remains", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-idle",
        id: "host-idle",
        name: "Idle Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(host.id, host.externalId ?? undefined);
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-idle",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
        dataDir: "/tmp/bb-test-data",
      });
      markEphemeralHostActivity(harness.db, {
        hostId: host.id,
        lastActivityAt: 1_000,
      });

      await expect(maybeSuspendIdleSandbox(harness.deps, {
        hostId: host.id,
        now: 400_000,
      })).resolves.toBe(true);

      expect(sandboxHost.suspend).toHaveBeenCalledTimes(1);
      expect(getActiveSession(harness.db, host.id)).toBeNull();
      expect(getHost(harness.db, host.id)).toMatchObject({
        suspendedAt: 400_000,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not suspend idle sandbox hosts while host commands are still queued", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-idle-pending-command",
        id: "host-idle-pending-command",
        name: "Idle Pending Command Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(host.id, host.externalId ?? undefined);
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);
      const session = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-idle-pending-command",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
        dataDir: "/tmp/bb-test-data",
      });
      markEphemeralHostActivity(harness.db, {
        hostId: host.id,
        lastActivityAt: 1_000,
      });
      harness.db.insert(hostDaemonCommands).values({
        id: "hcmd_idle_pending_command",
        hostId: host.id,
        sessionId: session.id,
        cursor: 1,
        type: "host.list_files",
        payload: JSON.stringify({
          type: "host.list_files",
          limit: 10,
          path: "/tmp",
        }),
        state: "pending",
        retryCount: 0,
        resultPayload: null,
        createdAt: 1_500,
        fetchedAt: null,
        completedAt: null,
      }).run();

      await expect(maybeSuspendIdleSandbox(harness.deps, {
        hostId: host.id,
        now: 400_000,
      })).resolves.toBe(false);

      expect(sandboxHost.suspend).not.toHaveBeenCalled();
      expect(getHost(harness.db, host.id)?.suspendedAt).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("waits for runtime material sync before reporting a sandbox host ready", async () => {
    const harness = await createTestAppHarness({
      anthropicApiKey: "test-anthropic-key",
      githubPat: "test-github-pat",
      openAiApiKey: "test-openai-key",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-ready-runtime-sync",
        name: "Runtime Sync Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(
        host.id,
        "sandbox-ready-runtime-sync",
      );
      provisionHostMock.mockResolvedValue(sandboxHost);

      setTimeout(() => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 5_000,
          hostId: host.id,
          hostName: host.name,
          hostType: host.type,
          instanceId: "instance-runtime-sync",
          leaseTimeoutMs: 30_000,
          protocolVersion: 2,
          dataDir: "/tmp/bb-test-data",
        });
      }, 10);

      let readyResolved = false;
      const readyPromise = ensureSandboxHostSessionReady(harness.deps, {
        hostId: host.id,
      }).then(() => {
        readyResolved = true;
      });

      await vi.advanceTimersByTimeAsync(20);
      const queuedRuntimeSync = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id && command.type === "host.sync_runtime_material",
      );

      expect(queuedRuntimeSync.command).toMatchObject({
        type: "host.sync_runtime_material",
        version: expect.any(String),
      });
      expect(readyResolved).toBe(false);

      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queuedRuntimeSync,
        {
          appliedVersion: queuedRuntimeSync.command.version,
        },
        {
          hostId: host.id,
          hostType: "ephemeral",
        },
      );
      expect(reportResponse.status).toBe(200);

      await readyPromise;
      expect(readyResolved).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});
