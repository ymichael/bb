import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  getActiveSession,
  archiveThread,
  closeSession,
  fetchCommands,
  getEnvironment,
  getHost,
  getThread,
  hostDaemonCommands,
  openSession,
  transitionThreadStatus,
  upsertHost,
} from "@bb/db";
import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  updateHostLifecycleState,
  upsertEnvironmentOperationRecord,
  upsertThreadOperationRecord,
} from "@bb/db/internal-lifecycle";
import {
  runEphemeralHostCleanupSweep,
  runEnvironmentProvisioningSweep,
  runIdleSandboxSuspendSweep,
  runManagedEnvironmentArchiveCleanupSweep,
  runPeriodicSweeps,
  runThreadLifecycleSweep,
} from "../../src/services/system/periodic-sweeps.js";
import {
  buildDirectEnvironmentProvisionRequest,
  buildSandboxHostEnvironmentProvisionRequest,
} from "../../src/services/environments/environment-provision-request.js";
import { buildEnvironmentProvisionCommand } from "../../src/services/threads/thread-create-helpers.js";
import { requestEnvironmentCleanup } from "../../src/services/environments/environment-cleanup.js";
import { requestThreadStop } from "../../src/services/threads/thread-lifecycle.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  reportNextRuntimeMaterialSyncSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";

const provisionHostMock = vi.fn();
const resumeHostMock = vi.fn();
const resumeSandboxMock = vi.fn();
type SandboxHostMockArgs = Array<object | string | undefined>;

vi.mock("@bb/sandbox-host", () => ({
  DEFAULT_SANDBOX_TIMEOUT_MS: 15 * 60 * 1000,
  provisionHost: (...args: SandboxHostMockArgs) => provisionHostMock(...args),
  resumeHost: (...args: SandboxHostMockArgs) => resumeHostMock(...args),
  resumeSandbox: (...args: SandboxHostMockArgs) => resumeSandboxMock(...args),
}));

interface UnmanagedProvisionCommandArgs {
  environmentId: string;
  path: string;
}

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

interface ThreadStartCommandArgs {
  environmentId: string;
  projectId: string;
  providerId: string;
  threadId: string;
  workspacePath: string;
}

function buildUnmanagedProvisionCommand(
  args: UnmanagedProvisionCommandArgs,
) {
  return {
    type: "environment.provision" as const,
    environmentId: args.environmentId,
    initiator: null,
    workspaceProvisionType: "unmanaged" as const,
    path: args.path,
  };
}

function buildThreadStartCommand(
  args: ThreadStartCommandArgs,
) {
  return {
    type: "thread.start" as const,
    environmentId: args.environmentId,
    threadId: args.threadId,
    workspaceContext: {
      workspacePath: args.workspacePath,
      workspaceProvisionType: "unmanaged" as const,
    },
    projectId: args.projectId,
    providerId: args.providerId,
    eventSequence: 1,
    input: [{ type: "text" as const, text: "Resume work" }],
    options: {
      model: "gpt-5",
      serviceTier: "default" as const,
      reasoningLevel: "medium" as const,
      sandboxMode: "danger-full-access" as const,
    },
    instructions: "You are a helpful assistant.",
    dynamicTools: [],
  };
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

async function waitForAssertion(
  assertion: () => void,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }

    await sleep(10);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for assertion");
}

