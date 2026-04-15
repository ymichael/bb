import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  createProjectSource,
  getEnvironmentOperation,
  hostDaemonCommands,
  listEnvironments,
  listThreads,
  threads,
  updateHost,
} from "@bb/db";
import { threadSchema } from "@bb/domain";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedHost,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { waitForThreadEnvironment } from "./public-thread-assertions.js";
import { createTestGitRepo } from "./public-thread-git-fixtures.js";
import {
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";

describe("public thread creation routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });


  it("creates unmanaged host threads and queues environment provisioning", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/unmanaged-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Inspect the default source workspace" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const environment = await waitForThreadEnvironment(
        harness,
        createdThread.id,
      );
      expect(environment).toMatchObject({
        projectId: project.id,
        status: "provisioning",
        workspaceProvisionType: "unmanaged",
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      expect(queued.command).toMatchObject({
        environmentId: environment?.id,
        path: source.path,
        workspaceProvisionType: "unmanaged",
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("creates host threads while the host is offline and leaves provisioning requested", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-thread-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/offline-thread-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Create this thread offline" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const environments = listEnvironments(harness.db, project.id);
      expect(environments).toHaveLength(1);
      expect(environments[0]).toMatchObject({
        hostId: host.id,
        status: "provisioning",
        workspaceProvisionType: "unmanaged",
      });
      expect(getEnvironmentOperation(harness.db, {
        environmentId: environments[0]!.id,
        kind: "provision",
      })).toMatchObject({
        state: "requested",
      });
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(1);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "environment.provision"))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });


  it("fails host thread creation when the host is destroyed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: projectHost } = seedHostSession(harness.deps, {
        id: "host-thread-project",
      });
      const { host: destroyedHost } = seedHostSession(harness.deps, {
        id: "host-thread-destroyed",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: projectHost.id,
        path: "/tmp/destroyed-thread-project",
      });
      updateHost(harness.db, harness.hub, destroyedHost.id, {
        destroyedAt: Date.now(),
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Create this thread on a destroyed host" }],
          environment: {
            type: "host",
            hostId: destroyedHost.id,
            workspace: {
              type: "unmanaged",
              path: "/tmp/destroyed-thread-project",
            },
          },
        }),
      });

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_not_found",
      });
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(0);
      expect(listEnvironments(harness.db, project.id)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });


  it("creates managed-worktree threads and queues managed provisioning", async () => {
    const harness = await createTestAppHarness();
    const repo = await createTestGitRepo();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: repo.path,
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Managed thread",
          input: [{ type: "text", text: "Build it" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "managed-worktree",
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      expect(queued.command).toMatchObject({
        sourcePath: source.path,
        workspaceProvisionType: "managed-worktree",
        setupTimeoutMs: 900000,
      });
      expect(queued.command).toHaveProperty("targetPath");
      expect(queued.command).toHaveProperty("branchName");

    } finally {
      await repo.cleanup();
      await harness.cleanup();
    }
  });


  it("creates managed-worktree threads on a non-default host using that host's source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-managed-default",
      });
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-managed-secondary",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/default-managed-source",
      });
      const secondarySource = createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: secondaryHost.id,
        path: "/tmp/secondary-managed-source",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Secondary host thread",
          input: [{ type: "text", text: "Build it on the secondary host" }],
          environment: {
            type: "host",
            hostId: secondaryHost.id,
            workspace: {
              type: "managed-worktree",
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");
      const environment = await waitForThreadEnvironment(
        harness,
        createdThread.id,
      );

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
      );
      expect(queued.command).toMatchObject({
        sourcePath: secondarySource.path,
        workspaceProvisionType: "managed-worktree",
      });
      expect(queued.command.targetPath).toBe(
        `/tmp/bb-host-data/${secondaryHost.id}/worktrees/${environment.id}/secondary-managed-source`,
      );
    } finally {
      await harness.cleanup();
    }
  });


  it("returns 409 when the requested host has no configured project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-source-default",
      });
      const { host: missingSourceHost } = seedHostSession(harness.deps, {
        id: "host-source-missing",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/source-present",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Try the missing host" }],
          environment: {
            type: "host",
            hostId: missingSourceHost.id,
            workspace: {
              type: "managed-worktree",
            },
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "No project source configured for this host",
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("creates unmanaged threads with an explicit path even when the host has no project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-unmanaged-default",
      });
      const { host: explicitPathHost } = seedHostSession(harness.deps, {
        id: "host-unmanaged-explicit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/unmanaged-default-source",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Use the explicit workspace path" }],
          environment: {
            type: "host",
            hostId: explicitPathHost.id,
            workspace: {
              type: "unmanaged",
              path: "/tmp/explicit-unmanaged-workspace",
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");
      const environment = await waitForThreadEnvironment(
        harness,
        createdThread.id,
      );

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
      );
      expect(queued.command).toMatchObject({
        path: "/tmp/explicit-unmanaged-workspace",
        workspaceProvisionType: "unmanaged",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
