import { eq } from "drizzle-orm";
import {
  archiveThread,
  createEnvironment,
  createThread,
  environments,
  getEnvironment,
  hostDaemonSessions,
  markThreadDeleted,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import {
  runEnvironmentCleanupAdvance,
  settleEnvironmentDestroyCommandResult,
} from "../../src/services/environments/environment-cleanup-internal.js";
import {
  runManagedEnvironmentArchiveCleanupRecoverySweep,
  runStartupRecoverySweep,
} from "../../src/services/system/periodic-sweeps.js";
import { MANAGED_ENVIRONMENT_RETIRE_GRACE_MS } from "../../src/constants.js";
import { LIVE_DAEMON_COMMAND_TIMEOUT_MS } from "../../src/services/hosts/live-command.js";
import { listQueuedEnvironmentCommands } from "../helpers/commands.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const SWEEP_START_MS = 4_000_000_000_000;

describe("managed environment cleanup recovery sweep", () => {
  it("keeps a recent in-flight destroy recoverable across startup and accepts its success", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: "/tmp/in-flight-destroying-environment",
        projectId: project.id,
        status: "destroying",
        workspaceProvisionType: "managed-worktree",
      });
      const recentUpdatedAt = Date.now() - 1;
      harness.db
        .update(environments)
        .set({
          destroyAttemptId: "rpc-in-flight-destroying",
          updatedAt: recentUpdatedAt,
        })
        .where(eq(environments.id, environment.id))
        .run();

      await runStartupRecoverySweep(harness.deps);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(0);

      harness.db.transaction((tx) => {
        settleEnvironmentDestroyCommandResult({
          command: {
            type: "environment.destroy",
            environmentId: environment.id,
            teardownTimeoutMs: 900000,
            workspaceContext: {
              workspacePath: "/tmp/in-flight-destroying-environment",
              workspaceProvisionType: "managed-worktree",
            },
          },
          deps: { ...harness.deps, db: tx, hub: harness.hub },
          execution: {
            createdAt: recentUpdatedAt,
            hostId: host.id,
            id: "rpc-in-flight-destroying",
          },
          report: {
            completedAt: Date.now(),
            executionId: "rpc-in-flight-destroying",
            ok: true,
            result: { transcript: [] },
            type: "environment.destroy",
          },
        });
      });

      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroyed",
      );
    });
  });

  it("accepts a matching late success after stale startup recovery marks the destroy lost", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const workspacePath = "/tmp/stale-destroy-late-success";
      const staleUpdatedAt = Date.now() - LIVE_DAEMON_COMMAND_TIMEOUT_MS - 1;
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: workspacePath,
        projectId: project.id,
        status: "destroying",
        workspaceProvisionType: "managed-worktree",
      });
      harness.db
        .update(environments)
        .set({
          destroyAttemptId: "rpc-late-success",
          updatedAt: staleUpdatedAt,
        })
        .where(eq(environments.id, environment.id))
        .run();

      await runStartupRecoverySweep(harness.deps);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        destroyAttemptId: "rpc-late-success",
        status: "error",
      });

      harness.db.transaction((tx) => {
        settleEnvironmentDestroyCommandResult({
          command: {
            type: "environment.destroy",
            environmentId: environment.id,
            teardownTimeoutMs: 900000,
            workspaceContext: {
              workspacePath,
              workspaceProvisionType: "managed-worktree",
            },
          },
          deps: { ...harness.deps, db: tx, hub: harness.hub },
          execution: {
            createdAt: staleUpdatedAt,
            hostId: host.id,
            id: "rpc-late-success",
          },
          report: {
            completedAt: Date.now(),
            executionId: "rpc-late-success",
            ok: true,
            result: { transcript: [] },
            type: "environment.destroy",
          },
        });
      });

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        destroyAttemptId: null,
        status: "destroyed",
      });
    });
  });

  it("ignores an older destroy failure after lost destroy recovery marks error", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const workspacePath = "/tmp/stale-failure-after-retry";
      const oldExecutionCreatedAt =
        Date.now() - LIVE_DAEMON_COMMAND_TIMEOUT_MS - 1;
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: workspacePath,
        projectId: project.id,
        status: "destroying",
        workspaceProvisionType: "managed-worktree",
      });
      harness.db
        .update(environments)
        .set({
          destroyAttemptId: "rpc-stale-destroy",
          updatedAt: oldExecutionCreatedAt,
        })
        .where(eq(environments.id, environment.id))
        .run();

      await runStartupRecoverySweep(harness.deps);

      harness.db.transaction((tx) => {
        const sideEffects = settleEnvironmentDestroyCommandResult({
          command: {
            type: "environment.destroy",
            environmentId: environment.id,
            teardownTimeoutMs: 900000,
            workspaceContext: {
              workspacePath,
              workspaceProvisionType: "managed-worktree",
            },
          },
          deps: {
            ...harness.deps,
            db: tx,
            hub: harness.hub,
          },
          execution: {
            createdAt: oldExecutionCreatedAt,
            hostId: host.id,
            id: "rpc-stale-destroy",
          },
          report: {
            completedAt: Date.now(),
            errorCode: "command_timeout",
            errorMessage: "Timed out waiting for command result",
            executionId: "rpc-stale-destroy",
            ok: false,
            type: "environment.destroy",
          },
        });
        expect(sideEffects.postCommitActions).toHaveLength(0);
      });

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(0);
    });
  });

  it("settles a current destroy failure after cleanup request and updatedAt changes", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const workspacePath = "/tmp/current-failure-after-refresh";
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: workspacePath,
        projectId: project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });

      await runEnvironmentCleanupAdvance(harness.deps, {
        environmentId: environment.id,
      });
      const destroyingEnvironment = getEnvironment(harness.db, environment.id);
      if (!destroyingEnvironment?.destroyAttemptId) {
        throw new Error("Expected a claimed destroy attempt");
      }
      const destroyAttemptId = destroyingEnvironment.destroyAttemptId;
      const destroyAttemptUpdatedAt = destroyingEnvironment.updatedAt;

      harness.db
        .update(environments)
        .set({ updatedAt: destroyAttemptUpdatedAt + 1 })
        .where(eq(environments.id, environment.id))
        .run();

      harness.db.transaction((tx) => {
        const sideEffects = settleEnvironmentDestroyCommandResult({
          command: {
            type: "environment.destroy",
            environmentId: environment.id,
            teardownTimeoutMs: 900000,
            workspaceContext: {
              workspacePath,
              workspaceProvisionType: "managed-worktree",
            },
          },
          deps: {
            ...harness.deps,
            db: tx,
            hub: harness.hub,
          },
          execution: {
            createdAt: destroyAttemptUpdatedAt,
            hostId: host.id,
            id: destroyAttemptId,
          },
          report: {
            completedAt: Date.now(),
            errorCode: "command_timeout",
            errorMessage: "Timed out waiting for command result",
            executionId: destroyAttemptId,
            ok: false,
            type: "environment.destroy",
          },
        });
        expect(sideEffects.postCommitActions).toHaveLength(0);
      });

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        destroyAttemptId: null,
        status: "retiring",
      });
    });
  });

  it("destroys retiring git environments without merge-base metadata", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: true,
        managed: true,
        path: "/tmp/git-cleanup-without-merge-base",
        projectId: project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });

      await runEnvironmentCleanupAdvance(harness.deps, {
        environmentId: environment.id,
      });

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        destroyAttemptId: expect.any(String),
        status: "destroying",
      });
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(1);
    });
  });

  it("advances cleanup when a daemon socket is live but its lease timestamp is stale", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      harness.db
        .update(hostDaemonSessions)
        .set({ leaseExpiresAt: Date.now() - 1_000 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: "/tmp/live-daemon-stale-cleanup-lease",
        projectId: project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });

      await runEnvironmentCleanupAdvance(harness.deps, {
        environmentId: environment.id,
      });

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        destroyAttemptId: expect.any(String),
        status: "destroying",
      });
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(1);
    });
  });

  it("marks stale destroying cleanup requests without paths as error", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        managed: true,
        path: null,
        projectId: project.id,
        status: "destroying",
        workspaceProvisionType: "managed-worktree",
      });
      const staleUpdatedAt = Date.now() - LIVE_DAEMON_COMMAND_TIMEOUT_MS - 1;
      harness.db
        .update(environments)
        .set({
          destroyAttemptId: "rpc-stale-pathless",
          updatedAt: staleUpdatedAt,
        })
        .where(eq(environments.id, environment.id))
        .run();

      await runStartupRecoverySweep(harness.deps);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(0);
    });
  });

  it("does not log one cleanup deferral per environment while the host daemon is unavailable", async () => {
    await withTestHarness(async (harness) => {
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };
      harness.deps.logger = logger;

      const { host, session } = seedHostSession(harness.deps);
      harness.hub.unregisterDaemon(session.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      for (const path of [
        "/tmp/unavailable-cleanup-one",
        "/tmp/unavailable-cleanup-two",
      ]) {
        createEnvironment(harness.db, harness.hub, {
          hostId: host.id,
          isGitRepo: false,
          managed: true,
          path,
          projectId: project.id,
          status: "retiring",
          workspaceProvisionType: "managed-worktree",
        });
      }

      await runStartupRecoverySweep(harness.deps);

      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: expect.any(String) }),
        "Managed environment archive cleanup deferred until host reconnects",
      );
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.anything(),
        "Managed environment archive cleanup deferred some candidates until host reconnects",
      );
    });
  });

  it("logs a single aggregate cleanup deferral when a sweep partially advances", async () => {
    await withTestHarness(async (harness) => {
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };
      harness.deps.logger = logger;

      const unavailable = seedHostSession(harness.deps, {
        id: "host-unavailable-cleanup",
      });
      harness.hub.unregisterDaemon(unavailable.session.id);
      const unavailableProject = seedProjectWithSource(harness.deps, {
        hostId: unavailable.host.id,
      });
      createEnvironment(harness.db, harness.hub, {
        hostId: unavailable.host.id,
        isGitRepo: false,
        managed: true,
        path: "/tmp/unavailable-cleanup-environment",
        projectId: unavailableProject.project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });

      const available = seedHostSession(harness.deps, {
        id: "host-available-cleanup",
      });
      const availableProject = seedProjectWithSource(harness.deps, {
        hostId: available.host.id,
      });
      const availableEnvironment = createEnvironment(harness.db, harness.hub, {
        hostId: available.host.id,
        isGitRepo: false,
        managed: true,
        path: null,
        projectId: availableProject.project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });

      await runStartupRecoverySweep(harness.deps);

      expect(getEnvironment(harness.db, availableEnvironment.id)?.status).toBe(
        "destroyed",
      );
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(
        {
          deferredEnvironmentCount: 1,
          deferredHostIds: [unavailable.host.id],
        },
        "Managed environment archive cleanup deferred some candidates until host reconnects",
      );
    });
  });

  it("dedupes concurrent cleanup advances before dispatching destroy", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: "/tmp/concurrent-cleanup-environment",
        projectId: project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });

      await Promise.all([
        runEnvironmentCleanupAdvance(harness.deps, {
          environmentId: environment.id,
        }),
        runEnvironmentCleanupAdvance(harness.deps, {
          environmentId: environment.id,
        }),
      ]);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(1);
    });
  });

  it("defers a retiring environment's destroy until its grace window elapses while a revivable archived thread remains, then destroys it on the next sweep regardless of the recovery throttle", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      await runManagedEnvironmentArchiveCleanupRecoverySweep(
        harness.deps,
        SWEEP_START_MS,
      );

      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: "/tmp/grace-window-environment",
        projectId: project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
      });
      archiveThread(harness.db, harness.hub, thread.id);

      await runManagedEnvironmentArchiveCleanupRecoverySweep(
        harness.deps,
        SWEEP_START_MS + 1,
      );
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "retiring",
      );
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(0);

      harness.db
        .update(environments)
        .set({
          retireRequestedAt:
            Date.now() - MANAGED_ENVIRONMENT_RETIRE_GRACE_MS - 1,
        })
        .where(eq(environments.id, environment.id))
        .run();
      await runManagedEnvironmentArchiveCleanupRecoverySweep(
        harness.deps,
        SWEEP_START_MS + 2,
      );
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
      expect(
        listQueuedEnvironmentCommands(
          harness,
          "environment.destroy",
          environment.id,
        ),
      ).toHaveLength(1);
    });
  });

  it("destroys a retiring environment immediately when its only thread is deleted (nothing to unarchive)", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        isGitRepo: false,
        managed: true,
        path: "/tmp/deleted-thread-environment",
        projectId: project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      await runEnvironmentCleanupAdvance(harness.deps, {
        environmentId: environment.id,
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
    });
  });
});
