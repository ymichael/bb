import { eq } from "drizzle-orm";
import {
  createAutomation,
  deleteAutomation,
  events,
  getDraft,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  listDrafts,
  listManagerThreadNudgesByThread,
  markThreadDeleted,
  markThreadStopRequested,
  threads,
} from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import { describe, expect, it, vi } from "vitest";
import {
  internalAuthHeaders,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import {
  createDailySchedule,
  createScheduleTrigger,
} from "../helpers/schedules.js";
import {
  seedDraft,
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThreadRuntimeState,
  seedThread,
} from "../helpers/seed.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import { queueManagerSystemMessage } from "../../src/services/threads/manager-system-messages.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("internal event side effects", () => {
  it("logs side-effect failures and continues processing the rest of the batch", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-resilience",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const renamedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const startedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const originalNotifyThread = harness.hub.notifyThread.bind(harness.hub);
      harness.hub.notifyThread = (threadId, changes) => {
        if (threadId === renamedThread.id && changes.includes("title-changed")) {
          throw new Error("title notification failed");
        }
        originalNotifyThread(threadId, changes);
      };
      const loggerError = vi.fn();
      harness.deps.logger.error = loggerError;

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: renamedThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "thread/name/updated",
                threadId: renamedThread.id,
                providerThreadId: "provider-resilience",
                threadName: "Renamed thread",
              },
            },
            {
              environmentId: environment.id,
              threadId: startedThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: startedThread.id,
                providerThreadId: "provider-resilience",
                turnId: "turn-resilience",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, startedThread.id))
          .get()?.status,
      ).toBe("active");
      expect(loggerError).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends the next queued draft when a turn completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-auto-send",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-draft-auto-send",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-auto-send",
        sequence: 1,
        type: "thread/identity",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-auto-send",
        sequence: 2,
        turnId: "turn-auto-send",
        type: "turn/started",
        data: {},
      });
      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued follow-up" }],
        model: "gpt-5",
        serviceTier: "default",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 3,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-auto-send",
                turnId: "turn-auto-send",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === thread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        input: [{ type: "text", text: "Queued follow-up" }],
        options: {
          model: "gpt-5",
          serviceTier: "default",
        },
        resumeContext: {
          providerThreadId: "provider-auto-send",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.status,
      ).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not reactivate a stop-requested thread from a late turn/started event", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-stop-requested-start",
      });
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
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: thread.id,
        requestedAt: 123,
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-stop-requested-start",
                turnId: "turn-stop-requested-start",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("continues child turn-completed side effects when manager notification queuing fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const loggerError = vi.fn();
      harness.deps.logger.error = loggerError;

      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-manager-notify-failure",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const childEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-draft-manager-notify-failure",
      });
      const managerEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-notify-failure-environment",
        status: "error",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: managerEnvironment.id,
        status: "idle",
        type: "manager",
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: childEnvironment.id,
        parentThreadId: managerThread.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: childThread.id,
        environmentId: childEnvironment.id,
        providerThreadId: "provider-manager-notify-failure",
        sequence: 1,
        type: "thread/identity",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: childThread.id,
        environmentId: childEnvironment.id,
        providerThreadId: "provider-manager-notify-failure",
        sequence: 2,
        turnId: "turn-manager-notify-failure",
        type: "turn/started",
        data: {},
      });
      const draft = seedDraft(harness.deps, {
        threadId: childThread.id,
        content: [{ type: "text", text: "Queued follow-up after failed manager notify" }],
        model: "gpt-5",
        serviceTier: "default",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: childEnvironment.id,
              threadId: childThread.id,
              sequence: 3,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-manager-notify-failure",
                turnId: "turn-manager-notify-failure",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === childThread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        input: [
          {
            type: "text",
            text: "Queued follow-up after failed manager notify",
          },
        ],
        resumeContext: {
          providerThreadId: "provider-manager-notify-failure",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
      expect(getThread(harness.db, childThread.id)?.status).toBe("active");
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          managedThreadId: childThread.id,
          managerThreadId: managerThread.id,
          turnStatus: "completed",
        }),
        "Failed to queue manager turn notification",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("queues a manager follow-up turn when a managed thread completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-manager-follow-up",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-follow-up-environment",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
        title: "Manager thread",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-follow-up",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        parentThreadId: managerThread.id,
        title: "Backend port validation cleanup",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: childThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-follow-up",
                turnId: "turn-child-follow-up",
                status: "completed",
              },
            },
          ],
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
            text: renderTemplate("systemMessageManagedThreadComplete", {
              threadId: childThread.id,
              titleSuffix: " (Backend port validation cleanup)",
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
          providerThreadId: "provider-manager-follow-up",
          projectId: project.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "unmanaged",
          },
        },
      });
      expect(getThread(harness.db, managerThread.id)?.status).toBe("active");
      expect(getThread(harness.db, childThread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("skips manager follow-up turns for deleted manager threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-deleted-manager-follow-up",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/deleted-manager-follow-up-environment",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
        title: "Deleted manager",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-deleted-manager-follow-up",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      markThreadDeleted(harness.db, harness.hub, {
        threadId: managerThread.id,
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        parentThreadId: managerThread.id,
        title: "Backend port validation cleanup",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: childThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-deleted-manager-follow-up",
                turnId: "turn-child-deleted-manager-follow-up",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .all(),
      ).toEqual([]);
      expect(getThread(harness.db, managerThread.id)?.deletedAt).toBeTypeOf("number");
      expect(getThread(harness.db, childThread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("queues a manager follow-up turn when a managed thread fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-manager-failed-follow-up",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-failed-follow-up-environment",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
        title: "Manager thread",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-failed-follow-up",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        parentThreadId: managerThread.id,
        title: "Backend port validation cleanup",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: childThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-failed-follow-up",
                turnId: "turn-child-failed-follow-up",
                status: "failed",
              },
            },
          ],
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
            text: renderTemplate("systemMessageManagedThreadFailed", {
              threadId: childThread.id,
              titleSuffix: " (Backend port validation cleanup)",
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
          providerThreadId: "provider-manager-failed-follow-up",
          projectId: project.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "unmanaged",
          },
        },
      });
      expect(getThread(harness.db, managerThread.id)?.status).toBe("active");
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("queues a manager follow-up turn when a managed thread is interrupted", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-manager-interrupted-follow-up",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-interrupted-follow-up-environment",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
        title: "Manager thread",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-interrupted-follow-up",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        parentThreadId: managerThread.id,
        title: "Backend port validation cleanup",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: childThread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-interrupted-follow-up",
                turnId: "turn-child-interrupted-follow-up",
                status: "interrupted",
              },
            },
          ],
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
            text: renderTemplate("systemMessageManagedThreadInterrupted", {
              threadId: childThread.id,
              titleSuffix: " (Backend port validation cleanup)",
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
          providerThreadId: "provider-manager-interrupted-follow-up",
          projectId: project.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "unmanaged",
          },
        },
      });
      expect(getThread(harness.db, managerThread.id)?.status).toBe("active");
      expect(getThread(harness.db, childThread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("records manager reprovision follow-ups as system-initiated turn requests", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-event-manager-reprovision-follow-up",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const managerEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        path: "/tmp/managed-thread-reprovision-manager-environment",
        status: "error",
        workspaceProvisionType: "managed-worktree",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: managerEnvironment.id,
        status: "idle",
        type: "manager",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: managerEnvironment.id,
        providerThreadId: "provider-manager-reprovision-follow-up",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const queued = await queueManagerSystemMessage(harness.deps, {
        managerThreadId: managerThread.id,
        messageText: "System follow-up during reprovision",
      });

      expect(queued).toBe(true);

      const managerTurnRequestRow = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, managerThread.id))
        .orderBy(events.sequence)
        .all()
        .findLast((row) => row.type === "client/turn/requested");

      if (!managerTurnRequestRow) {
        throw new Error("Expected manager turn request event");
      }
      const managerTurnRequest = turnRequestEventDataSchema.parse(
        JSON.parse(managerTurnRequestRow.data),
      );
      expect(managerTurnRequest).toMatchObject({
        initiator: "system",
        request: {
          method: "turn/start",
          params: {},
        },
        source: "tell",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("syncs ASYNC.md when a manager thread goes idle", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-manager-sync",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-sync-environment",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        type: "manager",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-manager-sync",
                turnId: "turn-manager-sync",
                status: "completed",
              },
            },
          ],
        }),
      });

      const asyncPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/ASYNC.md`;
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === asyncPath,
      );
      const readResponse = await reportQueuedCommandSuccess(
        harness,
        queued,
        {
          path: asyncPath,
          content: [
            "---",
            "timezone: America/Los_Angeles",
            "schedules:",
            '  - name: daily-recap',
            '    cron: "0 8 * * 1-5"',
            "---",
            "",
            "## daily-recap",
            "Summarize yesterday's work.",
          ].join("\n"),
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          sizeBytes: 111,
        },
      );
      expect(readResponse.status).toBe(200);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(
        listManagerThreadNudgesByThread(harness.db, thread.id).map((nudge) => nudge.name),
      ).toEqual(["daily-recap"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-archives completed automation threads when enabled", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-auto-archive",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        path: "/tmp/auto-archive-environment",
        workspaceProvisionType: "managed-worktree",
      });
      const automation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Auto archive",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify(
          createScheduleTrigger(createDailySchedule({ times: ["08:00"] })),
        ),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Archive me" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: true,
        nextRunAt: Date.now() + 60_000,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      harness.db.update(threads)
        .set({ automationId: automation.id })
        .where(eq(threads.id, thread.id))
        .run();

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-auto-archive",
                turnId: "turn-auto-archive",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.archivedAt,
      ).toBeTypeOf("number");
      expect(getEnvironment(harness.db, environment.id)?.cleanupRequestedAt).toBeTypeOf("number");

      deleteAutomation(harness.db, harness.hub, automation.id);
      harness.db.update(threads)
        .set({ archivedAt: null, status: "active" })
        .where(eq(threads.id, thread.id))
        .run();

      const secondResponse = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 2,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-auto-archive",
                turnId: "turn-auto-archive-2",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(secondResponse.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.archivedAt,
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("leaves completed automation threads visible when auto-archive is disabled", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-no-auto-archive",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/no-auto-archive-environment",
      });
      const automation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "No auto archive",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify(
          createScheduleTrigger(createDailySchedule({ times: ["08:00"] })),
        ),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Keep me visible" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          },
        }),
        autoArchive: false,
        nextRunAt: Date.now() + 60_000,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      harness.db.update(threads)
        .set({ automationId: automation.id })
        .where(eq(threads.id, thread.id))
        .run();

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: thread.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-no-auto-archive",
                turnId: "turn-no-auto-archive",
                status: "completed",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.archivedAt,
      ).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("does not replay turn/completed side effects for a duplicate batch", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-completed-dedupe",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-draft-dedupe",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-dedupe",
        sequence: 1,
        type: "thread/identity",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-dedupe",
        sequence: 2,
        turnId: "turn-dedupe",
        type: "turn/started",
        data: {},
      });
      seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued follow-up one" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued follow-up two" }],
        model: "gpt-5",
        serviceTier: "default",
      });

      const requestBody = JSON.stringify({
        sessionId: session.id,
        events: [
          {
            environmentId: environment.id,
            threadId: thread.id,
            sequence: 3,
            createdAt: Date.now(),
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-dedupe",
              turnId: "turn-dedupe",
              status: "completed",
            },
          },
        ],
      });

      const firstResponse = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: requestBody,
      });
      expect(firstResponse.status).toBe(200);

      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === thread.id,
      );
      expect(queuedCommand.command.type).toBe("turn.run");

      const duplicateResponse = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: requestBody,
      });
      expect(duplicateResponse.status).toBe(200);

      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .all(),
      ).toHaveLength(1);
      expect(listDrafts(harness.db, thread.id)).toHaveLength(1);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.id, thread.id))
          .get()?.status,
      ).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("applies only the newly inserted completion side effects from a mixed batch", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-completed-mixed-batch",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-draft-mixed-batch",
      });
      const threadA = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const threadB = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      for (const thread of [threadA, threadB]) {
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: `provider-${thread.id}`,
          sequence: 1,
          type: "thread/identity",
          data: {},
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: `provider-${thread.id}`,
          sequence: 2,
          turnId: `turn-${thread.id}`,
          type: "turn/started",
          data: {},
        });
      }

      seedDraft(harness.deps, {
        threadId: threadA.id,
        content: [{ type: "text", text: "Queued follow-up one" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedDraft(harness.deps, {
        threadId: threadA.id,
        content: [{ type: "text", text: "Queued follow-up two" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedDraft(harness.deps, {
        threadId: threadB.id,
        content: [{ type: "text", text: "Queued follow-up three" }],
        model: "gpt-5",
        serviceTier: "default",
      });

      const firstResponse = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: threadA.id,
              sequence: 3,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: threadA.id,
                providerThreadId: `provider-${threadA.id}`,
                turnId: `turn-${threadA.id}`,
                status: "completed",
              },
            },
          ],
        }),
      });
      expect(firstResponse.status).toBe(200);

      const firstQueuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === threadA.id,
      );

      const mixedResponse = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            {
              environmentId: environment.id,
              threadId: threadA.id,
              sequence: 3,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: threadA.id,
                providerThreadId: `provider-${threadA.id}`,
                turnId: `turn-${threadA.id}`,
                status: "completed",
              },
            },
            {
              environmentId: environment.id,
              threadId: threadB.id,
              sequence: 3,
              createdAt: Date.now(),
              event: {
                type: "turn/completed",
                threadId: threadB.id,
                providerThreadId: `provider-${threadB.id}`,
                turnId: `turn-${threadB.id}`,
                status: "completed",
              },
            },
          ],
        }),
      });
      expect(mixedResponse.status).toBe(200);

      await waitForQueuedCommandAfter(
        harness,
        firstQueuedCommand.row.cursor,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === threadB.id,
      );

      expect(listDrafts(harness.db, threadA.id)).toHaveLength(1);
      expect(listDrafts(harness.db, threadB.id)).toHaveLength(0);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .all(),
      ).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("skips manager system messages while the manager thread awaits interaction", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-event-manager-pending-interaction",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        status: "ready",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        type: "manager",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-awaiting-interaction",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const pending = harness.deps.pendingInteractions.registerPendingInteraction({
        interaction: {
          threadId: managerThread.id,
          turnId: "turn-manager-awaiting-interaction",
          providerId: "codex",
          providerThreadId: "provider-manager-awaiting-interaction",
          providerRequestId: "request-manager-awaiting-interaction",
          payload: createCommandApprovalPayload({
            itemId: "item-manager-awaiting-interaction",
            reason: "Approve command",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
        sessionId: "session-1",
      });
      if (pending.outcome === "rejected") {
        throw new Error(`Expected pending interaction registration to succeed: ${pending.reason}`);
      }
      const existingManagerTurnRequestCount = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, managerThread.id))
        .orderBy(events.sequence)
        .all()
        .filter((row) => row.type === "client/turn/requested")
        .length;
      const existingQueuedCommandCount = harness.db
        .select()
        .from(hostDaemonCommands)
        .all()
        .length;

      const queued = await queueManagerSystemMessage(harness.deps, {
        managerThreadId: managerThread.id,
        messageText: "Manager follow-up while blocked",
      });

      expect(queued).toBe(false);
      const managerTurnRequests = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, managerThread.id))
        .orderBy(events.sequence)
        .all()
        .filter((row) => row.type === "client/turn/requested");
      expect(managerTurnRequests).toHaveLength(existingManagerTurnRequestCount);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .all(),
      ).toHaveLength(existingQueuedCommandCount);
    } finally {
      await harness.cleanup();
    }
  });
});
