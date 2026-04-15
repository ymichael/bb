import {
  cleanWorkspaceStatus,
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  createEnvironment,
  createThread,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  listThreads,
  threads,
} from "@bb/db";
import { threadSchema } from "@bb/domain";
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
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";

describe("public thread archive delete cleanup routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });


  it("stops threads, archives unmanaged workspaces directly, and requires confirmation for dirty isolated managed workspaces", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const isolatedManagedEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-dirty",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const dirtyThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: isolatedManagedEnvironment.id,
        status: "idle",
      });

      const stopPromise = harness.app.request(`/api/v1/threads/${thread.id}/stop`, {
        method: "POST",
      });
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {});
      const stopResponse = await stopPromise;
      expect(stopResponse.status).toBe(200);

      const dirtyArchivePromise = harness.app.request(
        `/api/v1/threads/${dirtyThread.id}/archive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ force: false }),
        },
      );
      const dirtyStatusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === isolatedManagedEnvironment.id,
      );
      await reportQueuedCommandSuccess(harness, dirtyStatusCommand, {
        workspaceStatus: {
          ...cleanWorkspaceStatus(),
          workingTree: {
            ...cleanWorkspaceStatus().workingTree,
            state: "dirty_uncommitted",
            changedFiles: 1,
            hasUncommittedChanges: true,
          },
        },
      });
      const dirtyArchiveResponse = await dirtyArchivePromise;
      expect(dirtyArchiveResponse.status).toBe(409);
      await expect(readJson(dirtyArchiveResponse)).resolves.toMatchObject({
        code: "archive_confirmation_required",
        message: "Archiving this thread would clean up a workspace that contains work.",
      });

      const archiveResponse = await harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });
      expect(archiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      await expect(
        waitForQueuedCommandAfter(
          harness,
          dirtyStatusCommand.row.cursor,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");

      const unarchiveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        {
          method: "POST",
        },
      );
      expect(unarchiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });


  it("stops active threads while the host is disconnected", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-stop-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/stop`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeTypeOf("number");

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.row.sessionId).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });


  it("deletes active threads while the host is disconnected and hides the tombstone immediately", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete-active-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/delete-active-offline",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      const deletedThread = getThread(harness.db, thread.id);
      expect(deletedThread?.deletedAt).toBeTypeOf("number");
      expect(deletedThread?.stopRequestedAt).toBeTypeOf("number");
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(0);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.row.sessionId).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });


  it("deletes idle threads while the host is disconnected without queueing stop", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete-idle-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        id: thread.id,
        deletedAt: expect.any(Number),
      });
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(0);
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.deleted" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });


  it("deletes idle managed threads while disconnected and defers cleanup until reconnect", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete-idle-managed-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/delete-idle-managed-offline",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        id: thread.id,
        deletedAt: expect.any(Number),
      });
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupMode: "force",
        cleanupRequestedAt: expect.any(Number),
        status: "destroying",
      });
      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.row.sessionId).toBeNull();
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.deleted" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });


  it("tombstones created threads that already have thread.start queued", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-delete-created-started",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/delete-created-started",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/delete-created-started",
      });

      const createResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Start then delete me" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(createResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createResponse));
      expect(createdThread.status).toBe("provisioning");

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start"
          && command.threadId === createdThread.id,
      );

      const deleteResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}`,
        {
          method: "DELETE",
        },
      );

      expect(deleteResponse.status).toBe(200);
      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        stopRequestedAt: expect.any(Number),
      });
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(0);

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
    } finally {
      await harness.cleanup();
    }
  });


  it("queues thread.stop before cleanup when archiving a created thread with pending start", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-archive-created-start",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/archive-created-start",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/archive-created-start",
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
      });

      const createResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Start then archive me" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(createResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createResponse));
      expect(createdThread.status).toBe("provisioning");

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start"
          && command.threadId === createdThread.id,
      );

      const archiveResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}/archive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ force: true }),
        },
      );

      expect(archiveResponse.status).toBe(200);
      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        archivedAt: expect.any(Number),
        stopRequestedAt: expect.any(Number),
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

      await expect(
        waitForQueuedCommandAfter(
          harness,
          queuedStop.row.cursor,
          ({ command }) =>
            command.type === "environment.destroy"
            && command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });


  it("archives shared managed environments without prompting or queueing cleanup", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-shared",
      });
      const archivedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${archivedThread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, archivedThread.id)?.archivedAt).toBeTypeOf("number");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.destroy" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });


  it("archives isolated managed environments while disconnected and records deferred safe cleanup", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-archive-managed-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-offline",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupMode: "safe",
        cleanupRequestedAt: expect.any(Number),
        status: "ready",
      });
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.destroy" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });


  it("archives active isolated managed environments without destroying them until stop finalization completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-archive-managed-active",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-active",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const archivePromise = harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });

      const initialStatusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, initialStatusCommand, {
        workspaceStatus: cleanWorkspaceStatus(),
      });

      const stopCommand = await waitForQueuedCommandAfter(
        harness,
        initialStatusCommand.row.cursor,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === thread.id,
      );

      const archiveResponse = await archivePromise;
      expect(archiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeTypeOf("number");
      await expect(
        waitForQueuedCommandAfter(
          harness,
          stopCommand.row.cursor,
          ({ command }) =>
            command.type === "environment.destroy" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");

      const stopResultPromise = reportQueuedCommandSuccess(harness, stopCommand, {});

      const cleanupStatusCommand = await waitForQueuedCommandAfter(
        harness,
        stopCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, cleanupStatusCommand, {
        workspaceStatus: cleanWorkspaceStatus(),
      });
      const stopResultResponse = await stopResultPromise;
      expect(stopResultResponse.status).toBe(200);

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        cleanupStatusCommand.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("preserves forced managed cleanup across active thread stop finalization", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-archive-managed-active-force",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-active-force",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const archiveResponse = await harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: true }),
      });
      expect(archiveResponse.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupMode: "force",
        cleanupRequestedAt: expect.any(Number),
        status: "ready",
      });

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === thread.id,
      );

      const stopResultPromise = reportQueuedCommandSuccess(harness, stopCommand, {});

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        stopCommand.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
      await expect(
        waitForQueuedCommandAfter(
          harness,
          stopCommand.row.cursor,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");

      const stopResultResponse = await stopResultPromise;
      expect(stopResultResponse.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });


  it("queues environment.destroy when deleting the last thread on a managed environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/delete-managed",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("records provisioning managed cleanup intent without queueing an invalid destroy", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: null,
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupMode: "force",
        cleanupRequestedAt: expect.any(Number),
        status: "provisioning",
      });

      const destroyCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.destroy"))
        .all();
      expect(destroyCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });


  it("archives non-git threads without requiring workspace status", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/non-git-thread",
        status: "ready",
        isGitRepo: false,
        defaultBranch: null,
      });
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
        title: "Non-git thread",
        titleFallback: "Non-git thread",
      });
      const commandCountBefore = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .all().length;

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ force: false }),
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      const commandCountAfter = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .all().length;
      expect(commandCountAfter).toBe(commandCountBefore);
    } finally {
      await harness.cleanup();
    }
  });
});
