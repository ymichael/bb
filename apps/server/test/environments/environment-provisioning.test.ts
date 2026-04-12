import { eq } from "drizzle-orm";
import {
  getEnvironment,
  hostDaemonCommands,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  MANAGED_REPROVISION_IN_PROGRESS,
  MANAGED_REPROVISION_QUEUED,
  queueManagedEnvironmentReprovision,
} from "../../src/services/environments/environment-provisioning.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("environment reprovisioning", () => {
  it("queues managed reprovision at most once per environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reprovision-once",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reprovision-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-target",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
        branchName: null,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const firstAttempt = await queueManagedEnvironmentReprovision(harness.deps, {
        environment,
        thread,
      });
      const secondAttempt = await queueManagedEnvironmentReprovision(harness.deps, {
        environment,
        thread,
      });

      expect(firstAttempt).toBe(MANAGED_REPROVISION_QUEUED);
      expect(secondAttempt).toBe(MANAGED_REPROVISION_IN_PROGRESS);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("provisioning");
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(queued.command.branchName).toBe(`bb/${thread.id}`);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(
            eq(hostDaemonCommands.type, "environment.provision"),
          )
          .all(),
      ).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("preserves the stored branch name during managed reprovision", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reprovision-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reprovision-branch-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-branch-target",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/existing-readable-branch",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      await queueManagedEnvironmentReprovision(harness.deps, {
        environment,
        thread,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(queued.command.branchName).toBe("bb/existing-readable-branch");
    } finally {
      await harness.cleanup();
    }
  });

  it("fails reprovision before mutating state when the host is disconnected", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-reprovision-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reprovision-offline-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-offline-target",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      let thrownError: ApiError | null = null;
      try {
        await queueManagedEnvironmentReprovision(harness.deps, {
          environment,
          thread,
        });
      } catch (error) {
        if (error instanceof ApiError) {
          thrownError = error;
        } else {
          throw error;
        }
      }

      expect(thrownError).toMatchObject({
        body: {
          code: "host_disconnected",
          message: "Host is not connected",
        },
        status: 502,
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(
            eq(hostDaemonCommands.type, "environment.provision"),
          )
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});
