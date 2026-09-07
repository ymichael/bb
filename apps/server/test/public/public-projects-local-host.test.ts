import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  ensurePersonalProject,
  listPublicProjects,
  setExperiments,
} from "@bb/db";
import { defaultExperiments, PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const projectResponseSchema = z.object({
  id: z.string(),
  gitRemoteUrl: z.string().nullable(),
  sources: z.array(
    z.object({
      id: z.string(),
      path: z.string().nullable().optional(),
    }),
  ),
});

describe("public project local host routes", () => {
  it("creates a project when a personal thread already uses its folder", async () => {
    await withTestHarness(async (harness) => {
      const offlinePrimary = seedHost(harness.deps, {
        id: "host-personal-folder-project",
      });
      seedPrimaryHost(harness.deps, offlinePrimary.id);
      ensurePersonalProject(harness.db);
      const personalEnvironment = seedEnvironment(harness.deps, {
        hostId: offlinePrimary.id,
        projectId: PERSONAL_PROJECT_ID,
        path: "/tmp/personal-thread-folder",
      });
      seedThread(harness.deps, {
        projectId: PERSONAL_PROJECT_ID,
        environmentId: personalEnvironment.id,
        status: "idle",
      });

      const response = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Personal Thread Folder",
          source: {
            type: "local_path",
            hostId: offlinePrimary.id,
            path: "/tmp/personal-thread-folder",
          },
        }),
      });

      expect(response.status).toBe(201);
      const project = projectResponseSchema.parse(await readJson(response));
      expect(project.id).not.toBe(PERSONAL_PROJECT_ID);
      expect(listPublicProjects(harness.db)).toEqual([
        expect.objectContaining({ id: project.id }),
      ]);
    });
  });

  it("returns the existing project when its local folder is added again", async () => {
    await withTestHarness(async (harness) => {
      const offlinePrimary = seedHost(harness.deps, {
        id: "host-duplicate-project",
      });
      seedPrimaryHost(harness.deps, offlinePrimary.id);

      const create = (name: string, path: string) =>
        harness.app.request("/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            source: {
              type: "local_path",
              hostId: offlinePrimary.id,
              path,
            },
          }),
        });

      const firstResponse = await create(
        "Original Project",
        "/tmp/duplicate-project",
      );
      const repeatedResponse = await create(
        "Duplicate Project",
        "/tmp/duplicate-project/",
      );

      expect(firstResponse.status).toBe(201);
      expect(repeatedResponse.status).toBe(201);
      const firstProject = projectResponseSchema.parse(
        await readJson(firstResponse),
      );
      const repeatedProject = projectResponseSchema.parse(
        await readJson(repeatedResponse),
      );
      expect(repeatedProject.id).toBe(firstProject.id);
      expect(listPublicProjects(harness.db)).toHaveLength(1);
    });
  });

  it("creates projects and local sources when inspection is unavailable", async () => {
    await withTestHarness(async (harness) => {
      const offlinePrimary = seedHost(harness.deps, {
        id: "host-offline-primary",
      });
      seedPrimaryHost(harness.deps, offlinePrimary.id);

      const projectResponse = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Offline Project",
          source: {
            type: "local_path",
            hostId: offlinePrimary.id,
            path: "/tmp/offline-project",
          },
        }),
      });
      expect(projectResponse.status).toBe(201);
      const project = projectResponseSchema.parse(
        await readJson(projectResponse),
      );
      expect(project.gitRemoteUrl).toBeNull();

      setExperiments(harness.db, {
        ...defaultExperiments,
      });
      const offlineSecondary = seedHost(harness.deps, {
        id: "host-offline-secondary",
      });
      const sourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "local_path",
            hostId: offlineSecondary.id,
            path: "/tmp/offline-project-secondary",
          }),
        },
      );
      expect(sourceResponse.status).toBe(201);
      await expect(readJson(sourceResponse)).resolves.toMatchObject({
        hostId: offlineSecondary.id,
        path: "/tmp/offline-project-secondary",
      });
      const refreshed = await harness.app.request(
        `/api/v1/projects/${project.id}`,
      );
      await expect(readJson(refreshed)).resolves.toMatchObject({
        gitRemoteUrl: null,
      });
    });
  });

  it("supports local project source updates and secondary host sources", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-source-1" });
      seedPrimaryHost(harness.deps, host.id);
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-source-2",
      });
      setExperiments(harness.db, {
        ...defaultExperiments,
      });

      const projectResponsePromise = harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Project Sources",
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/tmp/project-sources",
          },
        }),
      });
      const createInspection = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "project.inspect",
      );
      await reportQueuedCommandSuccess(harness, createInspection, {
        path: "/tmp/project-sources",
        gitRemoteUrl: "ssh://git.example.test/project-sources.git",
      });
      const projectResponse = await projectResponsePromise;
      const project = projectResponseSchema.parse(
        await readJson(projectResponse),
      );
      const defaultSourceId = project.sources[0]?.id;
      expect(defaultSourceId).toBeTruthy();

      const createSourceResponsePromise = harness.app.request(
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
      const addInspection = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "project.inspect" &&
          command.path === "/tmp/project-sources-2",
      );
      await reportQueuedCommandSuccess(harness, addInspection, {
        path: "/tmp/project-sources-2",
        gitRemoteUrl: "ssh://git.example.test/ignored-different-origin.git",
      });
      const createSourceResponse = await createSourceResponsePromise;
      expect(createSourceResponse.status).toBe(201);
      await expect(readJson(createSourceResponse)).resolves.toMatchObject({
        hostId: secondaryHost.id,
        path: "/tmp/project-sources-2",
        type: "local_path",
      });
      const anchoredProjectResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
      );
      await expect(readJson(anchoredProjectResponse)).resolves.toMatchObject({
        gitRemoteUrl: "ssh://git.example.test/project-sources.git",
      });

      const updateSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources/${defaultSourceId}`,
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
        id: defaultSourceId,
        path: "/tmp/project-sources-renamed",
      });

      const deleteSourceResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources/${defaultSourceId}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteSourceResponse.status).toBe(200);
    });
  });

  it("serves project source file content from the local primary source", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-file-content",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-file-content",
      });

      const filePromise = harness.app.request(
        `/api/v1/projects/${project.id}/files/content?path=${encodeURIComponent("src/app.ts")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === "/tmp/project-file-content/src/app.ts",
      );
      expect(fileCommand.command).toMatchObject({
        path: "/tmp/project-file-content/src/app.ts",
        rootPath: "/tmp/project-file-content",
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: "/tmp/project-file-content/src/app.ts",
        content: "console.log('ok');",
        contentEncoding: "utf8",
        mimeType: "application/typescript",
        sizeBytes: 18,
        sha256: "0".repeat(64),
      });

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toContain(
        "application/typescript",
      );
      expect(fileResponse.headers.get("cache-control")).toBe(
        "private, no-cache",
      );
      expect(fileResponse.headers.get("etag")).toBe(`"${"0".repeat(64)}"`);
      expect(fileResponse.headers.get("x-bb-content-encoding")).toBe("utf8");
      await expect(fileResponse.text()).resolves.toBe("console.log('ok');");

      const revalidatePromise = harness.app.request(
        `/api/v1/projects/${project.id}/files/content?path=${encodeURIComponent("src/app.ts")}`,
        { headers: { "if-none-match": `"${"0".repeat(64)}"` } },
      );
      const revalidateCommand = await waitForQueuedCommandAfter(
        harness,
        fileCommand.row.cursor,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === "/tmp/project-file-content/src/app.ts",
      );
      await reportQueuedCommandSuccess(harness, revalidateCommand, {
        path: "/tmp/project-file-content/src/app.ts",
        content: "console.log('ok');",
        contentEncoding: "utf8",
        mimeType: "application/typescript",
        sizeBytes: 18,
        sha256: "0".repeat(64),
      });
      const revalidated = await revalidatePromise;
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(`"${"0".repeat(64)}"`);
      expect(revalidated.headers.get("x-bb-content-encoding")).toBe("utf8");
      expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
    });
  });
});