describe("periodic sweeps", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
    resumeSandboxMock.mockReset();
  });

  it("logs and continues when managed environment archive cleanup rejects", async () => {
    const harness = await createTestAppHarness();
    try {
      const loggerWarn = vi.fn();
      harness.deps.logger.warn = loggerWarn;

      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-sweep",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const firstEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/periodic-sweep-first",
      });
      const secondEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/periodic-sweep-second",
      });
      requestEnvironmentCleanup(harness.deps, {
        environmentId: firstEnvironment.id,
        mode: "force",
      });
      requestEnvironmentCleanup(harness.deps, {
        environmentId: secondEnvironment.id,
        mode: "force",
      });

      const visitedEnvironmentIds: string[] = [];
      await runManagedEnvironmentArchiveCleanupSweep(
        harness.deps,
        async (_deps, args) => {
          if (!args.environmentId) {
            return;
          }
          visitedEnvironmentIds.push(args.environmentId);
          if (args.environmentId === firstEnvironment.id) {
            throw new Error("cleanup failed");
          }
        },
      );

      expect(visitedEnvironmentIds).toEqual([
        firstEnvironment.id,
        secondEnvironment.id,
      ]);
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: firstEnvironment.id,
        }),
        "Managed environment archive cleanup sweep failed",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("does not restart sandbox bootstrap while a prior sweep is still waiting for the first session", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-periodic-sandbox-bootstrap",
        name: "Periodic Sandbox Bootstrap Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-sandbox-bootstrap",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-sandbox-bootstrap",
        status: "provisioning",
      });

      provisionHostMock.mockImplementation(async (args: ProvisionHostMockArgs) => {
        args.progressCallbacks?.onSandboxCreated?.({
          externalId: "sandbox-periodic-bootstrap",
        });
        return createMockSandboxHost(
          args.hostId,
          "sandbox-periodic-bootstrap",
        );
      });

      upsertEnvironmentOperationRecord(harness.db, {
        environmentId: environment.id,
        kind: "provision",
        payload: JSON.stringify(
          buildSandboxHostEnvironmentProvisionRequest({
            sandboxType: "e2b",
            command: buildEnvironmentProvisionCommand({
              environmentId: environment.id,
              hostId: host.id,
              initiator: null,
              workspaceProvisionType: "unmanaged",
              path: environment.path ?? "/tmp/periodic-sandbox-bootstrap",
            }),
          }),
        ),
      });

      await runEnvironmentProvisioningSweep(harness.deps);
      await waitForAssertion(() => {
        expect(provisionHostMock).toHaveBeenCalledTimes(1);
      });

      await runEnvironmentProvisioningSweep(harness.deps);

      expect(provisionHostMock).toHaveBeenCalledTimes(1);

      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-periodic-sandbox-bootstrap",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
      });
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: host.id,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision"
          && command.environmentId === environment.id,
      );

      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        path: "/tmp/periodic-sandbox-bootstrap",
        workspaceProvisionType: "unmanaged",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("retries ephemeral host cleanup on later sweeps after an initial destroy failure", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-periodic-ephemeral",
        id: "host-periodic-ephemeral",
        name: "Periodic Ephemeral Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const session = openSession(harness.db, harness.hub, {
        dataDir: "/tmp/bb-host-data/host-periodic-ephemeral",
        heartbeatIntervalMs: 10_000,
        hostId: host.id,
        hostName: host.name,
        hostType: "ephemeral",
        instanceId: "instance-periodic-ephemeral",
        leaseTimeoutMs: 60_000,
        protocolVersion: 2,
      });
      closeSession(harness.db, harness.hub, session.id, "terminated");
      const cachedHost = {
        destroy: vi
          .fn()
          .mockRejectedValueOnce(new Error("cleanup failed"))
          .mockResolvedValueOnce(undefined),
        extendTimeout: vi.fn().mockResolvedValue(undefined),
        externalId: "sandbox-periodic-ephemeral",
        hostId: host.id,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
      };
      harness.deps.sandboxRegistry.set(host.id, cachedHost);

      await runEphemeralHostCleanupSweep(harness.deps, async (deps, hostId) => {
        const candidate = deps.sandboxRegistry.get(hostId);
        if (!candidate) {
          throw new Error("Expected cached ephemeral host");
        }
        await candidate.destroy();
        deps.sandboxRegistry.remove(hostId);
        upsertHost(deps.db, deps.hub, {
          destroyedAt: Date.now(),
          externalId: candidate.externalId,
          id: hostId,
          name: "Periodic Ephemeral Host",
          provider: "e2b",
          type: "ephemeral",
        });
      });

      expect(getHost(harness.db, host.id)?.destroyedAt).toBeNull();

      await runEphemeralHostCleanupSweep(harness.deps, async (deps, hostId) => {
        const candidate = deps.sandboxRegistry.get(hostId);
        if (!candidate) {
          throw new Error("Expected cached ephemeral host");
        }
        await candidate.destroy();
        deps.sandboxRegistry.remove(hostId);
        upsertHost(deps.db, deps.hub, {
          destroyedAt: Date.now(),
          externalId: candidate.externalId,
          id: hostId,
          name: "Periodic Ephemeral Host",
          provider: "e2b",
          type: "ephemeral",
        });
      });

      expect(cachedHost.destroy).toHaveBeenCalledTimes(2);
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("requeues requested environment provisioning operations without a live command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-provision",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-provision",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-provision",
        status: "provisioning",
      });

      upsertEnvironmentOperationRecord(harness.db, {
        environmentId: environment.id,
        kind: "provision",
        payload: JSON.stringify(
          buildDirectEnvironmentProvisionRequest(
            buildUnmanagedProvisionCommand({
              environmentId: environment.id,
              path: "/tmp/periodic-provision",
            }),
          ),
        ),
      });

      await runEnvironmentProvisioningSweep(harness.deps);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision"
          && command.environmentId === environment.id,
      );
      expect(queued.command).toMatchObject({
        workspaceProvisionType: "unmanaged",
        path: "/tmp/periodic-provision",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not clean up a newly joined ephemeral host before its first daemon session", async () => {
    const harness = await createTestAppHarness();

    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-pending-first-session",
        id: "host-pending-first-session",
        name: "Pending First Session Host",
        provider: "e2b",
        type: "ephemeral",
      });

      const destroySandboxHost = vi.fn(async () => undefined);
      await runEphemeralHostCleanupSweep(harness.deps, destroySandboxHost);

      expect(destroySandboxHost).not.toHaveBeenCalled();
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: null,
        externalId: "sandbox-pending-first-session",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("requeues requested thread.start operations without a live command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-thread-start",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-thread-start",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-thread-start",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      upsertThreadOperationRecord(harness.db, {
        threadId: thread.id,
        kind: "start",
        payload: JSON.stringify(
          buildThreadStartCommand({
            environmentId: environment.id,
            projectId: project.id,
            providerId: thread.providerId,
            threadId: thread.id,
            workspacePath: "/tmp/periodic-thread-start",
          }),
        ),
      });

      await runThreadLifecycleSweep(harness.deps);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start"
          && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("marks provisioning state as failed when environment.provision expires after retry", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-provision-expiry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-provision-expiry",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-provision-expiry",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });

      upsertEnvironmentOperationRecord(harness.db, {
        environmentId: environment.id,
        kind: "provision",
        payload: JSON.stringify(
          buildDirectEnvironmentProvisionRequest(
            buildUnmanagedProvisionCommand({
              environmentId: environment.id,
              path: "/tmp/periodic-provision-expiry",
            }),
          ),
        ),
      });

      await runEnvironmentProvisioningSweep(harness.deps);
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision"
          && command.environmentId === environment.id,
      );

      fetchCommands(harness.db, harness.hub, { hostId: host.id });
      harness.db
        .update(hostDaemonCommands)
        .set({
          state: "fetched",
          fetchedAt: Date.now() - 21 * 60_000,
          retryCount: 1,
        })
        .where(eq(hostDaemonCommands.id, queued.row.id))
        .run();

      await runPeriodicSweeps(harness.deps);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("reissues active thread.stop after an expired stop command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-thread-stop",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-thread-stop",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-thread-stop",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      requestThreadStop(harness.deps, {
        environmentId: environment.id,
        hostId: host.id,
        stopRequestedAt: null,
        threadId: thread.id,
      });
      const firstStop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop"
          && command.threadId === thread.id,
      );

      fetchCommands(harness.db, harness.hub, { hostId: host.id });
      harness.db
        .update(hostDaemonCommands)
        .set({
          state: "fetched",
          fetchedAt: Date.now() - 70_000,
          retryCount: 1,
        })
        .where(eq(hostDaemonCommands.id, firstStop.row.id))
        .run();

      await runPeriodicSweeps(harness.deps);

      const retriedStop = await waitForQueuedCommandAfter(
        harness,
        firstStop.row.cursor,
        ({ command }) =>
          command.type === "thread.stop"
          && command.threadId === thread.id,
      );
      expect(retriedStop.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("suspends idle ephemeral sandboxes during the idle suspend sweep", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-periodic-idle",
        id: "host-periodic-idle",
        name: "Periodic Idle Host",
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
        instanceId: "instance-periodic-idle",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
      });
      updateHostLifecycleState(harness.db, {
        hostId: host.id,
        lastActivityAt: 1_000,
      });

      await runIdleSandboxSuspendSweep(harness.deps);

      expect(sandboxHost.suspend).toHaveBeenCalledTimes(1);
      expect(getActiveSession(harness.db, host.id)).toBeNull();
      expect(getHost(harness.db, host.id)?.suspendedAt).toEqual(expect.any(Number));
    } finally {
      await harness.cleanup();
    }
  });

  it("finalizes archived stop-requested threads once they are no longer active", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-thread-stop-finalize",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-thread-stop-finalize",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/periodic-thread-stop-finalize",
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      archiveThread(harness.db, harness.hub, thread.id);
      requestEnvironmentCleanup(harness.deps, {
        environmentId: environment.id,
        mode: "force",
      });
      requestThreadStop(harness.deps, {
        environmentId: environment.id,
        hostId: host.id,
        stopRequestedAt: null,
        threadId: thread.id,
      });
      const queuedStop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop"
          && command.threadId === thread.id,
      );
      transitionThreadStatus(harness.db, harness.hub, thread.id, "idle");

      await runThreadLifecycleSweep(harness.deps);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        archivedAt: expect.any(Number),
        stopRequestedAt: null,
      });
      expect(
        harness.db
          .select({ state: hostDaemonCommands.state })
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, queuedStop.row.id))
          .get(),
      ).toEqual({ state: "error" });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        queuedStop.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy"
          && command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
