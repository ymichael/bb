import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  claimDraft,
  getActiveSession,
  archiveThread,
  closeSession,
  fetchCommands,
  getEnvironment,
  getDraft,
  getEnvironmentOperation,
  getHost,
  getHostOperation,
  getThread,
  getThreadOperation,
  hostDaemonCommands,
  hostDaemonSessions,
  markEphemeralHostActivity,
  openSession,
  queueCommand,
  queuedThreadMessages,
  reportCommandResult,
  transitionThreadStatus,
  upsertHost,
} from "@bb/db";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  markHostOperationRecordQueued,
  upsertHostOperationRecord,
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
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../../src/services/environments/environment-cleanup.js";
import { requestThreadStop } from "../../src/services/threads/thread-lifecycle.js";
import { sendQueuedDraft } from "../../src/services/threads/queued-drafts.js";
import {
  seedEnvironment,
  seedDraft,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  createAllowOnceResolution,
  createCommandApprovalPayload,
} from "../helpers/pending-interactions.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  reportQueuedCommandError,
  reportNextRuntimeMaterialSyncSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import {
  queueEnvironmentDestroyLifecycleCommand,
  queueEnvironmentProvisionLifecycleCommand,
  queueThreadStartLifecycleCommand,
} from "../helpers/lifecycle-commands.js";

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
    eventSequence: 1,
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
          clientRequestSequence: 1,
          environmentIntent: {
            type: "reuse",
            environmentId: environment.id,
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
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

  it("auto-sends queued drafts left on idle threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-queued-draft",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-queued-draft-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-queued-draft-environment",
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
        providerThreadId: "provider-periodic-queued-draft",
      });
      const draft = seedDraft(harness.deps, {
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
          providerThreadId: "provider-periodic-queued-draft",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends stale claimed queued drafts left on idle threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-stale-claimed-draft",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-stale-claimed-draft-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-stale-claimed-draft-environment",
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
        providerThreadId: "provider-periodic-stale-claimed-draft",
      });
      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Recover stale claimed follow-up" }],
      });
      expect(claimDraft(harness.db, harness.hub, draft.id)?.id).toBe(draft.id);
      harness.db
        .update(queuedThreadMessages)
        .set({ claimedAt: Date.now() - 10 * 60_000 })
        .where(eq(queuedThreadMessages.id, draft.id))
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
          providerThreadId: "provider-periodic-stale-claimed-draft",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not double-send when a stale draft claimant resumes after recovery", async () => {
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
      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Recover without duplicate" }],
      });

      const firstSend = sendQueuedDraft(harness.deps, {
        draftId: draft.id,
        threadId: thread.id,
      });
      const firstPreferencesRead = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path.endsWith("/PREFERENCES.md"),
      );
      const firstClaim = getDraft(harness.db, draft.id);
      expect(firstClaim?.claimToken).toMatch(/^dclaim_/);
      harness.db
        .update(queuedThreadMessages)
        .set({ claimedAt: Date.now() - 10 * 60_000 })
        .where(eq(queuedThreadMessages.id, draft.id))
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
      expect(getDraft(harness.db, draft.id)).toBeNull();

      await reportQueuedCommandError(harness, firstPreferencesRead, {
        errorCode: "ENOENT",
        errorMessage: "No preferences file",
      });
      await expect(firstSend).rejects.toMatchObject({
        body: { code: "draft_claim_lost" },
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

  it("replays active environment provision operations attached to settled commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-periodic-settled-provision",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-settled-provision",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-settled-provision",
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
          path: "/tmp/periodic-settled-provision",
        },
      });
      reportCommandResult(harness.db, harness.hub, {
        commandId: command.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({
          path: "/tmp/periodic-settled-provision",
          branchName: "bb/periodic-settled-provision",
          defaultBranch: "main",
          isGitRepo: true,
          isWorktree: false,
          transcript: [],
        }),
      });

      await runPeriodicSweeps(harness.deps);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("ready");
      expect(getThread(harness.db, thread.id)?.status).toBe("provisioning");
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "provision",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: null,
        state: "completed",
      });
      const provisionCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.provision"))
        .all();
      expect(provisionCommands).toHaveLength(1);
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

  it("replays active thread.start operations attached to settled commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-periodic-settled-thread-start",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-settled-thread-start",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-settled-thread-start",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const command = queueThreadStartLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        threadId: thread.id,
        command: buildThreadStartCommand({
          environmentId: environment.id,
          projectId: project.id,
          providerId: thread.providerId,
          threadId: thread.id,
          workspacePath: "/tmp/periodic-settled-thread-start",
        }),
      });
      reportCommandResult(harness.db, harness.hub, {
        commandId: command.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({
          providerThreadId: "provider-periodic-settled-thread-start",
        }),
      });

      await runPeriodicSweeps(harness.deps);

      expect(
        getThreadOperation(harness.db, {
          threadId: thread.id,
          kind: "start",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: null,
        state: "completed",
      });
      const startCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all();
      expect(startCommands).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("replays active environment destroy operations attached to settled commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-periodic-settled-destroy",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-settled-destroy",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/periodic-settled-destroy",
        projectId: project.id,
        status: "destroying",
        workspaceProvisionType: "managed-worktree",
      });
      requestEnvironmentCleanup(harness.deps, {
        environmentId: environment.id,
        mode: "force",
      });
      const command = queueEnvironmentDestroyLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.destroy",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
        },
      });
      reportCommandResult(harness.db, harness.hub, {
        commandId: command.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      await runPeriodicSweeps(harness.deps);

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupRequestedAt: null,
        status: "destroyed",
      });
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "destroy",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: null,
        state: "completed",
      });

      await advanceEnvironmentCleanup(harness.deps, {
        environmentId: environment.id,
      });
      const destroyCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.destroy"))
        .all();
      expect(destroyCommands).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("replays settled sessionless environment.destroy commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        name: "host-periodic-sessionless-destroy",
        type: "persistent",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-sessionless-destroy",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/periodic-sessionless-destroy",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });

      requestEnvironmentCleanup(harness.deps, {
        environmentId: environment.id,
        mode: "force",
      });
      await advanceEnvironmentCleanup(harness.deps, {
        environmentId: environment.id,
      });
      const queuedDestroy = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(queuedDestroy.row.sessionId).toBeNull();
      reportCommandResult(harness.db, harness.hub, {
        commandId: queuedDestroy.row.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      await runPeriodicSweeps(harness.deps);

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupRequestedAt: null,
        status: "destroyed",
      });
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "destroy",
        }),
      ).toMatchObject({
        commandId: queuedDestroy.row.id,
        failureReason: null,
        state: "completed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("replays active thread.stop operations attached to settled commands without reissuing stop", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-periodic-settled-thread-stop",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-settled-thread-stop",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-settled-thread-stop",
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
      const command = await waitForQueuedCommand(
        harness,
        ({ command: queuedCommand }) =>
          queuedCommand.type === "thread.stop" &&
          queuedCommand.threadId === thread.id,
      );
      reportCommandResult(harness.db, harness.hub, {
        commandId: command.row.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      await runPeriodicSweeps(harness.deps);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
        stopRequestedAt: null,
      });
      expect(
        getThreadOperation(harness.db, {
          threadId: thread.id,
          kind: "stop",
        }),
      ).toMatchObject({
        commandId: command.row.id,
        failureReason: null,
        state: "completed",
      });
      const stopCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.stop"))
        .all();
      expect(stopCommands).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("replays settled sessionless thread.stop commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        name: "host-periodic-sessionless-thread-stop",
        type: "persistent",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/periodic-sessionless-thread-stop",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/periodic-sessionless-thread-stop",
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
      const queuedStop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(queuedStop.row.sessionId).toBeNull();
      reportCommandResult(harness.db, harness.hub, {
        commandId: queuedStop.row.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      await runPeriodicSweeps(harness.deps);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
        stopRequestedAt: null,
      });
      expect(
        getThreadOperation(harness.db, {
          threadId: thread.id,
          kind: "stop",
        }),
      ).toMatchObject({
        commandId: queuedStop.row.id,
        failureReason: null,
        state: "completed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("replays active runtime material operations attached to settled commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-periodic-settled-runtime",
        type: "ephemeral",
      });
      upsertHostOperationRecord(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
        payload: JSON.stringify({
          appliedVersion: null,
          desiredVersion: "runtime-periodic-settled",
        }),
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "host.sync_runtime_material",
        payload: JSON.stringify({
          type: "host.sync_runtime_material",
          version: "runtime-periodic-settled",
        }),
      });
      markHostOperationRecordQueued(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
        commandId: command.id,
      });
      reportCommandResult(harness.db, harness.hub, {
        commandId: command.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({
          appliedVersion: "runtime-periodic-settled",
        }),
      });

      await runPeriodicSweeps(harness.deps);

      expect(
        getHostOperation(harness.db, {
          hostId: host.id,
          kind: "sync_runtime_material",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: null,
        state: "completed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("replays resolving interactions attached to settled commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-periodic-settled-interaction",
      });
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
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-periodic-settled-interaction",
            providerId: "codex",
            providerThreadId: "provider-thread-periodic-settled-interaction",
            providerRequestId: "request-periodic-settled-interaction",
            payload: createCommandApprovalPayload({
              itemId: "item-periodic-settled-interaction",
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

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
        resolution: createAllowOnceResolution(),
      });
      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === registered.interaction.id,
      );
      reportCommandResult(harness.db, harness.hub, {
        commandId: queuedResolve.row.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      await runPeriodicSweeps(harness.deps);

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: registered.interaction.id,
        }),
      ).toMatchObject({
        status: "resolved",
        statusReason: null,
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

      harness.db
        .update(hostDaemonSessions)
        .set({ leaseExpiresAt: Date.now() - 1_000 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      await runPeriodicSweeps(harness.deps);

      expect(getActiveSession(harness.db, host.id)).toBeNull();
      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: registered.interaction.id,
        }),
      ).toMatchObject({
        status: "interrupted",
        statusReason:
          "Host daemon session expired while awaiting user interaction; retry the thread to continue",
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
});
