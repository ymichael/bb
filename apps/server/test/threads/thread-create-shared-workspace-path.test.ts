import { ensurePersonalProject, listEnvironments } from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const SHARED_PATH = "/tmp/shared-workspace-path-repo";

describe("thread creation on a path another project already uses", () => {
  it("creates a project-owned environment instead of failing on the personal claim", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-shared-workspace-path",
      });
      ensurePersonalProject(harness.deps.db);
      const personalEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: PERSONAL_PROJECT_ID,
        path: SHARED_PATH,
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: SHARED_PATH,
      });

      const thread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: SHARED_PATH },
        },
        input: textInput("Work in the shared folder"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      expect(thread.projectId).toBe(project.id);
      const projectEnvironments = listEnvironments(harness.deps.db, project.id);
      expect(projectEnvironments).toHaveLength(1);
      expect(projectEnvironments[0]?.id).not.toBe(personalEnvironment.id);

      const provision = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "environment.provision",
      );
      expect(provision.command).toMatchObject({
        type: "environment.provision",
        environmentId: projectEnvironments[0]?.id,
        path: SHARED_PATH,
      });
    });
  });

  it("refuses a branch checkout while another project works in the directory", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-shared-checkout",
      });
      const { project: busyProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Busy Project",
        path: SHARED_PATH,
      });
      const busyEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: busyProject.id,
        path: SHARED_PATH,
      });
      seedThread(harness.deps, {
        projectId: busyProject.id,
        environmentId: busyEnvironment.id,
        status: "active",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Checkout Project",
        path: SHARED_PATH,
      });

      await expect(
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: SHARED_PATH,
              branch: { kind: "existing", name: "feature/x" },
            },
          },
          input: textInput("Check out a branch"),
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          startedOnBehalfOf: null,
        }),
      ).rejects.toThrow("Cannot checkout branch while another thread is using");

      expect(listEnvironments(harness.deps.db, project.id)).toEqual([]);
    });
  });

  it("refuses to attach in place to another project's managed worktree", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-managed-alias",
      });
      const worktreePath = "/tmp/bb-worktrees/env_owner/repo";
      const { project: owner } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Owning Project",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: owner.id,
        path: worktreePath,
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Aliasing Project",
        path: "/tmp/aliasing-project",
      });

      await expect(
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: worktreePath },
          },
          input: textInput("Attach to the managed worktree"),
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          startedOnBehalfOf: null,
        }),
      ).rejects.toThrow("bb-managed workspace owned by another project");

      expect(listEnvironments(harness.deps.db, project.id)).toEqual([]);
    });
  });

  it("refuses a managed path whose owner has not stored it yet", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-pending-managed",
      });
      const { project: owner } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Owning Project",
      });
      const pending = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: owner.id,
        path: null,
        status: "provisioning",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Racing Project",
        path: "/tmp/racing-project",
      });

      await expect(
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: `${session.dataDir}/worktrees/${pending.id}/repo`,
            },
          },
          input: textInput("Race the worktree"),
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          startedOnBehalfOf: null,
        }),
      ).rejects.toThrow("bb-managed workspace owned by another project");

      expect(listEnvironments(harness.deps.db, project.id)).toEqual([]);
    });
  });
});
