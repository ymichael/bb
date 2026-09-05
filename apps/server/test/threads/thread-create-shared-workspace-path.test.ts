import { ensurePersonalProject, listEnvironments } from "@bb/db";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { PluginEnvironmentProviderValidateContext } from "@get-bb/plugin-sdk/environment-provider";
import { describe, expect, it } from "vitest";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../../src/services/environments/environment-provider-ids.js";
import {
  checkoutProviderInputsSchema,
  installFakeEnvironmentProvider,
} from "../helpers/environment-provider.js";
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
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      const projectEnvironments = listEnvironments(harness.deps.db, {
        projectId: project.id,
      });
      expect(projectEnvironments).toHaveLength(1);
      expect(projectEnvironments[0]?.id).not.toBe(personalEnvironment.id);
      expect(projectEnvironments[0]?.path).toBe(SHARED_PATH);
    });
  });

  it("runs the checkout provider's validate for a branch checkout request", async () => {
    await withTestHarness(async (harness) => {
      const validated: PluginEnvironmentProviderValidateContext[] = [];
      installFakeEnvironmentProvider({
        id: DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
        pluginId: "environment-project-checkout",
        displayName: "Checkout",
        requires: {
          projectCheckout: true,
          gitCheckout: false,
          gitRemote: false,
          projectless: false,
        },
        inputs: checkoutProviderInputsSchema,
        validate: (context) => {
          validated.push(context);
          return {
            action: "refuse",
            message:
              "Cannot checkout branch while another thread is using this workspace",
          };
        },
        decide: () => ({ action: "wait", reason: "…" }),
      });
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

      expect(validated).toHaveLength(1);
      expect(validated[0]).toMatchObject({
        host: { id: host.id },
        projectCheckout: { path: SHARED_PATH },
        inputs: {
          path: SHARED_PATH,
          branch: { kind: "existing", name: "feature/x" },
        },
      });
      expect(
        listEnvironments(harness.deps.db, { projectId: project.id }),
      ).toEqual([]);
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
        environmentProviderId: "git-worktree",
        providerOwnsPath: true,
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

      expect(
        listEnvironments(harness.deps.db, { projectId: project.id }),
      ).toEqual([]);
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
        environmentProviderId: "git-worktree",
        providerOwnsPath: true,
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

      expect(
        listEnvironments(harness.deps.db, { projectId: project.id }),
      ).toEqual([]);
    });
  });

  it("accepts a second project's checkout request at a path the first project's checkout row holds", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-two-projects-one-checkout",
      });
      const { project: first } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "First Project",
        path: SHARED_PATH,
      });
      const firstEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: first.id,
        path: SHARED_PATH,
        environmentProviderId: DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
        providerOwnsPath: false,
      });

      const { project: second } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Second Project",
        path: SHARED_PATH,
      });

      const thread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: SHARED_PATH },
        },
        input: textInput("Work in the shared checkout"),
        origin: "app",
        projectId: second.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      expect(thread.projectId).toBe(second.id);
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      const secondEnvironments = listEnvironments(harness.deps.db, {
        projectId: second.id,
      });
      expect(secondEnvironments).toHaveLength(1);
      expect(secondEnvironments[0]?.id).not.toBe(firstEnvironment.id);
      expect(secondEnvironments[0]?.path).toBe(SHARED_PATH);
    });
  });
});
