import { eq } from "drizzle-orm";
import { hostDaemonSessions } from "@bb/db";
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
          hostId: host.id,
          sourcePath: "/tmp/project-one",
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
          hostId: host.id,
          sourcePath: "/tmp/project-sources",
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

      const updateSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources/${secondSource.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
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
        sources: Array<{ id: string; isDefault: boolean }>;
      };
      expect(projectAfterDelete.sources).toEqual([
        expect.objectContaining({
          id: secondSource.id,
          isDefault: true,
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
        path: source.path ?? "/tmp/project-files",
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
        query: "src",
      });
      await reportQueuedCommandSuccess(harness, queued, {
        files: [
          { path: "src/index.ts", name: "index.ts" },
          { path: "src/routes.ts", name: "routes.ts" },
        ],
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual([
        { path: "src/index.ts", name: "index.ts" },
      ]);
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
});
