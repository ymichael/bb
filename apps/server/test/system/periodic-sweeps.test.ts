import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  COMPLETED_COMMAND_PAYLOAD_RETENTION_MS,
  claimQueuedThreadMessage,
  getActiveSession,
  archiveThread,
  closeSession,
  fetchCommands,
  getEnvironment,
  getQueuedThreadMessage,
  getEnvironmentOperation,
  getHost,
  getThread,
  getThreadOperation,
  hostDaemonCommands,
  hostDaemonSessions,
  markThreadDeleted,
  markEphemeralHostActivity,
  openSession,
  queueCommand,
  queuedThreadMessages,
  reportCommandResult,
  transitionThreadStatus,
  upsertHost,
} from "@bb/db";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import { threadResponseSchema } from "@bb/server-contract";
import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import { sendQueuedMessage } from "../../src/services/threads/queued-messages.js";
import {
  seedEnvironment,
  seedQueuedMessage,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportNextRuntimeMaterialSyncSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { queueEnvironmentProvisionLifecycleCommand } from "../helpers/lifecycle-commands.js";
import { readJson } from "../helpers/json.js";

const provisionHostMock = vi.fn();
const resumeHostMock = vi.fn();
const resumeSandboxMock = vi.fn();
type SandboxHostMockArgs = Array<object | string | undefined>;

vi.mock("@bb/sandbox-host", () => ({
  DEFAULT_SANDBOX_TIMEOUT_MS: 15 * 60 * 1000,
  SANDBOX_DATA_DIR: "/tmp/bb-data",
  provisionHost: (...args: SandboxHostMockArgs) => provisionHostMock(...args),
  resumeHost: (...args: SandboxHostMockArgs) => resumeHostMock(...args),
  resumeSandbox: (...args: SandboxHostMockArgs) => resumeSandboxMock(...args),
}));

interface UnmanagedProvisionCommandArgs {
  environmentId: string;
  path: string;
}

interface MockSandboxHost {
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
  extendTimeout: ReturnType<typeof vi.fn<(timeoutMs: number) => Promise<void>>>;
  externalId: string;
  hostId: string;
  resume: ReturnType<typeof vi.fn<() => Promise<void>>>;
  suspend: ReturnType<typeof vi.fn<() => Promise<void>>>;
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

function buildUnmanagedProvisionCommand(args: UnmanagedProvisionCommandArgs) {
  return {
    type: "environment.provision" as const,
    environmentId: args.environmentId,
    initiator: null,
    workspaceProvisionType: "unmanaged" as const,
    path: args.path,
  };
}

function buildThreadStartCommand(args: ThreadStartCommandArgs) {
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
    requestId: "creq_23456789ab",
    input: [{ type: "text" as const, text: "Resume work" }],
    options: {
      model: "gpt-5",
      serviceTier: "default" as const,
      reasoningLevel: "medium" as const,
      permissionMode: "full" as const,
      permissionEscalation: null,
    },
    instructions: "You are a helpful assistant.",
    dynamicTools: [],
    instructionMode: "append" as const,
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

  it("prunes old completed daemon command blobs", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-command-prune",
      });
      const oldCompletedAt =
        Date.now() - COMPLETED_COMMAND_PAYLOAD_RETENTION_MS - 1_000;
      const freshCompletedAt = Date.now();
      const oldCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        type: "workspace.status",
        payload: JSON.stringify({ old: true }),
      });
      const freshCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        type: "workspace.diff",
        payload: JSON.stringify({ fresh: true }),
      });

      reportCommandResult(harness.db, harness.hub, {
        commandId: oldCommand.id,
        state: "success",
        completedAt: oldCompletedAt,
        resultPayload: JSON.stringify({ status: "clean" }),
      });
      reportCommandResult(harness.db, harness.hub, {
        commandId: freshCommand.id,
        state: "success",
        completedAt: freshCompletedAt,
        resultPayload: JSON.stringify({ diff: "fresh" }),
      });

      await runPeriodicSweeps(harness.deps);

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, oldCommand.id))
          .get(),
      ).toMatchObject({
        completedAt: oldCompletedAt,
        cursor: oldCommand.cursor,
        payload: "{}",
        resultPayload: null,
        state: "success",
      });
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, freshCommand.id))
          .get(),
      ).toMatchObject({
        payload: JSON.stringify({ fresh: true }),
        resultPayload: JSON.stringify({ diff: "fresh" }),
        state: "success",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("logs and continues when managed environment archive cleanup rejects", async () => {
    const harness = await createTestAppHarness();
    try {
      const loggerWarn = vi.fn();
      harness.deps.logger.warn = loggerWarn;

      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-sweep",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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

      provisionHostMock.mockImplementation(
        async (args: ProvisionHostMockArgs) => {
          args.progressCallbacks?.onSandboxCreated?.({
            externalId: "sandbox-periodic-bootstrap",
          });
          return createMockSandboxHost(
            args.hostId,
            "sandbox-periodic-bootstrap",
          );
        },
      );

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
            provisioningId: "epv-periodic-sandbox-bootstrap",
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
        dataDir: "/tmp/bb-test-data",
      });
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: host.id,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
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
          buildDirectEnvironmentProvisionRequest({
            command: buildUnmanagedProvisionCommand({
              environmentId: environment.id,
              path: "/tmp/periodic-provision",
            }),
            provisioningId: "epv-periodic-provision",
          }),
        ),
      });

      await runEnvironmentProvisioningSweep(harness.deps);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
      );
      expect(queued.command).toMatchObject({
        workspaceProvisionType: "unmanaged",
        path: "/tmp/periodic-provision",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("advances requested thread provisioning operations without a live command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-thread-provision",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-thread-provision",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-thread-provision",
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
        title: "Periodic thread provision",
      });

      upsertThreadOperationRecord(harness.db, {
        threadId: thread.id,
        kind: "provision",
        payload: JSON.stringify({
          clientRequestId: "creq_23456789ab",
          environmentIntent: {
            type: "reuse",
            environmentId: environment.id,
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          input: [{ type: "text", text: "short" }],
          titleProvided: false,
        }),
        provisioningState: {
          environmentId: null,
          provisionEventSequence: null,
          provisioningId: "tpv-periodic-thread-provision",
          stage: "metadata-pending",
          workspaceReadyEventSequence: null,
        },
      });

      await runThreadLifecycleSweep(harness.deps);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "provisioning",
      });
      expect(
        getThreadOperation(harness.db, {
          threadId: thread.id,
          kind: "provision",
        }),
      ).toMatchObject({
        state: "completed",
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
          command.type === "thread.start" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends queued messages left on idle threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-queued-message",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-queued-message-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-queued-message-environment",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-periodic-queued-message",
      });
      const queuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Recover queued follow-up" }],
      });

      await runPeriodicSweeps(harness.deps);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        input: [{ type: "text", text: "Recover queued follow-up" }],
        resumeContext: {
          providerThreadId: "provider-periodic-queued-message",
        },
      });
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends stale claimed queued messages left on idle threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-stale-claimed-queued-message",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-stale-claimed-queued-message-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-stale-claimed-queued-message-environment",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-periodic-stale-claimed-queued-message",
      });
      const queuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Recover stale claimed follow-up" }],
      });
      expect(
        claimQueuedThreadMessage(harness.db, harness.hub, queuedMessage.id)?.id,
      ).toBe(queuedMessage.id);
      harness.db
        .update(queuedThreadMessages)
        .set({ claimedAt: Date.now() - 10 * 60_000 })
        .where(eq(queuedThreadMessages.id, queuedMessage.id))
        .run();

      await runPeriodicSweeps(harness.deps);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        input: [{ type: "text", text: "Recover stale claimed follow-up" }],
        resumeContext: {
          providerThreadId: "provider-periodic-stale-claimed-queued-message",
        },
      });
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not double-send when a stale queued message claimant resumes after recovery", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-stale-claim-race",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-stale-claim-race-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-stale-claim-race-environment",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-periodic-stale-claim-race",
      });
      const queuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Recover without duplicate" }],
      });

      const firstSend = sendQueuedMessage(harness.deps, {
        queuedMessageId: queuedMessage.id,
        mode: "auto",
        threadId: thread.id,
      });
      const firstPreferencesRead = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path.endsWith("/PREFERENCES.md"),
      );
      const firstClaim = getQueuedThreadMessage(harness.db, queuedMessage.id);
      expect(firstClaim?.claimToken).toMatch(/^qclaim_/);
      harness.db
        .update(queuedThreadMessages)
        .set({ claimedAt: Date.now() - 10 * 60_000 })
        .where(eq(queuedThreadMessages.id, queuedMessage.id))
        .run();

      const recoverySweep = runPeriodicSweeps(harness.deps);
      const secondPreferencesRead = await waitForQueuedCommandAfter(
        harness,
        firstPreferencesRead.row.cursor,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path.endsWith("/PREFERENCES.md"),
      );
      await reportQueuedCommandError(harness, secondPreferencesRead, {
        errorCode: "ENOENT",
        errorMessage: "No preferences file",
      });

      const recoveredSubmit = await waitForQueuedCommandAfter(
        harness,
        secondPreferencesRead.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(recoveredSubmit.command).toMatchObject({
        input: [{ type: "text", text: "Recover without duplicate" }],
      });
      await recoverySweep;
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();

      await reportQueuedCommandError(harness, firstPreferencesRead, {
        errorCode: "ENOENT",
        errorMessage: "No preferences file",
      });
      await expect(firstSend).rejects.toMatchObject({
        body: { code: "queued_message_claim_lost" },
      });

      const turnSubmits = harness.db
        .select()
        .from(hostDaemonCommands)
        .all()
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)))
        .filter(
          (command) =>
            command.type === "turn.submit" && command.threadId === thread.id,
        );
      expect(turnSubmits).toHaveLength(1);
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
          buildDirectEnvironmentProvisionRequest({
            command: buildUnmanagedProvisionCommand({
              environmentId: environment.id,
              path: "/tmp/periodic-provision-expiry",
            }),
            provisioningId: "epv-periodic-provision-expiry",
          }),
        ),
      });

      await runEnvironmentProvisioningSweep(harness.deps);
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
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

  it("leaves active provision operations with non-settled commands alone", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-periodic-active-provision",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-active-provision",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-active-provision",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: null,
          workspaceProvisionType: "unmanaged",
          path: "/tmp/periodic-active-provision",
        },
      });

      await runPeriodicSweeps(harness.deps);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "provisioning",
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("provisioning");
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "provision",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: null,
        state: "queued",
      });
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, command.id))
          .get(),
      ).toMatchObject({
        state: "pending",
      });
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
          command.type === "thread.stop" && command.threadId === thread.id,
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
          command.type === "thread.stop" && command.threadId === thread.id,
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
      const sandboxHost = createMockSandboxHost(
        host.id,
        host.externalId ?? undefined,
      );
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-periodic-idle",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
        dataDir: "/tmp/bb-test-data",
      });
      markEphemeralHostActivity(harness.db, {
        hostId: host.id,
        lastActivityAt: 1_000,
      });

      await runIdleSandboxSuspendSweep(harness.deps);

      expect(sandboxHost.suspend).toHaveBeenCalledTimes(1);
      expect(getActiveSession(harness.db, host.id)).toBeNull();
      expect(getHost(harness.db, host.id)?.suspendedAt).toEqual(
        expect.any(Number),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("does not suspend active ephemeral sandboxes during the idle suspend sweep", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-periodic-active",
        id: "host-periodic-active",
        name: "Periodic Active Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(
        host.id,
        host.externalId ?? undefined,
      );
      harness.deps.sandboxRegistry.set(host.id, sandboxHost);
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-periodic-active",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
        dataDir: "/tmp/bb-test-data",
      });
      markEphemeralHostActivity(harness.db, {
        hostId: host.id,
        lastActivityAt: Date.now(),
      });

      await runIdleSandboxSuspendSweep(harness.deps);

      expect(sandboxHost.suspend).not.toHaveBeenCalled();
      expect(getActiveSession(harness.db, host.id)).not.toBeNull();
      expect(getHost(harness.db, host.id)?.suspendedAt).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("interrupts pending interactions when a host session lease expires", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-periodic-expired-interaction",
      });
      const socket = {
        close: vi.fn(),
        send: vi.fn(),
      };
      harness.hub.registerDaemon(session.id, host.id, socket);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-periodic-expired-interaction",
        providerThreadId: "provider-thread-periodic-expired-interaction",
      });

      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-periodic-expired-interaction",
            providerId: "codex",
            providerThreadId: "provider-thread-periodic-expired-interaction",
            providerRequestId: "request-periodic-expired-interaction",
            payload: createCommandApprovalPayload({
              itemId: "item-periodic-expired-interaction",
              reason: "Approve command",
              command: "git push",
              cwd: "/tmp/project",
            }),
          },
          sessionId: session.id,
        });
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
      }
      const notifyThread = vi.spyOn(harness.hub, "notifyThread");

      harness.db
        .update(hostDaemonSessions)
        .set({ leaseExpiresAt: Date.now() - 1_000 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      await runPeriodicSweeps(harness.deps);

      expect(getActiveSession(harness.db, host.id)).toBeNull();
      const closedSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(closedSession).toMatchObject({
        status: "closed",
        closeReason: "expired",
      });
      expect(socket.close).toHaveBeenCalled();
      expect(notifyThread).toHaveBeenCalledWith(thread.id, ["status-changed"]);
      const threadResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
      );
      expect(threadResponse.status).toBe(200);
      expect(
        threadResponseSchema.parse(await readJson(threadResponse)).runtime,
      ).toMatchObject({
        displayStatus: "waiting-for-host",
        hostReconnectGraceExpiresAt: null,
      });
      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: registered.interaction.id,
        }),
      ).toMatchObject({
        status: "interrupted",
        statusReason:
          "Host daemon connection expired while awaiting user interaction; retry the thread to continue",
      });
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
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-periodic-thread-stop-finalize",
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
          command.type === "thread.stop" && command.threadId === thread.id,
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
      expect(
        listQueuedThreadCommands(harness, "thread.archive", thread.id),
      ).toEqual([
        {
          type: "thread.archive",
          environmentId: environment.id,
          threadId: thread.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
          providerId: "codex",
          providerThreadId: "provider-periodic-thread-stop-finalize",
        },
      ]);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        queuedStop.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("skips native archive forwarding when a deleted archived thread is finalized", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-deleted-archive-skip",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-deleted-archive-skip",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/periodic-deleted-archive-skip",
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-deleted-archive-skip",
      });

      archiveThread(harness.db, harness.hub, thread.id);
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
      requestThreadStop(harness.deps, {
        environmentId: environment.id,
        hostId: host.id,
        stopRequestedAt: null,
        threadId: thread.id,
      });
      const queuedStop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      transitionThreadStatus(harness.db, harness.hub, thread.id, "idle");

      await runThreadLifecycleSweep(harness.deps);

      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(
        harness.db
          .select({ state: hostDaemonCommands.state })
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, queuedStop.row.id))
          .get(),
      ).toEqual({ state: "error" });
      expect(
        listQueuedThreadCommands(harness, "thread.archive", thread.id),
      ).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
