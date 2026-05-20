import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  archiveThread,
  createThread,
  getProjectExecutionDefaults,
  getProject,
  getThread,
  hostDaemonCommands,
  hostDaemonSessions,
  threads,
  upsertProjectExecutionDefaults,
  updateHost,
} from "@bb/db";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import { threadListEntrySchema, threadSchema } from "@bb/domain";
import { makeWorkspaceMergeBase, makeWorkspaceStatus } from "@bb/test-helpers";
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
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";
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
    }),
  ),
});

const projectWithThreadsResponseSchema = projectResponseSchema.extend({
  threads: z.array(threadListEntrySchema),
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

const branchListResponseSchema = z.object({
  branches: z.array(z.string()),
  current: z.string().nullable(),
  defaultBranch: z.string().nullable(),
});

interface ReportCleanWorkspaceStatusForEnvironmentArgs {
  afterCursor?: number;
  environmentId: string;
}

async function reportCleanWorkspaceStatusForEnvironment(
  harness: TestAppHarness,
  args: ReportCleanWorkspaceStatusForEnvironmentArgs,
) {
  const command =
    args.afterCursor === undefined
      ? await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === args.environmentId,
        )
      : await waitForQueuedCommandAfter(
          harness,
          args.afterCursor,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === args.environmentId,
        );
  await reportQueuedCommandSuccess(harness, command, {
    workspaceStatus: makeWorkspaceStatus({
      branch: { currentBranch: "bb/thread", defaultBranch: "main" },
      mergeBase: makeWorkspaceMergeBase({ baseRef: "origin/main" }),
    }),
  });
  return command;
}

async function respondToManagerPreferencesMissing(
  harness: TestAppHarness,
): Promise<void> {
  const command = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.state === "pending" &&
      command.type === "host.read_file" &&
      command.path.endsWith("/PREFERENCES.md"),
  );
  const response = await reportQueuedCommandError(harness, command, {
    errorCode: "ENOENT",
    errorMessage: "File not found",
  });
  expect(response.status).toBe(200);
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
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/tmp/project-one",
          },
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdProject = projectResponseSchema.parse(
        await readJson(createResponse),
      );
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

  it("embeds unarchived sidebar threads when requested", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-thread-include",
      });
      const { project: firstProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "First Project",
      });
      const { project: secondProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Second Project",
      });
      const firstEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-thread-include-first",
        projectId: firstProject.id,
      });
      const secondEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-thread-include-second",
        projectId: secondProject.id,
      });
      const olderThread = seedThread(harness.deps, {
        environmentId: firstEnvironment.id,
        projectId: firstProject.id,
        title: "Older Thread",
      });
      const newerThread = seedThread(harness.deps, {
        environmentId: firstEnvironment.id,
        projectId: firstProject.id,
        title: "Newer Thread",
      });
      const archivedThread = seedThread(harness.deps, {
        environmentId: firstEnvironment.id,
        projectId: firstProject.id,
        title: "Archived Thread",
      });
      const secondProjectThread = seedThread(harness.deps, {
        environmentId: secondEnvironment.id,
        projectId: secondProject.id,
        title: "Second Project Thread",
      });
      archiveThread(harness.deps.db, harness.deps.hub, archivedThread.id);
      harness.deps.db
        .update(threads)
        .set({ createdAt: 100, updatedAt: 100 })
        .where(eq(threads.id, olderThread.id))
        .run();
      harness.deps.db
        .update(threads)
        .set({ createdAt: 200, updatedAt: 200 })
        .where(eq(threads.id, newerThread.id))
        .run();
      harness.deps.db
        .update(threads)
        .set({ createdAt: 150, updatedAt: 150 })
        .where(eq(threads.id, secondProjectThread.id))
        .run();

      const leanResponse = await harness.app.request("/api/v1/projects");
      expect(leanResponse.status).toBe(200);
      const leanPayload = await leanResponse.text();
      expect(leanPayload).not.toContain('"threads"');
      expect(
        z.array(projectResponseSchema).parse(JSON.parse(leanPayload)),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: firstProject.id }),
          expect.objectContaining({ id: secondProject.id }),
        ]),
      );

      const response = await harness.app.request(
        "/api/v1/projects?include=threads",
      );
      expect(response.status).toBe(200);
      const projects = z
        .array(projectWithThreadsResponseSchema)
        .parse(await readJson(response));
      const firstProjectResponse = projects.find(
        (project) => project.id === firstProject.id,
      );
      const secondProjectResponse = projects.find(
        (project) => project.id === secondProject.id,
      );

      expect(firstProjectResponse?.threads.map((thread) => thread.id)).toEqual([
        newerThread.id,
        olderThread.id,
      ]);
      expect(
        firstProjectResponse?.threads.some(
          (thread) => thread.id === archivedThread.id,
        ),
      ).toBe(false);
      expect(secondProjectResponse?.threads.map((thread) => thread.id)).toEqual(
        [secondProjectThread.id],
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid project list include values", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(
        "/api/v1/projects?include=threads,invalid",
      );
      expect(response.status).toBe(400);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unsupported local project paths at the API boundary", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-path-validation",
      });
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-path-validation",
      });

      const createResponse = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Relative Path Project",
          source: {
            type: "local_path",
            hostId: host.id,
            path: "relative/project",
          },
        }),
      });
      expect(createResponse.status).toBe(400);
      await expect(readJson(createResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "Project path must be an absolute path",
        ),
      });

      const updateResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources/${source.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "local_path",
            path: "relative/path",
          }),
        },
      );
      expect(updateResponse.status).toBe(400);
      await expect(readJson(updateResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "Project path must be an absolute path",
        ),
      });

      const nativeWindowsCreateResponse = await harness.app.request(
        "/api/v1/projects",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Windows Path Project",
            source: {
              type: "local_path",
              hostId: host.id,
              path: "C:\\Users\\michael\\bb",
            },
          }),
        },
      );
      expect(nativeWindowsCreateResponse.status).toBe(400);
      await expect(
        readJson(nativeWindowsCreateResponse),
      ).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "Native Windows paths are not supported",
        ),
      });

      const nativeWindowsUpdateResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/sources/${source.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "local_path",
            path: "\\\\server\\share\\bb",
          }),
        },
      );
      expect(nativeWindowsUpdateResponse.status).toBe(400);
      await expect(
        readJson(nativeWindowsUpdateResponse),
      ).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "Native Windows paths are not supported",
        ),
      });

      const rootPathCreateResponse = await harness.app.request(
        "/api/v1/projects",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Root Path Project",
            source: { type: "local_path", hostId: host.id, path: "/" },
          }),
        },
      );
      expect(rootPathCreateResponse.status).toBe(400);
      await expect(readJson(rootPathCreateResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("filesystem root"),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns null when a project has no stored default execution options for a provider", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-defaults-none",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-defaults-none",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/default-execution-options?threadType=standard`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the remembered provider and execution options for a project thread type", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-defaults",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-defaults",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        threadType: "standard",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/default-execution-options?threadType=standard`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns thread-type-matched stored default execution options for a project", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-manager-defaults",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-manager-defaults",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        threadType: "standard",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        threadType: "manager",
        model: "gpt-5-mini",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/default-execution-options?threadType=manager`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("stores server-owned manager defaults separately from standard thread defaults when hiring a manager from the app", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-defaults",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/manager-defaults",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        threadType: "standard",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/managers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "app",
            environment: { type: "host", hostId: host.id },
          }),
        },
      );
      await respondToManagerPreferencesMissing(harness);
      const response = await responsePromise;

      expect(response.status).toBe(201);
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          threadType: "standard",
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          threadType: "manager",
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "xhigh",
        permissionMode: "full",
        serviceTier: "default",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("inherits remembered manager defaults for CLI-origin manager creation without overwriting them", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-defaults-cli",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/manager-defaults-cli",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        threadType: "manager",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/managers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "cli",
            environment: { type: "host", hostId: host.id },
          }),
        },
      );
      await respondToManagerPreferencesMissing(harness);
      const response = await responsePromise;

      expect(response.status).toBe(201);
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          threadType: "manager",
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "workspace-write",
        serviceTier: "fast",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the server-owned manager defaults when the CLI omits provider and model with no stored manager defaults", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-defaults-cli-fallback",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/manager-defaults-cli-fallback",
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/managers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "cli",
            environment: { type: "host", hostId: host.id },
          }),
        },
      );
      await respondToManagerPreferencesMissing(harness);
      const response = await responsePromise;

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        providerId: "codex",
        type: "manager",
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          threadType: "manager",
        }),
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects manager creation without an origin at the public API boundary", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-manager-missing-origin",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/manager-missing-origin",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/managers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            environment: { type: "host", hostId: host.id },
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining('expected one of "app"|"cli"'),
      });
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

      const createThreadResponse = await harness.app.request(
        "/api/v1/threads",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Create before project delete" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          }),
        },
      );

      expect(createThreadResponse.status).toBe(201);
      const createdThread = threadSchema.parse(
        await readJson(createThreadResponse),
      );
      expect(createdThread.status).toBe("provisioning");

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );

      const deleteProjectResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        {
          method: "DELETE",
        },
      );

      expect(deleteProjectResponse.status).toBe(200);
      expect(getProject(harness.db, project.id)).not.toBeNull();
      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        stopRequestedAt: expect.any(Number),
        status: "provisioning",
      });
      await expect(readJson(deleteProjectResponse)).resolves.toEqual({
        ok: true,
      });

      const threadsResponse = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}`,
      );
      expect(threadsResponse.status).toBe(404);

      const threadResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}`,
      );
      expect(threadResponse.status).toBe(404);

      const queuedStop = await waitForQueuedCommandAfter(
        harness,
        queuedStart.row.cursor,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === createdThread.id,
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

  it("hides live threads that appear after project deletion begins", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-delete-live-thread",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-delete-live-thread",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        path: "/tmp/project-delete-live-thread-managed",
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });

      const deleteProjectResponse = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        { method: "DELETE" },
      );
      expect(deleteProjectResponse.status).toBe(200);
      expect(getProject(harness.db, project.id)).not.toBeNull();

      const liveThread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        providerId: "codex",
        status: "created",
      });
      expect(getThread(harness.db, liveThread.id)).toMatchObject({
        deletedAt: null,
        projectId: project.id,
      });

      const threadsResponse = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}`,
      );
      expect(threadsResponse.status).toBe(404);

      const threadResponse = await harness.app.request(
        `/api/v1/threads/${liveThread.id}`,
      );
      expect(threadResponse.status).toBe(404);
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
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/tmp/project-sources",
          },
        }),
      });
      const project = projectResponseSchema.parse(
        await readJson(projectResponse),
      );
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
      const hosts = hostStatusListResponseSchema.parse(
        await readJson(listResponse),
      );
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

  it("queues host.list_files for the default project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-files",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-files",
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/files?query=src&limit=1&environmentId=`,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === "/tmp/project-files",
      );
      expect(queued.command).toMatchObject({
        path: "/tmp/project-files",
        query: "src",
        limit: 1,
      });
      await reportQueuedCommandSuccess(harness, queued, {
        files: [{ path: "src/index.ts", name: "index.ts" }],
        truncated: true,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        files: [{ path: "src/index.ts", name: "index.ts" }],
        truncated: true,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues host.list_paths for project paths with directories included", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-paths",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-paths",
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/paths?query=src&limit=2&environmentId=&includeFiles=true&includeDirectories=true`,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_paths" &&
          command.path === "/tmp/project-paths",
      );
      expect(queued.command).toMatchObject({
        path: "/tmp/project-paths",
        query: "src",
        limit: 2,
        includeFiles: true,
        includeDirectories: true,
      });
      await reportQueuedCommandSuccess(harness, queued, {
        paths: [
          {
            kind: "directory",
            path: "src",
            name: "src",
            score: 100,
            positions: [0, 1, 2],
          },
          {
            kind: "file",
            path: "src/index.ts",
            name: "index.ts",
            score: 75,
            positions: [0, 1, 2],
          },
        ],
        truncated: false,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        paths: [
          {
            kind: "directory",
            path: "src",
            name: "src",
            score: 100,
            positions: [0, 1, 2],
          },
          {
            kind: "file",
            path: "src/index.ts",
            name: "index.ts",
            score: 75,
            positions: [0, 1, 2],
          },
        ],
        truncated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues host.list_branches for the default project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-branches",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-branches",
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/branches?hostId=${host.id}`,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_branches" &&
          command.path === "/tmp/project-branches",
      );
      expect(queued.command).toMatchObject({
        path: "/tmp/project-branches",
      });
      await reportQueuedCommandSuccess(harness, queued, {
        branches: ["main", "feature/test"],
        current: "feature/test",
        defaultBranch: "main",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(branchListResponseSchema.parse(await readJson(response))).toEqual({
        branches: ["main", "feature/test"],
        current: "feature/test",
        defaultBranch: "main",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 for branch listing on a missing project", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(
        "/api/v1/projects/proj_missing/branches?hostId=host_missing",
      );

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "project_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("scopes host.list_files to a worktree environment when provided", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-files-worktree",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-files-primary",
      });
      const worktree = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-files-worktree",
        managed: true,
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/files?query=src&limit=1&environmentId=${worktree.id}`,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === "/tmp/project-files-worktree",
      );
      expect(queued.command).toMatchObject({
        path: "/tmp/project-files-worktree",
        query: "src",
        limit: 1,
      });
      await reportQueuedCommandSuccess(harness, queued, {
        files: [{ path: "src/new-file.ts", name: "new-file.ts" }],
        truncated: false,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        files: [{ path: "src/new-file.ts", name: "new-file.ts" }],
        truncated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects an environmentId that belongs to a different project", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-files-cross",
      });
      const { project: projectA } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-files-a",
      });
      const { project: projectB } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-files-b",
      });
      const otherEnv = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: projectB.id,
        path: "/tmp/project-files-b",
        managed: true,
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${projectA.id}/files?query=src&environmentId=${otherEnv.id}`,
      );
      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "environment_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a non-ready environmentId on the project files route", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-files-not-ready",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-files-not-ready",
      });
      const provisioning = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-files-not-ready-worktree",
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/files?query=src&environmentId=${provisioning.id}`,
      );
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
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
      const uploaded = attachmentResponseSchema.parse(
        await readJson(uploadResponse),
      );
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
        workspaceProvisionType: "managed-worktree",
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

      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === managed.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: makeWorkspaceStatus({
          branch: { currentBranch: "bb/thread", defaultBranch: "main" },
          mergeBase: makeWorkspaceMergeBase({ baseRef: "origin/main" }),
        }),
      });

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
      const { host } = seedHostSession(harness.deps, {
        id: "host-delete-cmds",
      });
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
      const createThreadResponse = await harness.app.request(
        "/api/v1/threads",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "test" }],
            environment: { type: "reuse", environmentId: environment.id },
          }),
        },
      );
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

      const deletePromise = harness.app.request(
        `/api/v1/projects/${project.id}`,
        { method: "DELETE" },
      );
      const firstStatus = await reportCleanWorkspaceStatusForEnvironment(
        harness,
        { environmentId: firstEnvironment.id },
      );
      await reportCleanWorkspaceStatusForEnvironment(harness, {
        afterCursor: firstStatus.row.cursor,
        environmentId: secondEnvironment.id,
      });
      const deleteResponse = await deletePromise;
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });

      const firstDestroy = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === firstEnvironment.id,
      );
      const secondDestroy = await waitForQueuedCommandAfter(
        harness,
        firstDestroy.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === secondEnvironment.id,
      );

      await reportQueuedCommandSuccess(harness, firstDestroy, {});
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
          command.type === "environment.destroy" &&
          command.environmentId === secondEnvironment.id,
      );
      await reportQueuedCommandSuccess(harness, retriedDestroy, {});

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
