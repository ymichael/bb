import { eq } from "drizzle-orm";
import {
  CLOSED_SESSION_ROW_RETENTION_MS,
  DESTROYED_ENVIRONMENT_TTL_MS,
  environments,
  events,
  hostDaemonSessions,
  listQueuedThreadMessages,
} from "@bb/db";
import { threadScope } from "@bb/domain";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  resetEventLoopWorkForTests,
  takeEventLoopWorkWindowSnapshot,
} from "../../src/services/system/event-loop-work.js";
import {
  type PeriodicSweepJob,
  runPeriodicSweepJobs,
  runPeriodicSweeps,
} from "../../src/services/system/periodic-sweeps.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  testLogger,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

type ReleaseCallback = () => void;

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function installHooks(registry: HookRegistry): void {
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
}

function seedRunnableThread(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/${hostId}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${hostId}`,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${hostId}`,
    threadId: thread.id,
  });
  return thread;
}

afterEach(() => {
  setPluginHookProvider(undefined);
});

function releaseRunningJob(release: ReleaseCallback | null): void {
  if (!release) {
    throw new Error("Expected a pending sweep job");
  }
  release();
}

describe("runPeriodicSweeps", () => {
  it("dispatches due messages from an overlapping tick while idle recovery is still running", async () => {
    await withTestHarness(async (harness) => {
      let releaseIdleRecovery: ReleaseCallback | null = null;
      let resolveIdleRecoveryStarted: ReleaseCallback | null = null;
      let resolveSecondAttempt: ((kind: "idle" | "scheduled") => void) | null =
        null;
      const idleRecoveryStarted = new Promise<void>((resolve) => {
        resolveIdleRecoveryStarted = resolve;
      });
      const idleRecoveryRelease = new Promise<void>((resolve) => {
        releaseIdleRecovery = resolve;
      });
      const secondAttempt = new Promise<"idle" | "scheduled">((resolve) => {
        resolveSecondAttempt = resolve;
      });
      let attempts = 0;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "slow-idle-recovery",
            handler: async (context) => {
              attempts += 1;
              const kind = context.input.text.includes("overlapping tick")
                ? "scheduled"
                : "idle";
              if (attempts === 1) {
                if (resolveIdleRecoveryStarted) {
                  resolveIdleRecoveryStarted();
                }
                await idleRecoveryRelease;
              } else if (attempts === 2 && resolveSecondAttempt) {
                resolveSecondAttempt(kind);
              }
              return kind === "scheduled"
                ? ({ action: "proceed" } as const)
                : ({ action: "wait", reason: "Slow idle recovery" } as const);
            },
          },
        ],
      });

      for (const hostId of ["host-idle-recovery-a", "host-idle-recovery-b"]) {
        const idleThread = seedRunnableThread(harness, hostId);
        seedQueuedMessage(harness.deps, {
          content: textInput("block idle recovery"),
          threadId: idleThread.id,
        });
      }
      const scheduledThread = seedRunnableThread(
        harness,
        "host-scheduled-recovery",
      );
      seedQueuedMessage(harness.deps, {
        content: textInput("deliver on the overlapping tick"),
        sendAt: Date.now() - 1_000,
        threadId: scheduledThread.id,
        waitingOn: { kind: "time" },
      });

      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };
      const firstSweep = runPeriodicSweeps(deps);
      await idleRecoveryStarted;
      const overlappingSweep = runPeriodicSweeps(deps);
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseRunningJob(releaseIdleRecovery);
      try {
        await expect(secondAttempt).resolves.toBe("scheduled");
        await overlappingSweep;
        expect(
          listQueuedThreadMessages(harness.db, scheduledThread.id),
        ).toEqual([]);
      } finally {
        await Promise.all([firstSweep, overlappingSweep]);
      }
    });
  });

  it("continues later sweep jobs after an earlier job fails", async () => {
    await withTestHarness(async (harness) => {
      const { session } = seedHostSession(harness.deps);
      const closedAt = Date.now() - CLOSED_SESSION_ROW_RETENTION_MS - 1;
      harness.db
        .update(hostDaemonSessions)
        .set({
          closedAt,
          status: "closed",
          updatedAt: closedAt,
        })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      const logger = {
        ...testLogger,
        error: vi.fn(),
      };
      const deps = {
        ...harness.deps,
        logger,
        machineAuth: {
          ...harness.deps.machineAuth,
          pruneExpiredKeys: vi.fn(async () => {
            throw new Error("machine auth prune failed");
          }),
        },
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };

      await runPeriodicSweeps(deps);

      const sessionAfterSweep = harness.db
        .select({ id: hostDaemonSessions.id })
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(sessionAfterSweep).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sweepJob: "machine-auth-prune",
          sweepJobCategory: "retention",
        }),
        "Periodic sweep job failed",
      );
    });
  });

  it("prunes expired destroyed environments one per event-loop turn", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const expiredAt = Date.now() - DESTROYED_ENVIRONMENT_TTL_MS - 60_000;
      for (const path of [
        "/tmp/destroyed-a",
        "/tmp/destroyed-b",
        "/tmp/destroyed-c",
      ]) {
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path,
          managed: true,
          status: "destroyed",
          workspaceProvisionType: "managed-worktree",
        });
        harness.db
          .update(environments)
          .set({ updatedAt: expiredAt })
          .where(eq(environments.id, environment.id))
          .run();
      }
      const countDestroyedEnvironments = () =>
        harness.db
          .select({ id: environments.id })
          .from(environments)
          .where(eq(environments.status, "destroyed"))
          .all().length;

      const observedCounts: number[] = [];
      let sweepSettled = false;
      const probe = () => {
        if (sweepSettled) {
          return;
        }
        observedCounts.push(countDestroyedEnvironments());
        setImmediate(probe);
      };
      setImmediate(probe);

      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };
      await runPeriodicSweeps(deps);
      sweepSettled = true;

      expect(countDestroyedEnvironments()).toBe(0);
      expect(observedCounts).toEqual(expect.arrayContaining([2, 1]));
    });
  });

  it("clears a large environment event set across event-loop turns", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/destroyed-with-large-history",
        managed: true,
        status: "destroyed",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const eventCount = 150;
      for (let sequence = 1; sequence <= eventCount; sequence += 1) {
        seedEvent(harness.deps, {
          data: { text: `event ${sequence}` },
          environmentId: environment.id,
          scope: threadScope(),
          sequence,
          threadId: thread.id,
          type: "system/manager/user_message",
        });
      }
      harness.db
        .update(environments)
        .set({ updatedAt: Date.now() - DESTROYED_ENVIRONMENT_TTL_MS - 60_000 })
        .where(eq(environments.id, environment.id))
        .run();

      const countReferences = () =>
        harness.db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.environmentId, environment.id))
          .all().length;
      const observedReferenceCounts: number[] = [];
      let sweepSettled = false;
      const probe = () => {
        if (sweepSettled) {
          return;
        }
        observedReferenceCounts.push(countReferences());
        setImmediate(probe);
      };
      setImmediate(probe);

      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };
      await runPeriodicSweeps(deps);
      sweepSettled = true;

      expect(
        observedReferenceCounts.some(
          (count) => count > 0 && count < eventCount,
        ),
      ).toBe(true);
    });
  });

  it("attributes each destroyed-environment prune to a blocking work frame", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/destroyed-attributed",
        managed: true,
        status: "destroyed",
        workspaceProvisionType: "managed-worktree",
      });
      harness.db
        .update(environments)
        .set({ updatedAt: Date.now() - DESTROYED_ENVIRONMENT_TTL_MS - 60_000 })
        .where(eq(environments.id, environment.id))
        .run();

      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };
      resetEventLoopWorkForTests();
      try {
        await runPeriodicSweeps(deps);
        expect(takeEventLoopWorkWindowSnapshot().slowestWork).toBe(
          "sweep:destroyed-environment-prune:advance",
        );
      } finally {
        resetEventLoopWorkForTests();
      }
    });
  });

  it("isolates job failures in the generic runner", async () => {
    await withTestHarness(async (harness) => {
      const logger = {
        ...testLogger,
        error: vi.fn(),
      };
      const deps = {
        ...harness.deps,
        logger,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };
      let laterJobRuns = 0;
      const jobs: PeriodicSweepJob[] = [
        {
          cadenceMs: 0,
          category: "retention",
          name: "test-failing-sweep",
          run() {
            throw new Error("synthetic sweep failure");
          },
        },
        {
          cadenceMs: 0,
          category: "retention",
          name: "test-later-sweep",
          run() {
            laterJobRuns += 1;
          },
        },
      ];

      await runPeriodicSweepJobs(deps, jobs, Date.now());

      expect(laterJobRuns).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sweepJob: "test-failing-sweep",
          sweepJobCategory: "retention",
        }),
        "Periodic sweep job failed",
      );
    });
  });

  it("skips a generic job that is already running in another tick", async () => {
    await withTestHarness(async (harness) => {
      let runCount = 0;
      let releaseJob: (() => void) | null = null;
      let resolveJobStarted: (() => void) | null = null;
      const jobStarted = new Promise<void>((resolveStarted) => {
        resolveJobStarted = resolveStarted;
      });
      const jobs: PeriodicSweepJob[] = [
        {
          cadenceMs: 0,
          category: "maintenance",
          name: "test-overlap-sweep",
          async run() {
            runCount += 1;
            if (resolveJobStarted) {
              resolveJobStarted();
            }
            await new Promise<void>((resolveRunningJob) => {
              releaseJob = resolveRunningJob;
            });
          },
        },
      ];

      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };
      const firstSweep = runPeriodicSweepJobs(deps, jobs, 10_000);
      await jobStarted;
      await runPeriodicSweepJobs(deps, jobs, 10_001);
      expect(runCount).toBe(1);
      releaseRunningJob(releaseJob);
      await firstSweep;
    });
  });

  it("does not run cadence-limited generic jobs early", async () => {
    await withTestHarness(async (harness) => {
      let runCount = 0;
      const jobs: PeriodicSweepJob[] = [
        {
          cadenceMs: 1_000,
          category: "maintenance",
          name: "test-cadence-sweep",
          run() {
            runCount += 1;
          },
        },
      ];

      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
        pluginService: harness.pluginService,
        pluginCatalogService: harness.pluginCatalogService,
      };
      await runPeriodicSweepJobs(deps, jobs, 20_000);
      await runPeriodicSweepJobs(deps, jobs, 20_999);
      await runPeriodicSweepJobs(deps, jobs, 21_000);

      expect(runCount).toBe(2);
    });
  });
});
