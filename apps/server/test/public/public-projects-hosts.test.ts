import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  getProject,
  getThread,
  hostDaemonCommands,
  hostDaemonSessions,
  updateHost,
} from "@bb/db";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import { threadSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { runProjectDeletionSweep } from "../../src/services/system/periodic-sweeps.js";

const idOnlyResponseSchema = z.object({
  id: z.string(),
});

const projectResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  sources: z.array(
    z.object({
      id: z.string(),
      isDefault: z.boolean(),
      type: z.string(),
      hostId: z.string().nullable().optional(),
      path: z.string().nullable().optional(),
      repoUrl: z.string().nullable().optional(),
    }),
  ),
});

const attachmentResponseSchema = z.object({
  mimeType: z.string().optional(),
  name: z.string(),
  path: z.string(),
  type: z.string(),
});

const hostStatusListResponseSchema = z.array(
  z.object({
    id: z.string(),
    status: z.string(),
  }),
);

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
      const createdProject = projectResponseSchema.parse(await readJson(createResponse));
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

  it("keeps created threads pending deletion until queued thread.start work is stopped", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-delete-created-start",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-delete-created-start",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-delete-created-start",
      });

      const createThreadResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Create before project delete" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(createThreadResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createThreadResponse));
      expect(createdThread.status).toBe("created");

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start"
          && command.threadId === createdThread.id,
      );

      const deleteProjectResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        {
          method: "DELETE",
        },
      );

      expect(deleteProjectResponse.status).toBe(200);
      await expect(readJson(deleteProjectResponse)).resolves.toEqual({ ok: true });
      expect(getProject(harness.db, project.id)).not.toBeNull();
      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        stopRequestedAt: expect.any(Number),
        status: "created",
      });

      const queuedStop = await waitForQueuedCommandAfter(
        harness,
        queuedStart.row.cursor,
        ({ command }) =>
          command.type === "thread.stop"
          && command.threadId === createdThread.id,
      );
      expect(queuedStop.command).toMatchObject({
        environmentId: environment.id,
        threadId: createdThread.id,
      });

      const projectsResponse = await harness.app.request("/api/v1/projects");
      expect(projectsResponse.status).toBe(200);
      await expect(readJson(projectsResponse)).resolves.toEqual([]);
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
      const project = projectResponseSchema.parse(await readJson(response));
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
      const project = projectResponseSchema.parse(await readJson(projectResponse));
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
      const secondSource = idOnlyResponseSchema.parse(
        await readJson(createSourceResponse),
      );

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
      const githubSource = z.object({
        repoUrl: z.string(),
        type: z.string(),
      }).parse(await readJson(createGitHubSourceResponse));
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
      const projectAfterDelete = projectResponseSchema.parse(
        await readJson(projectAfterDeleteResponse),
      );
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
      const ephemeral = seedHostSession(harness.deps, {
        id: "host-ephemeral",
        type: "ephemeral",
      });
      const destroyed = seedHostSession(harness.deps, { id: "host-destroyed" });

      harness.db
        .update(hostDaemonSessions)
        .set({
          leaseExpiresAt: Date.now() - 1,
        })
        .where(eq(hostDaemonSessions.id, expired.session.id))
        .run();
      updateHost(harness.db, harness.hub, destroyed.host.id, {
        destroyedAt: Date.now(),
      });

      const listResponse = await harness.app.request("/api/v1/hosts");
      expect(listResponse.status).toBe(200);
      const hosts = hostStatusListResponseSchema.parse(await readJson(listResponse));
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
      expect(hosts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: ephemeral.host.id }),
          expect.objectContaining({ id: destroyed.host.id }),
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

      const ephemeralResponse = await harness.app.request(
        `/api/v1/hosts/${ephemeral.host.id}`,
      );
      expect(ephemeralResponse.status).toBe(200);
      await expect(readJson(ephemeralResponse)).resolves.toMatchObject({
        id: ephemeral.host.id,
        type: "ephemeral",
        status: "connected",
      });

      const destroyedResponse = await harness.app.request(
        `/api/v1/hosts/${destroyed.host.id}`,
      );
      expect(destroyedResponse.status).toBe(404);
      await expect(readJson(destroyedResponse)).resolves.toMatchObject({
        code: "host_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects destroyed hosts for project sources", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-destroyed-source" });
      updateHost(harness.db, harness.hub, host.id, {
        destroyedAt: Date.now(),
      });

      const response = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Destroyed Host Project",
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/tmp/destroyed-host-project",
          },
        }),
      });

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_not_found",
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
      const uploaded = attachmentResponseSchema.parse(await readJson(uploadResponse));
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

      // Project is hidden from public reads immediately, but remains internally
      // until managed teardown completes.
      const listResponse = await harness.app.request("/api/v1/projects");
      expect(listResponse.status).toBe(200);
      await expect(readJson(listResponse)).resolves.toEqual([]);
      expect(getProject(harness.db, project.id)).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("renames a host via PATCH", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-rename" });

      const patchResponse = await harness.app.request(
        `/api/v1/hosts/${host.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed Host" }),
        },
      );
      expect(patchResponse.status).toBe(200);
      await expect(readJson(patchResponse)).resolves.toMatchObject({
        id: host.id,
        name: "Renamed Host",
      });

      const getResponse = await harness.app.request(`/api/v1/hosts/${host.id}`);
      expect(getResponse.status).toBe(200);
      await expect(readJson(getResponse)).resolves.toMatchObject({
        id: host.id,
        name: "Renamed Host",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 when renaming a destroyed host via PATCH", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-rename-destroyed" });
      updateHost(harness.db, harness.hub, host.id, {
        destroyedAt: Date.now(),
      });

      const patchResponse = await harness.app.request(
        `/api/v1/hosts/${host.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed Host" }),
        },
      );

      expect(patchResponse.status).toBe(404);
      await expect(readJson(patchResponse)).resolves.toMatchObject({
        code: "host_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes a host via DELETE", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete" });

      const deleteResponse = await harness.app.request(
        `/api/v1/hosts/${host.id}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });

      const getResponse = await harness.app.request(`/api/v1/hosts/${host.id}`);
      expect(getResponse.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 when deleting a destroyed host via DELETE", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete-destroyed" });
      updateHost(harness.db, harness.hub, host.id, {
        destroyedAt: Date.now(),
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/hosts/${host.id}`,
        { method: "DELETE" },
      );

      expect(deleteResponse.status).toBe(404);
      await expect(readJson(deleteResponse)).resolves.toMatchObject({
        code: "host_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes a host that has pending commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-delete-cmds" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/host-delete-cmds",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/host-delete-cmds",
      });

      // Create a thread to generate queued commands for this host
      const createThreadResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "test" }],
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });
      expect(createThreadResponse.status).toBe(201);

      // Wait for the command to be queued
      await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.start",
      );

      const deleteResponse = await harness.app.request(
        `/api/v1/hosts/${host.id}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });

      const getResponse = await harness.app.request(`/api/v1/hosts/${host.id}`);
      expect(getResponse.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 when deleting a nonexistent host", async () => {
    const harness = await createTestAppHarness();
    try {
      const deleteResponse = await harness.app.request(
        `/api/v1/hosts/host-nonexistent`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

  it("retries managed project teardown after a partial destroy failure", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-delete-project-retry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-delete-retry",
      });
      const firstEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/project-delete-retry/one",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });
      const secondEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/project-delete-retry/two",
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });

      const firstDestroy = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy"
          && command.environmentId === firstEnvironment.id,
      );
      const secondDestroy = await waitForQueuedCommandAfter(
        harness,
        firstDestroy.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy"
          && command.environmentId === secondEnvironment.id,
      );

      await reportQueuedCommandSuccess(harness, firstDestroy, { ok: true });
      await reportQueuedCommandError(harness, secondDestroy, {
        errorCode: "provider_error",
        errorMessage: "Destroy failed",
      });

      expect(getProject(harness.db, project.id)).not.toBeNull();

      await runProjectDeletionSweep(harness.deps);

      const retriedDestroy = await waitForQueuedCommandAfter(
        harness,
        secondDestroy.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy"
          && command.environmentId === secondEnvironment.id,
      );
      await reportQueuedCommandSuccess(harness, retriedDestroy, { ok: true });

      await runProjectDeletionSweep(harness.deps);

      expect(getProject(harness.db, project.id)).toBeNull();
      const listResponse = await harness.app.request("/api/v1/projects");
      expect(listResponse.status).toBe(200);
      await expect(readJson(listResponse)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
