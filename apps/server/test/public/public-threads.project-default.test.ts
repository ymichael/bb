import { getThread } from "@bb/db";
import {
  PERSONAL_PROJECT_ID,
  threadSchema,
  type GitSourceInspection,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { resolveProjectDefaultThreadEnvironment } from "../../src/services/threads/thread-default-policy.js";
import { getActiveThreadProvisionContext } from "../../src/services/threads/thread-provisioning-active-context.js";
import {
  requireManagedWorktreeEnvironmentProvisionLiveCommand,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface CreateThreadBodyOverrides {
  environment: unknown;
  origin?: string;
  originPluginId?: string;
}

async function postCreateThread(
  harness: TestAppHarness,
  projectId: string,
  overrides: CreateThreadBodyOverrides,
): Promise<Response> {
  return harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: overrides.origin ?? "sdk",
      ...(overrides.originPluginId !== undefined
        ? { originPluginId: overrides.originPluginId }
        : {}),
      projectId,
      providerId: "codex",
      input: [{ type: "text", text: "Spawn a thread" }],
      environment: overrides.environment,
    }),
  });
}

interface ProvisionPolicyFields {
  baseBranch: string | null;
  sourcePath: string;
  workspaceProvisionType: "managed-worktree";
}

async function createAndCaptureProvision(
  harness: TestAppHarness,
  args: { environment: unknown; projectId: string },
): Promise<{ provision: ProvisionPolicyFields; threadId: string }> {
  const response = await postCreateThread(harness, args.projectId, {
    environment: args.environment,
  });
  expect(response.status).toBe(201);
  const thread = threadSchema.parse(await readJson(response));
  const queued = await waitForQueuedCommand(
    harness,
    ({ command }) => command.type === "environment.provision",
  );
  const managed = requireManagedWorktreeEnvironmentProvisionLiveCommand(queued);
  return {
    provision: {
      baseBranch: managed.command.baseBranch,
      sourcePath: managed.command.sourcePath,
      workspaceProvisionType: managed.command.workspaceProvisionType,
    },
    threadId: thread.id,
  };
}

describe("project-default thread environment", () => {
  it("resolves project-default exactly like the explicit managed-worktree default", async () => {
    const sourcePath = "/tmp/project-default-source";

    const explicit = await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: sourcePath,
      });
      const { provision } = await createAndCaptureProvision(harness, {
        projectId: project.id,
        environment: {
          type: "host",
          hostId: host.id,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
      });
      return provision;
    });

    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: sourcePath,
      });
      const { provision, threadId } = await createAndCaptureProvision(harness, {
        projectId: project.id,
        environment: { type: "project-default" },
      });
      expect(provision).toEqual(explicit);
      expect(getThread(harness.db, threadId)?.originPluginId).toBeNull();
    });
  });

  it("resolves the personal project to a personal workspace on the primary host", async () => {
    await withTestHarness(async (harness) => {
      await expect(
        resolveProjectDefaultThreadEnvironment(harness.deps, {
          projectId: PERSONAL_PROJECT_ID,
        }),
      ).resolves.toEqual({
        type: "host",
        workspace: { type: "personal" },
      });
    });
  });

  it.each([
    {
      name: "a repository with no commits",
      checkout: {
        checkout: { kind: "unborn" as const, branchName: "main" },
        defaultBranch: null,
        defaultBranchRelation: null,
        hasUncommittedChanges: false,
        operation: { kind: "none" as const },
        originDefaultBranch: null,
      } satisfies GitSourceInspection,
    },
    {
      name: "a non-Git directory",
      checkout: {
        checkout: {
          kind: "unknown" as const,
          reason: "Path is not a git repository",
        },
        defaultBranch: null,
        defaultBranchRelation: null,
        hasUncommittedChanges: false,
        operation: { kind: "none" as const },
        originDefaultBranch: null,
      } satisfies GitSourceInspection,
    },
  ])(
    "dispatches a plugin thread in the project source for $name",
    async ({ checkout }) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        seedPrimaryHost(harness.deps, host.id);
        const sourcePath = "/tmp/project-default-unmanaged-source";
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: sourcePath,
        });
        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          restoreCommandCaptureAfterResponse: true,
          handle(request) {
            expect(request.command).toEqual({
              type: "host.inspect_git_source",
              path: sourcePath,
              remoteRefresh: "background",
            });
            return { ok: true, result: checkout };
          },
        });

        const response = await postCreateThread(harness, project.id, {
          origin: "plugin",
          originPluginId: "tasks",
          environment: { type: "project-default" },
        });

        expect(response.status).toBe(201);
        const thread = threadSchema.parse(await readJson(response));
        expect(responder.requests).toHaveLength(1);
        expect(getThread(harness.db, thread.id)?.originPluginId).toBe("tasks");
        expect(
          getActiveThreadProvisionContext(thread.id)?.request.environmentIntent,
        ).toEqual({
          type: "direct-unmanaged",
          hostId: host.id,
          path: sourcePath,
        });
      });
    },
  );

  it("fails with a clear ApiError when the primary host is not connected", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const response = await postCreateThread(harness, project.id, {
        environment: { type: "project-default" },
      });
      expect(response.status).toBe(502);
      const body = (await readJson(response)) as {
        code: string;
        message: string;
      };
      expect(body.code).toBe("host_unavailable");
      expect(body.message).toBe("Host is not connected");
    });
  });
});

describe("plugin thread attribution", () => {
  it("persists and surfaces originPluginId for plugin-origin threads", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/plugin-attribution",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/plugin-attribution",
      });

      const response = await postCreateThread(harness, project.id, {
        origin: "plugin",
        originPluginId: "linear",
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: null },
        },
      });
      expect(response.status).toBe(201);
      const created = threadSchema.parse(await readJson(response));
      expect(created.originPluginId).toBe("linear");
      expect(getThread(harness.db, created.id)?.originPluginId).toBe("linear");

      const getResponse = await harness.app.request(
        `/api/v1/threads/${created.id}`,
      );
      expect(getResponse.status).toBe(200);
      const fetched = threadSchema.parse(await readJson(getResponse));
      expect(fetched.originPluginId).toBe("linear");
    });
  });

  it("rejects origin plugin without originPluginId, and originPluginId without origin plugin", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: null },
      };

      const missingPluginId = await postCreateThread(harness, project.id, {
        origin: "plugin",
        environment,
      });
      expect(missingPluginId.status).toBe(400);

      const strayPluginId = await postCreateThread(harness, project.id, {
        origin: "sdk",
        originPluginId: "linear",
        environment,
      });
      expect(strayPluginId.status).toBe(400);
    });
  });
});
