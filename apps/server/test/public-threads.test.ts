import { eq } from "drizzle-orm";
import { getDraft, getEnvironment, getThread, threads } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "./helpers/commands.js";
import {
  seedDraft,
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

function cleanWorkspaceStatus() {
  return {
    state: "clean",
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    workspaceChangedFiles: 0,
    workspaceInsertions: 0,
    workspaceDeletions: 0,
    hasUncommittedChanges: false,
    hasCommittedUnmergedChanges: false,
    aheadCount: 0,
    behindCount: 0,
  };
}

describe("public thread routes", () => {
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
      const createdThread = await readJson(response) as {
        environmentId: string;
        id: string;
        status: string;
      };
      expect(createdThread.status).toBe("provisioning");

      const environment = getEnvironment(harness.db, createdThread.environmentId);
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
        projectId: project.id,
        path: source.path,
        workspaceProvisionType: "unmanaged",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("creates managed-worktree threads and queues managed provisioning", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/managed-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
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
      const createdThread = await readJson(response) as {
        environmentId: string;
        status: string;
      };
      expect(createdThread.status).toBe("provisioning");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      expect(queued.command).toMatchObject({
        projectId: project.id,
        sourcePath: source.path,
        workspaceProvisionType: "managed-worktree",
      });
      expect(queued.command).toHaveProperty("targetPath");
      expect(queued.command).toHaveProperty("branchName");
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 501 with unsupported_operation for sandbox-host thread creation", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(501);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "unsupported_operation",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("reuses an existing environment when requested", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reuse-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        environmentId: environment.id,
        status: "idle",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues turn.run for idle threads and turn.steer for active threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/send-project",
      });
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-turn",
        turnId: "turn-1",
        sequence: 1,
        type: "turn/started",
        data: {},
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${idleThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Run this task" }],
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      const runCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === idleThread.id,
      );
      expect(runCommand.command).toMatchObject({
        environmentId: environment.id,
      });
      expect(getThread(harness.db, idleThread.id)?.status).toBe("active");

      const steerResponse = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Refocus the turn" }],
          }),
        },
      );
      expect(steerResponse.status).toBe(200);
      const steerCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.steer" && command.threadId === activeThread.id,
      );
      expect(steerCommand.command).toMatchObject({
        expectedTurnId: "turn-1",
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid send mode transitions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const startOnActive = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "start",
            input: [{ type: "text", text: "Should fail" }],
          }),
        },
      );
      expect(startOnActive.status).toBe(409);
      await expect(readJson(startOnActive)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is already active",
      });

      const steerOnIdle = await harness.app.request(
        `/api/v1/threads/${idleThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Should also fail" }],
          }),
        },
      );
      expect(steerOnIdle.status).toBe(409);
      await expect(readJson(steerOnIdle)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is not active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("stops threads, archives/unarchives them, and rejects archiving dirty workspaces", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
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
      const dirtyThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
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
          body: JSON.stringify({}),
        },
      );
      const dirtyStatusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, dirtyStatusCommand, {
        workspaceStatus: {
          ...cleanWorkspaceStatus(),
          state: "dirty_uncommitted",
          changedFiles: 1,
          workspaceChangedFiles: 1,
          hasUncommittedChanges: true,
        },
      });
      const dirtyArchiveResponse = await dirtyArchivePromise;
      expect(dirtyArchiveResponse.status).toBe(409);
      await expect(readJson(dirtyArchiveResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread has uncommitted or unmerged changes",
      });

      const archivePromise = harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const cleanStatusCommand = await waitForQueuedCommandAfter(
        harness,
        dirtyStatusCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, cleanStatusCommand, {
        workspaceStatus: cleanWorkspaceStatus(),
      });
      const archiveResponse = await archivePromise;
      expect(archiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");

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
        path: "/tmp/delete-managed",
        workspaceProvisionType: "managed-worktree",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues thread.rename, returns thread events, sends drafts, and creates manager threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-data-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-data-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        title: "Old title",
        titleFallback: "Old title",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        data: { text: "Hello from the manager" },
      });

      const patchResponse = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "New title",
        }),
      });
      expect(patchResponse.status).toBe(200);
      const renameCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.rename" && command.threadId === thread.id,
      );
      expect(renameCommand.command).toMatchObject({
        title: "New title",
      });

      const eventsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      await expect(readJson(eventsResponse)).resolves.toEqual([
        expect.objectContaining({
          type: "system/manager/user_message",
        }),
      ]);

      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: JSON.stringify([{ type: "text", text: "Draft content" }]),
      });
      const draftSendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(draftSendResponse.status).toBe(200);
      const draftCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === thread.id,
      );
      expect(draftCommand.command).toMatchObject({
        environmentId: environment.id,
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();

      const managerResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/managers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Project manager",
            providerId: "codex",
          }),
        },
      );
      expect(managerResponse.status).toBe(201);
      const managerThread = await readJson(managerResponse) as {
        id: string;
        type: string;
      };
      expect(managerThread.type).toBe("manager");
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.parentThreadId, thread.id))
          .all(),
      ).toEqual([]);
      const managerProvisionCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.projectId === project.id,
      );
      expect(managerProvisionCommand.command.type).toBe("environment.provision");
    } finally {
      await harness.cleanup();
    }
  });
});
