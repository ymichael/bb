import { and, eq } from "drizzle-orm";
import {
  createManagerThreadNudge,
  events,
  getManagerThreadNudge,
  hostDaemonCommands,
  markHostSuspended,
  openSession,
  threads,
  upsertHost,
  updateManagerThreadNudge,
} from "@bb/db";
import { threadScope, turnRequestEventDataSchema, turnScope } from "@bb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepDueNudges } from "../../src/services/scheduling/nudge-sweep.js";
import { appendClientTurnEvent } from "../../src/services/threads/thread-events.js";
import {
  reportNextRuntimeMaterialSyncSuccess,
  reportQueuedCommandError,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const provisionHostMock = vi.fn();
const resumeHostMock = vi.fn();
type SandboxHostMockArgs = Array<object | string | undefined>;

vi.mock("@bb/sandbox-host", () => ({
  DEFAULT_SANDBOX_TIMEOUT_MS: 15 * 60 * 1000,
  SANDBOX_DATA_DIR: "/tmp/bb-data",
  provisionHost: (...args: SandboxHostMockArgs) => provisionHostMock(...args),
  resumeHost: (...args: SandboxHostMockArgs) => resumeHostMock(...args),
}));

type TestHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

interface MockSandboxHost {
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
  extendTimeout: ReturnType<typeof vi.fn<(timeoutMs: number) => Promise<void>>>;
  externalId: string;
  hostId: string;
  resume: ReturnType<typeof vi.fn<() => Promise<void>>>;
  suspend: ReturnType<typeof vi.fn<() => Promise<void>>>;
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

function seedRunnableManagerThread(args: {
  environmentId: string;
  harness: TestHarness;
  projectId: string;
}) {
  const thread = seedThread(args.harness.deps, {
    projectId: args.projectId,
    environmentId: args.environmentId,
    status: "idle",
    type: "manager",
  });
  seedEvent(args.harness.deps, {
    threadId: thread.id,
    environmentId: args.environmentId,
    providerThreadId: "provider-manager-thread",
    sequence: 1,
    type: "thread/identity",
    scope: threadScope(),
    data: {},
  });
  appendClientTurnEvent(args.harness.deps, {
    threadId: thread.id,
    environmentId: args.environmentId,
    type: "client/turn/requested",
    input: [{ type: "text", text: "Bootstrap manager" }],
    target: { kind: "thread-start" },
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    initiator: "user",
    requestMethod: "thread/start",
    source: "spawn",
  });
  return thread;
}

describe("nudge sweep", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });

  it("queues turn.submit for due manager nudges", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-run",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-sweep-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "daily-recap",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      expect(readPreferences.command.type).toBe("host.read_file");
      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (queuedTurnSubmit.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      expect(queuedTurnSubmit.command.input).toEqual([
        {
          type: "text",
          text: "[bb system] Scheduled nudge: daily-recap. Check ASYNC.md.",
        },
      ]);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("active");

      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("resumes suspended sandbox hosts before queueing due manager nudges", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-nudge-resume",
        id: "host-nudge-resume",
        name: "Nudge Resume Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const sandboxHost = createMockSandboxHost(
        host.id,
        host.externalId ?? undefined,
      );
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

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-resume-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "resume-recap",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      setTimeout(() => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 5_000,
          hostId: host.id,
          hostName: host.name,
          hostType: host.type,
          instanceId: "instance-nudge-resume",
          leaseTimeoutMs: 30_000,
          protocolVersion: 2,
          dataDir: `/tmp/bb-host-data/${host.id}`,
        });
      }, 10);

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: host.id,
      });

      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      expect(harness.deps.sandboxRegistry.get(host.id)).toBe(
        resumedSandboxHost,
      );
      const queuedTurnSubmit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (queuedTurnSubmit.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      expect(queuedTurnSubmit.command.input).toEqual([
        {
          type: "text",
          text: "[bb system] Scheduled nudge: resume-recap. Check ASYNC.md.",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips due nudges that already have a pending turn.submit command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-nudge-pending",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-pending-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "deploy-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      harness.db
        .insert(hostDaemonCommands)
        .values({
          id: "cmd_pending_turn_submit",
          hostId: host.id,
          sessionId: session.id,
          cursor: 1,
          type: "turn.submit",
          payload: JSON.stringify({
            type: "turn.submit",
            environmentId: environment.id,
            threadId: thread.id,
            requestId: "creq_23456789ab",
            input: [{ type: "text", text: "Existing pending nudge" }],
            options: {
              model: "gpt-5",
              reasoningLevel: "medium",
              permissionMode: "full",
              serviceTier: "default",
              source: "client/turn/requested",
            },
            resumeContext: {
              workspaceContext: {
                workspacePath: environment.path,
                workspaceProvisionType: environment.workspaceProvisionType,
              },
              projectId: project.id,
              providerId: thread.providerId,
              providerThreadId: "provider-manager-thread",
              instructions: "manager instructions",
              dynamicTools: [],
              instructionMode: "append",
            },
            target: { mode: "start" },
          }),
          state: "pending",
          retryCount: 0,
          createdAt: now,
        })
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        1,
      );
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips due nudges that already have a pending native archive command", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-nudge-pending-native-archive",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-pending-native-archive-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "archive-sync-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      harness.db
        .insert(hostDaemonCommands)
        .values({
          id: "cmd_pending_native_archive",
          hostId: host.id,
          sessionId: session.id,
          cursor: 1,
          type: "thread.archive",
          payload: JSON.stringify({
            type: "thread.archive",
            environmentId: environment.id,
            threadId: thread.id,
            workspaceContext: {
              workspacePath: environment.path,
              workspaceProvisionType: environment.workspaceProvisionType,
            },
            providerId: thread.providerId,
            providerThreadId: "provider-manager-thread",
          }),
          state: "pending",
          retryCount: 0,
          createdAt: now,
        })
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "thread.archive"))
          .all(),
      ).toHaveLength(1);
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores disabled nudges even if nextFireAt is in the past", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-disabled",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-disabled-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "disabled-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: false,
        nextFireAt: now - 1,
      });

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        enabled: false,
        lastFiredAt: null,
        nextFireAt: now - 1,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes due nudges for archived threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-archived",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-archived-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "archived-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });
      harness.db
        .update(threads)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      await sweepDueNudges(harness.deps, { now });

      expect(getManagerThreadNudge(harness.db, nudge.id)).toBeNull();
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("queues due nudges as auto submits when the manager is already active", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-active",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-active-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "active-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 3,
        type: "turn/started",
        scope: turnScope("turn-active-nudge"),
        data: {},
      });
      harness.db
        .update(threads)
        .set({ status: "active", updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurnSubmit.command).toMatchObject({
        input: [
          {
            type: "text",
            text: "[bb system] Scheduled nudge: active-check. Check ASYNC.md.",
          },
        ],
        target: {
          mode: "auto",
          expectedTurnId: "turn-active-nudge",
        },
      });

      const clientRequests = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(events.sequence)
        .all();
      const nudgeRequest = clientRequests[clientRequests.length - 1];
      if (!nudgeRequest) {
        throw new Error("Expected nudge client request event");
      }
      const nudgeRequestData = turnRequestEventDataSchema.parse(
        JSON.parse(nudgeRequest.data),
      );
      expect(nudgeRequestData.target).toEqual({
        kind: "auto",
        expectedTurnId: "turn-active-nudge",
      });
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: now,
      });
      expect(
        getManagerThreadNudge(harness.db, nudge.id)?.nextFireAt,
      ).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue a stale start nudge when the thread becomes active during preparation", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-idle-active-race",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-idle-active-race-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "idle-active-race",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 3,
        type: "turn/started",
        scope: turnScope("turn-became-active"),
        data: {},
      });
      harness.db
        .update(threads)
        .set({ status: "active", updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, thread.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toHaveLength(1);
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: null,
        nextFireAt: now - 1,
      });

      const retrySweepPromise = sweepDueNudges(harness.deps, { now: now + 1 });
      const retryReadPreferences = await waitForQueuedCommandAfter(
        harness,
        readPreferences.row.cursor,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      const retryPreferencesResponse = await reportQueuedCommandError(
        harness,
        retryReadPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(retryPreferencesResponse.status).toBe(200);

      await retrySweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommandAfter(
        harness,
        retryReadPreferences.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurnSubmit.command).toMatchObject({
        target: {
          mode: "auto",
          expectedTurnId: "turn-became-active",
        },
      });
      const clientRequests = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(events.sequence)
        .all();
      const nudgeRequest = clientRequests[clientRequests.length - 1];
      if (!nudgeRequest) {
        throw new Error("Expected retry nudge client request event");
      }
      const nudgeRequestData = turnRequestEventDataSchema.parse(
        JSON.parse(nudgeRequest.data),
      );
      expect(nudgeRequestData.target).toEqual({
        kind: "auto",
        expectedTurnId: "turn-became-active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue a stale active nudge when the active turn changes during preparation", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-active-race",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-active-race-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "active-race",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 3,
        type: "turn/started",
        scope: turnScope("turn-original-active"),
        data: {},
      });
      harness.db
        .update(threads)
        .set({ status: "active", updatedAt: now })
        .where(eq(threads.id, thread.id))
        .run();

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const preferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-thread",
        sequence: 4,
        type: "turn/started",
        scope: turnScope("turn-replaced-active"),
        data: {},
      });

      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: null,
        nextFireAt: now - 1,
      });

      const retrySweepPromise = sweepDueNudges(harness.deps, { now: now + 1 });
      const retryReadPreferences = await waitForQueuedCommandAfter(
        harness,
        readPreferences.row.cursor,
        ({ command }) =>
          command.type === "host.read_file" && command.path === preferencesPath,
      );
      const retryPreferencesResponse = await reportQueuedCommandError(
        harness,
        retryReadPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(retryPreferencesResponse.status).toBe(200);

      await retrySweepPromise;

      const queuedTurnSubmit = await waitForQueuedCommandAfter(
        harness,
        retryReadPreferences.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurnSubmit.command).toMatchObject({
        target: {
          mode: "auto",
          expectedTurnId: "turn-replaced-active",
        },
      });
      const clientRequests = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(events.sequence)
        .all();
      const nudgeRequest = clientRequests[clientRequests.length - 1];
      if (!nudgeRequest) {
        throw new Error("Expected retry nudge client request event");
      }
      const nudgeRequestData = turnRequestEventDataSchema.parse(
        JSON.parse(nudgeRequest.data),
      );
      expect(nudgeRequestData.target).toEqual({
        kind: "auto",
        expectedTurnId: "turn-replaced-active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("advances due nudges without queueing work when the host is offline", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-nudge-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-offline-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "offline-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      await sweepDueNudges(harness.deps, { now });

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
      const updatedNudge = getManagerThreadNudge(harness.db, nudge.id);
      expect(updatedNudge?.lastFiredAt).toBe(now);
      expect(updatedNudge?.nextFireAt).toBeGreaterThan(now);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue work after losing the optimistic-lock race", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-nudge-lost-race",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/nudge-lost-race-environment",
      });
      const thread = seedRunnableManagerThread({
        harness,
        environmentId: environment.id,
        projectId: project.id,
      });
      const now = Date.now();
      const nudge = createManagerThreadNudge(harness.db, harness.hub, {
        projectId: project.id,
        threadId: thread.id,
        name: "lost-race-check",
        cron: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now - 1,
      });

      const sweepPromise = sweepDueNudges(harness.deps, { now });
      const readPreferences = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path ===
            `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`,
      );

      const externallyAdvancedNextFireAt = now + 60_000;
      updateManagerThreadNudge(harness.db, harness.hub, nudge.id, {
        nextFireAt: externallyAdvancedNextFireAt,
      });

      const preferencesResponse = await reportQueuedCommandError(
        harness,
        readPreferences,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(preferencesResponse.status).toBe(200);

      await sweepPromise;

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "turn.submit"))
          .all(),
      ).toHaveLength(0);
      expect(getManagerThreadNudge(harness.db, nudge.id)).toMatchObject({
        lastFiredAt: null,
        nextFireAt: externallyAdvancedNextFireAt,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
