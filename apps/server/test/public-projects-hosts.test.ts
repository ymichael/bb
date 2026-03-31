import { eq } from "drizzle-orm";
import { hostDaemonCommands, hostDaemonSessions } from "@bb/db";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("public project and host routes", () => {
  it("supports project CRUD", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-projects" });

      const createResponse = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Project One",
          source: { type: "local_path", hostId: host.id, path: "/tmp/project-one" },
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdProject = await readJson(createResponse) as {
        id: string;
        name: string;
        sources: Array<{ id: string; isDefault: boolean }>;
      };
      expect(createdProject.name).toBe("Project One");
      expect(createdProject.sources).toHaveLength(1);
      expect(createdProject.sources[0]?.isDefault).toBe(true);

      const listResponse = await harness.app.request("/api/v1/projects");
      expect(listResponse.status).toBe(200);
      await expect(readJson(listResponse)).resolves.toEqual([
        expect.objectContaining({
          id: createdProject.id,
          name: "Project One",
        }),
      ]);

      const updateResponse = await harness.app.request(
        `/api/v1/projects/${createdProject.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Project Renamed",
          }),
        },
      );
      expect(updateResponse.status).toBe(200);
      await expect(readJson(updateResponse)).resolves.toMatchObject({
        id: createdProject.id,
        name: "Project Renamed",
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/projects/${createdProject.id}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });

      const finalListResponse = await harness.app.request("/api/v1/projects");
      await expect(readJson(finalListResponse)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a github repo project without a host-scoped source", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "GitHub Project",
          source: {
            type: "github_repo",
            repoUrl: "https://github.com/example/github-project",
          },
        }),
      });

      expect(response.status).toBe(201);
      const project = await readJson(response) as {
        name: string;
        sources: Array<Record<string, unknown>>;
      };
      expect(project.name).toBe("GitHub Project");
      expect(project.sources).toEqual([
        expect.objectContaining({
          type: "github_repo",
          repoUrl: "https://github.com/example/github-project",
          isDefault: true,
        }),
      ]);
      expect(project.sources[0]).not.toHaveProperty("hostId");
      expect(project.sources[0]).not.toHaveProperty("path");
    } finally {
      await harness.cleanup();
    }
  });

  it("supports project source CRUD and reassigns the default source on delete", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-source-1" });
      const secondaryHost = seedHost(harness.deps, { id: "host-source-2" });

      const projectResponse = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Project Sources",
          source: { type: "local_path", hostId: host.id, path: "/tmp/project-sources" },
        }),
      });
      const project = await readJson(projectResponse) as {
        id: string;
        sources: Array<{ id: string; isDefault: boolean }>;
      };
      const defaultSourceId = project.sources[0]?.id;
      expect(defaultSourceId).toBeTruthy();

      const createSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: secondaryHost.id,
            path: "/tmp/project-sources-2",
            type: "local_path",
          }),
        },
      );
      expect(createSourceResponse.status).toBe(201);
      const secondSource = await readJson(createSourceResponse) as { id: string };

      const missingTypeResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: secondaryHost.id,
            path: "/tmp/project-sources-missing-type",
          }),
        },
      );
      expect(missingTypeResponse.status).toBe(400);

      const createGitHubSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "github_repo",
            repoUrl: "https://github.com/example/project-sources",
          }),
        },
      );
      expect(createGitHubSourceResponse.status).toBe(201);
      const githubSource = await readJson(createGitHubSourceResponse) as {
        repoUrl: string;
        type: string;
      };
      expect(githubSource).toMatchObject({
        type: "github_repo",
        repoUrl: "https://github.com/example/project-sources",
      });
      expect(githubSource).not.toHaveProperty("hostId");

      const invalidGitHubSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: secondaryHost.id,
            type: "github_repo",
            repoUrl: "https://github.com/example/project-sources-extra-host",
          }),
        },
      );
      expect(invalidGitHubSourceResponse.status).toBe(400);

      const updateSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources/${secondSource.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "local_path",
            path: "/tmp/project-sources-renamed",
          }),
        },
      );
      expect(updateSourceResponse.status).toBe(200);
      await expect(readJson(updateSourceResponse)).resolves.toMatchObject({
        id: secondSource.id,
        path: "/tmp/project-sources-renamed",
      });

      const deleteSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources/${defaultSourceId}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteSourceResponse.status).toBe(200);

      const projectAfterDeleteResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
      );
      const projectAfterDelete = await readJson(projectAfterDeleteResponse) as {
        sources: Array<{ id: string; isDefault: boolean; repoUrl?: string; type: string }>;
      };
      expect(projectAfterDelete.sources).toEqual([
        expect.objectContaining({
          id: secondSource.id,
          isDefault: true,
        }),
        expect.objectContaining({
          type: "github_repo",
          isDefault: false,
          repoUrl: "https://github.com/example/project-sources",
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("derives host connection status from active sessions with valid leases", async () => {
    const harness = await createTestAppHarness();
    try {
      const connected = seedHostSession(harness.deps, { id: "host-connected" });
      const disconnected = seedHost(harness.deps, { id: "host-disconnected" });
      const expired = seedHostSession(harness.deps, { id: "host-expired" });

      harness.db
        .update(hostDaemonSessions)
        .set({
          leaseExpiresAt: Date.now() - 1,
        })
        .where(eq(hostDaemonSessions.id, expired.session.id))
        .run();

      const listResponse = await harness.app.request("/api/v1/hosts");
      expect(listResponse.status).toBe(200);
      const hosts = await readJson(listResponse) as Array<{
        id: string;
        status: string;
      }>;
      expect(hosts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: connected.host.id,
            status: "connected",
          }),
          expect.objectContaining({
            id: disconnected.id,
            status: "disconnected",
          }),
          expect.objectContaining({
            id: expired.host.id,
            status: "disconnected",
          }),
        ]),
      );

      const getResponse = await harness.app.request(
        `/api/v1/hosts/${connected.host.id}`,
      );
      expect(getResponse.status).toBe(200);
      await expect(readJson(getResponse)).resolves.toMatchObject({
        id: connected.host.id,
        status: "connected",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues workspace.list_files for the default project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-files",
      });
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-files",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: source.path,
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/files?query=src&limit=1`,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.list_files" &&
          command.environmentId === environment.id,
      );
      expect(queued.command).toMatchObject({
        workspaceContext: { workspacePath: "/tmp/project-files", workspaceProvisionType: "unmanaged" },
        query: "src",
        limit: 1,
      });
      await reportQueuedCommandSuccess(harness, queued, {
        files: [
          { path: "src/index.ts", name: "index.ts" },
        ],
        truncated: true,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        files: [
          { path: "src/index.ts", name: "index.ts" },
        ],
        truncated: true,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("stores project attachments and serves their content", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-attachments",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-attachments",
      });

      const formData = new FormData();
      formData.set(
        "file",
        new File(["attachment body"], "notes.txt", {
          type: "text/plain",
        }),
        "notes.txt",
      );

      const uploadResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/attachments`,
        {
          method: "POST",
          body: formData,
        },
      );
      expect(uploadResponse.status).toBe(201);
      const uploaded = await readJson(uploadResponse) as {
        mimeType?: string;
        name: string;
        path: string;
        type: string;
      };
      expect(uploaded).toMatchObject({
        type: "localFile",
        name: "notes.txt",
        mimeType: "text/plain",
      });
      expect(uploaded.path).toBeTruthy();

      const contentResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/attachments/content?path=${encodeURIComponent(uploaded.path)}`,
      );
      expect(contentResponse.status).toBe(200);
      expect(
        Buffer.from(await contentResponse.arrayBuffer()).toString("utf8"),
      ).toBe("attachment body");
    } finally {
      await harness.cleanup();
    }
  });

  it("queues environment.destroy commands for managed environments when deleting a project", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-delete-env" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-delete-env",
      });

      // Managed environment that should be destroyed.
      const managed = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/managed-worktree",
        managed: true,
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });

      // Already-destroyed managed environment — should NOT get another command.
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/already-destroyed",
        managed: true,
        status: "destroyed",
        workspaceProvisionType: "managed-clone",
      });

      // Unmanaged environment — should NOT get a destroy command.
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/unmanaged",
        managed: false,
        status: "ready",
        workspaceProvisionType: "unmanaged",
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);

      const commands = harness.db
        .select()
        .from(hostDaemonCommands)
        .all()
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)));

      const destroyCommands = commands.filter(
        (c) => c.type === "environment.destroy",
      );
      expect(destroyCommands).toHaveLength(1);
      expect(destroyCommands[0]).toMatchObject({
        type: "environment.destroy",
        environmentId: managed.id,
        workspaceContext: {
          workspacePath: "/tmp/managed-worktree",
          workspaceProvisionType: "managed-worktree",
        },
      });

      // Project should be gone.
      const listResponse = await harness.app.request("/api/v1/projects");
      expect(listResponse.status).toBe(200);
      await expect(readJson(listResponse)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
