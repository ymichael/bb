import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  events,
  getDraft,
  getThread,
  hostDaemonCommands,
  threads,
} from "@bb/db";
import {
  systemOperationEventDataSchema,
  threadSchema,
} from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import {
  reportQueuedCommandError,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedDraft,
  seedEnvironment,
  seedEvent,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThreadRuntimeState,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

describe("public thread manager and ownership routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
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
        content: [{ type: "text", text: "Draft content" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft",
        sequence: 2,
        type: "thread/identity",
        data: {},
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
        options: {
          model: "gpt-5",
          serviceTier: "default",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();

      // Manager creation returns immediately — thread.start is queued with
      // default preferences (skipPreferences: true on initial start).
      const managerResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/managers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Project manager",
            providerId: "codex",
            model: "gpt-5",
            reasoningLevel: "medium",
            environment: {
              type: "host",
              hostId: host.id,
            },
          }),
        },
      );
      expect(managerResponse.status).toBe(201);
      const managerThread = threadSchema.parse(await readJson(managerResponse));
      expect(managerThread.type).toBe("manager");
      if (!managerThread.environmentId) {
        throw new Error("Expected manager thread environment");
      }

      const managerStartCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === managerThread.id,
      );
      expect(managerStartCommand.command.options).toMatchObject({
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        permissionEscalation: null,
      });
      expect(managerStartCommand.command.dynamicTools).toEqual(
        [expect.objectContaining({ name: "message_user" })],
      );
      expect(managerStartCommand.command.instructions).toContain(
        "You are a manager for this project.",
      );
      expect(managerStartCommand.command.instructions).toContain(
        "(file does not exist)",
      );
      expect(managerStartCommand.command.instructions).toContain(project.name);
      expect(managerStartCommand.command.instructions).toContain(
        "Project root: `/tmp/thread-data-project`",
      );
      expect(managerStartCommand.command.instructions).toContain(
        `Thread storage: \`/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}\``,
      );
    } finally {
      await harness.cleanup();
    }
  });


  it("appends an ownership change event and queues a manager assignment message", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-ownership-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-ownership-project/worktree",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
        title: "Manager thread",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-assigned",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: null,
      });

      const responsePromise = harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          parentThreadId: managerThread.id,
        }),
      });

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file"
          && command.path === managerPreferencesPath,
      );
      const readResponse = await reportQueuedCommandError(
        harness,
        preferencesReadCommand,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(readResponse.status).toBe(200);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBe(managerThread.id);

      const storedEvent = harness.db
        .select({ type: events.type, data: events.data })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all()
        .at(-1);

      expect(storedEvent?.type).toBe("system/operation");
      const parsedData = systemOperationEventDataSchema.parse(
        storedEvent ? JSON.parse(storedEvent.data) : null,
      );
      expect(parsedData).toMatchObject({
        operation: "ownership_change",
        status: "completed",
        message: "Thread assigned to manager",
        metadata: {
          action: "assign",
          previousParentThreadId: null,
          nextParentThreadId: managerThread.id,
        },
      });

      const queuedCommand = await waitForQueuedCommandAfter(
        harness,
        preferencesReadCommand.row.cursor,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === managerThread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        environmentId: environment.id,
        input: [
          {
            type: "text",
            text: renderTemplate("systemMessageThreadOwnershipAssigned", {
              threadLabel: `${thread.id}: Test Thread`,
            }),
          },
        ],
        options: {
          model: "gpt-5.4",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          providerId: managerThread.providerId,
          providerThreadId: "provider-manager-assigned",
          projectId: project.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "unmanaged",
          },
        },
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("queues a manager unassignment message when ownership is cleared", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-unassignment-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-unassignment-project/worktree",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
        title: "Manager thread",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-unassigned",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: managerThread.id,
      });

      const responsePromise = harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          parentThreadId: null,
        }),
      });

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file"
          && command.path === managerPreferencesPath,
      );
      const readResponse = await reportQueuedCommandError(
        harness,
        preferencesReadCommand,
        {
          errorCode: "ENOENT",
          errorMessage: "File not found",
        },
      );
      expect(readResponse.status).toBe(200);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBeNull();

      const queuedCommand = await waitForQueuedCommandAfter(
        harness,
        preferencesReadCommand.row.cursor,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === managerThread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        environmentId: environment.id,
        input: [
          {
            type: "text",
            text: renderTemplate("systemMessageThreadOwnershipRemoved", {
              threadLabel: `${thread.id}: Test Thread`,
            }),
          },
        ],
        options: {
          model: "gpt-5.4",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
        },
        resumeContext: {
          providerId: managerThread.providerId,
          providerThreadId: "provider-manager-unassigned",
          projectId: project.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "unmanaged",
          },
        },
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("keeps ownership updates successful when manager notification queuing fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const loggerError = vi.fn();
      harness.deps.logger.error = loggerError;

      const host = seedHost(harness.deps, {
        id: "host-manager-notify-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-ownership-offline-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-ownership-offline-project/worktree",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
        title: "Offline manager",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-offline",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: null,
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          parentThreadId: managerThread.id,
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBe(managerThread.id);
      expect(
        harness.db
          .select({ id: hostDaemonCommands.id })
          .from(hostDaemonCommands)
          .all(),
      ).toEqual([]);
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          managedThreadId: thread.id,
          managerThreadId: managerThread.id,
          reason: "assigned",
        }),
        "Failed to queue manager ownership system message",
      );
    } finally {
      await harness.cleanup();
    }
  });
});
