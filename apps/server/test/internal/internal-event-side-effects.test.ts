import { setImmediate as waitForImmediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import {
  createAutomation,
  deleteAutomation,
  events,
  getQueuedThreadMessage,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  listQueuedThreadMessages,
  listManagerThreadNudgesByThread,
  markThreadDeleted,
  markThreadStopRequested,
  queueCommand,
  threads,
  upsertThreadDynamicContextFileState,
} from "@bb/db";
import { threadScope, turnRequestEventDataSchema, turnScope } from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import { describe, expect, it, vi } from "vitest";
import {
  createTestDaemonEventEnvelope,
  internalAuthHeaders,
  listQueuedThreadCommands,
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
  seedQueuedMessage,
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThreadRuntimeState,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import { queueManagerSystemMessage } from "../../src/services/threads/manager-system-messages.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import { buildManagerToolReminderText } from "../../src/services/threads/manager-tool-reminder.js";
import { MANAGER_PREFERENCES_FILE_KEY } from "../../src/services/threads/manager-dynamic-file-delivery.js";
import { createTestAppHarness } from "../helpers/test-app.js";

function managerToolReminderInput() {
  return {
    type: "text",
    text: buildManagerToolReminderText("codex"),
  };
}

describe("internal event side effects", () => {
  it("logs side-effect failures and continues processing the rest of the batch", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-resilience",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
        if (
          threadId === renamedThread.id &&
          changes.includes("title-changed")
        ) {
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
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "thread/name/updated",
                threadId: renamedThread.id,
                providerThreadId: "provider-resilience",
                scope: threadScope(),
                threadName: "Renamed thread",
              },
            }),
            createTestDaemonEventEnvelope({
              producerEventIdValue: 2,
              event: {
                type: "turn/started",
                threadId: startedThread.id,
                providerThreadId: "provider-resilience",
                scope: turnScope("turn-resilience"),
              },
            }),
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

  it("auto-sends the next queued message when a turn completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-auto-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-auto-send",
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
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-auto-send",
        sequence: 2,
        scope: turnScope("turn-auto-send"),
        type: "turn/started",
        data: {},
      });
      const queuedMessage = seedQueuedMessage(harness.deps, {
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
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-auto-send",
                scope: turnScope("turn-auto-send"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
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
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
      ).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("responds before manager queued-message auto-send waits on preferences", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-manager-queued-message-auto-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/manager-queued-message-auto-send",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        type: "manager",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-manager-queued-message-auto-send",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued manager follow-up" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-manager-queued-message-auto-send",
        providerThreadId: "provider-manager-queued-message-auto-send",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-manager-queued-message-auto-send",
                scope: turnScope("turn-manager-queued-message-auto-send"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "host.read_file" &&
          command.path === managerPreferencesPath,
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

      const queuedCommand = await waitForQueuedCommandAfter(
        harness,
        preferencesReadCommand.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        input: [
          { type: "text", text: "Queued manager follow-up" },
          managerToolReminderInput(),
        ],
        options: {
          model: "gpt-5",
          serviceTier: "default",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends the next queued message even when a pending interaction exists", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-auto-send-pending-interaction",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-auto-send-pending-interaction",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-auto-send-pending-interaction",
        sequence: 1,
        type: "thread/identity",
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-auto-send-pending-interaction",
        sequence: 2,
        scope: turnScope("turn-auto-send-pending-interaction"),
        type: "turn/started",
        data: {},
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [
          { type: "text", text: "Queued follow-up with pending interaction" },
        ],
        model: "gpt-5",
        serviceTier: "default",
      });
      const pending =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-auto-send-pending-interaction",
            providerId: "codex",
            providerThreadId: "provider-auto-send-pending-interaction",
            providerRequestId: "request-auto-send-pending-interaction",
            payload: createCommandApprovalPayload({
              itemId: "item-auto-send-pending-interaction",
              reason: "Approve queued follow-up",
              command: "git push",
              cwd: "/tmp/project",
            }),
          },
          sessionId: session.id,
        });
      if (pending.outcome === "rejected") {
        throw new Error(
          `Expected pending interaction registration to succeed: ${pending.reason}`,
        );
      }

      await expect(
        sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: thread.id,
        }),
      ).resolves.toBe(true);
      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        input: [
          { type: "text", text: "Queued follow-up with pending interaction" },
        ],
      });
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-stop-requested-start",
                scope: turnScope("turn-stop-requested-start"),
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("marks a thread errored when a provider process exit error is reported", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provider-process-exit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                code: "provider_process_exited",
                message: 'Provider "codex" exited unexpectedly with code 1',
                detail: "stderr:\nUsage limit reached. Please upgrade.",
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not error a stop-requested thread from provider process exit failure events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provider-process-exit-stop-requested",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: thread.id,
        requestedAt: 123,
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-process-exit-stop-requested",
        turnId: "turn-provider-process-exit-stop-requested",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-process-exit-stop-requested",
                scope: turnScope("turn-provider-process-exit-stop-requested"),
                status: "failed",
                error: {
                  message: 'Provider "codex" exited unexpectedly with code 1',
                },
              },
            }),
            createTestDaemonEventEnvelope({
              producerEventIdValue: 2,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: turnScope("turn-provider-process-exit-stop-requested"),
                code: "provider_process_exited",
                message: 'Provider "codex" exited unexpectedly with code 1',
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      const latestThread = getThread(harness.db, thread.id);
      expect(latestThread?.status).toBe("active");
      expect(latestThread?.stopRequestedAt).toBe(123);
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const childEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-manager-notify-failure",
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
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: childThread.id,
        environmentId: childEnvironment.id,
        providerThreadId: "provider-manager-notify-failure",
        sequence: 2,
        scope: turnScope("turn-manager-notify-failure"),
        type: "turn/started",
        data: {},
      });
      const queuedMessage = seedQueuedMessage(harness.deps, {
        threadId: childThread.id,
        content: [
          {
            type: "text",
            text: "Queued follow-up after failed manager notify",
          },
        ],
        model: "gpt-5",
        serviceTier: "default",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-manager-notify-failure",
                scope: turnScope("turn-manager-notify-failure"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === childThread.id,
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
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      upsertThreadDynamicContextFileState(harness.db, {
        threadId: managerThread.id,
        fileKey: MANAGER_PREFERENCES_FILE_KEY,
        contentHash: "previous-child-completion-preferences-hash",
        contentStatus: "present",
        shownAt: Date.now() - 1,
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        parentThreadId: managerThread.id,
        title: "Backend port validation cleanup",
      });
      seedTurnStarted(harness.deps, {
        threadId: childThread.id,
        environmentId: environment.id,
        turnId: "turn-child-follow-up",
        providerThreadId: "provider-child-follow-up",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-follow-up",
                scope: turnScope("turn-child-follow-up"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "host.read_file" &&
          command.path === managerPreferencesPath,
      );
      if (preferencesReadCommand.command.type !== "host.read_file") {
        throw new Error(
          `Expected host.read_file, got ${preferencesReadCommand.command.type}`,
        );
      }
      const preferencesContent = "child completion updated prefs\n";
      const readResponse = await reportQueuedCommandSuccess(
        harness,
        {
          command: preferencesReadCommand.command,
          row: preferencesReadCommand.row,
        },
        {
          path: managerPreferencesPath,
          content: preferencesContent,
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(preferencesContent),
        },
      );
      expect(readResponse.status).toBe(200);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      const queuedCommand = await waitForQueuedCommandAfter(
        harness,
        preferencesReadCommand.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === managerThread.id,
      );
      expect(queuedCommand.command).toMatchObject({
        environmentId: environment.id,
        input: [
          {
            type: "text",
            text: expect.stringContaining(
              "PREFERENCES.md has been updated. New contents:",
            ),
            visibility: "agent-only",
          },
          {
            type: "text",
            text: renderTemplate("systemMessageManagedThreadComplete", {
              threadId: childThread.id,
              titleSuffix: " (Backend port validation cleanup)",
            }),
          },
          managerToolReminderInput(),
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
      if (queuedCommand.command.type !== "turn.submit") {
        throw new Error(
          `Expected turn.submit, got ${queuedCommand.command.type}`,
        );
      }
      expect(queuedCommand.command.input[0]).toEqual({
        type: "text",
        text: expect.stringContaining("child completion updated prefs"),
        visibility: "agent-only",
      });
      expect(queuedCommand.command.input[1]).not.toHaveProperty("visibility");
      const managerTurnRequest = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, managerThread.id))
        .orderBy(events.sequence)
        .all()
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      if (!managerTurnRequest) {
        throw new Error("Expected persisted manager turn request");
      }
      const managerTurnData = turnRequestEventDataSchema.parse(
        JSON.parse(managerTurnRequest.data),
      );
      expect(managerTurnData.input[0]).toEqual(queuedCommand.command.input[0]);
      expect(managerTurnData.input[1]).toEqual(queuedCommand.command.input[1]);
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      seedTurnStarted(harness.deps, {
        threadId: childThread.id,
        environmentId: environment.id,
        turnId: "turn-child-deleted-manager-follow-up",
        providerThreadId: "provider-child-deleted-manager-follow-up",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-deleted-manager-follow-up",
                scope: turnScope("turn-child-deleted-manager-follow-up"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(harness.db.select().from(hostDaemonCommands).all()).toEqual([]);
      expect(getThread(harness.db, managerThread.id)?.deletedAt).toBeTypeOf(
        "number",
      );
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      seedTurnStarted(harness.deps, {
        threadId: childThread.id,
        environmentId: environment.id,
        turnId: "turn-child-failed-follow-up",
        providerThreadId: "provider-child-failed-follow-up",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-failed-follow-up",
                scope: turnScope("turn-child-failed-follow-up"),
                status: "failed",
              },
            }),
          ],
        }),
      });

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "host.read_file" &&
          command.path === managerPreferencesPath,
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
          command.type === "turn.submit" &&
          command.threadId === managerThread.id,
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
          managerToolReminderInput(),
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

  it("does not duplicate manager failure notification when command-result failure precedes failed turn event", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-event-command-failure-dedupe",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environmentPath = "/tmp/event-command-failure-dedupe";
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: environmentPath,
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
        providerThreadId: "provider-manager-command-event-dedupe",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        parentThreadId: managerThread.id,
        title: "Command event duplicate guard",
      });
      const turnId = "turn-command-event-dedupe";
      seedTurnStarted(harness.deps, {
        threadId: childThread.id,
        environmentId: environment.id,
        turnId,
        providerThreadId: "provider-child-command-event-dedupe",
      });

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "turn.submit",
        payload: JSON.stringify({
          type: "turn.submit",
          environmentId: environment.id,
          threadId: childThread.id,
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "Continue" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
          },
          resumeContext: {
            workspaceContext: {
              workspacePath: environmentPath,
              workspaceProvisionType: "unmanaged",
            },
            projectId: project.id,
            providerId: "codex",
            providerThreadId: "provider-child-command-event-dedupe",
            instructions: "You are a helpful assistant.",
            dynamicTools: [],
            instructionMode: "append",
          },
          target: { mode: "steer", expectedTurnId: turnId },
        }),
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const commandFailureResponse = await reportQueuedCommandError(
        harness,
        queued,
        {
          errorCode: "provider_error",
          errorMessage: "Provider process crashed",
        },
      );
      expect(commandFailureResponse.status).toBe(200);

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommandAfter(
        harness,
        queued.row.cursor,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "host.read_file" &&
          command.path === managerPreferencesPath,
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

      const queuedManagerTurn = await waitForQueuedCommandAfter(
        harness,
        preferencesReadCommand.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === managerThread.id,
      );
      expect(queuedManagerTurn.command).toMatchObject({
        environmentId: environment.id,
        input: [
          {
            type: "text",
            text: renderTemplate("systemMessageManagedThreadFailed", {
              threadId: childThread.id,
              titleSuffix: " (Command event duplicate guard)",
            }),
          },
          managerToolReminderInput(),
        ],
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", managerThread.id),
      ).toHaveLength(1);

      const commandFailureErrorRows = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, childThread.id),
            eq(events.turnId, turnId),
            eq(events.type, "system/error"),
            sql`json_extract(${events.data}, '$.code') = 'thread_command_failed'`,
          ),
        )
        .all();
      expect(commandFailureErrorRows).toHaveLength(1);

      const eventResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            events: [
              createTestDaemonEventEnvelope({
                producerEventIdValue: 1,
                event: {
                  type: "turn/completed",
                  threadId: childThread.id,
                  providerThreadId: "provider-child-command-event-dedupe",
                  scope: turnScope(turnId),
                  status: "failed",
                },
              }),
            ],
          }),
        },
      );
      expect(eventResponse.status).toBe(200);
      await waitForImmediate();

      expect(
        listQueuedThreadCommands(harness, "turn.submit", managerThread.id),
      ).toHaveLength(1);
      expect(
        harness.db
          .select({ id: hostDaemonCommands.id })
          .from(hostDaemonCommands)
          .where(
            and(
              eq(hostDaemonCommands.type, "host.read_file"),
              sql`json_extract(${hostDaemonCommands.payload}, '$.path') = ${managerPreferencesPath}`,
            ),
          )
          .all(),
      ).toHaveLength(1);
      expect(
        harness.db
          .select({ data: events.data })
          .from(events)
          .where(
            and(
              eq(events.threadId, childThread.id),
              eq(events.turnId, turnId),
              eq(events.type, "system/error"),
              sql`json_extract(${events.data}, '$.code') = 'thread_command_failed'`,
            ),
          )
          .all(),
      ).toHaveLength(1);
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      seedTurnStarted(harness.deps, {
        threadId: childThread.id,
        environmentId: environment.id,
        turnId: "turn-child-interrupted-follow-up",
        providerThreadId: "provider-child-interrupted-follow-up",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: childThread.id,
                providerThreadId: "provider-child-interrupted-follow-up",
                scope: turnScope("turn-child-interrupted-follow-up"),
                status: "interrupted",
              },
            }),
          ],
        }),
      });

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "host.read_file" &&
          command.path === managerPreferencesPath,
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
          command.type === "turn.submit" &&
          command.threadId === managerThread.id,
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
          managerToolReminderInput(),
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      const queuedPromise = queueManagerSystemMessage(harness.deps, {
        managerThreadId: managerThread.id,
        messageText: "System follow-up during reprovision",
      });
      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "host.read_file" &&
          command.path === managerPreferencesPath,
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

      const queued = await queuedPromise;

      expect(queued).toBe(true);

      const managerTurnRequestRow = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, managerThread.id))
        .orderBy(events.sequence)
        .all()
        .slice()
        .reverse()
        .find((row) => row.type === "client/turn/requested");

      if (!managerTurnRequestRow) {
        throw new Error("Expected manager turn request event");
      }
      const managerTurnRequest = turnRequestEventDataSchema.parse(
        JSON.parse(managerTurnRequestRow.data),
      );
      expect(managerTurnRequest).toMatchObject({
        initiator: "system",
        senderThreadId: null,
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-manager-sync",
        providerThreadId: "provider-manager-sync",
      });

      const responsePromise = harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-manager-sync",
                scope: turnScope("turn-manager-sync"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      const asyncPath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}/ASYNC.md`;
      const response = await responsePromise;
      expect(response.status).toBe(200);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" && command.path === asyncPath,
      );
      const readResponse = await reportQueuedCommandSuccess(harness, queued, {
        path: asyncPath,
        content: [
          "---",
          "timezone: America/Los_Angeles",
          "schedules:",
          "  - name: daily-recap",
          '    cron: "0 8 * * 1-5"',
          "---",
          "",
          "## daily-recap",
          "Summarize yesterday's work.",
        ].join("\n"),
        contentEncoding: "utf8",
        mimeType: "text/markdown",
        sizeBytes: 111,
      });
      expect(readResponse.status).toBe(200);

      await vi.waitFor(() => {
        expect(
          listManagerThreadNudgesByThread(harness.db, thread.id).map(
            (nudge) => nudge.name,
          ),
        ).toEqual(["daily-recap"]);
      });
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      harness.db
        .update(threads)
        .set({ automationId: automation.id })
        .where(eq(threads.id, thread.id))
        .run();
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-auto-archive",
        providerThreadId: "provider-auto-archive",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-auto-archive",
                scope: turnScope("turn-auto-archive"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.archivedAt,
      ).toBeTypeOf("number");
      expect(
        getEnvironment(harness.db, environment.id)?.cleanupRequestedAt,
      ).toBeTypeOf("number");
      expect(
        listQueuedThreadCommands(harness, "thread.archive", thread.id),
      ).toEqual([
        {
          type: "thread.archive",
          environmentId: environment.id,
          threadId: thread.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
          providerId: "codex",
          providerThreadId: "provider-auto-archive",
        },
      ]);

      deleteAutomation(harness.db, harness.hub, automation.id);
      harness.db
        .update(threads)
        .set({ archivedAt: null, status: "active" })
        .where(eq(threads.id, thread.id))
        .run();
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-auto-archive-2",
        providerThreadId: "provider-auto-archive",
      });

      const secondResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            events: [
              createTestDaemonEventEnvelope({
                producerEventIdValue: 2,
                event: {
                  type: "turn/completed",
                  threadId: thread.id,
                  providerThreadId: "provider-auto-archive",
                  scope: turnScope("turn-auto-archive-2"),
                  status: "completed",
                },
              }),
            ],
          }),
        },
      );

      expect(secondResponse.status).toBe(200);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.archivedAt,
      ).toBeNull();
      expect(
        listQueuedThreadCommands(harness, "thread.archive", thread.id),
      ).toHaveLength(1);
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      harness.db
        .update(threads)
        .set({ automationId: automation.id })
        .where(eq(threads.id, thread.id))
        .run();
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-no-auto-archive",
        providerThreadId: "provider-no-auto-archive",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          events: [
            createTestDaemonEventEnvelope({
              producerEventIdValue: 1,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-no-auto-archive",
                scope: turnScope("turn-no-auto-archive"),
                status: "completed",
              },
            }),
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.archivedAt,
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-dedupe",
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
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-dedupe",
        sequence: 2,
        scope: turnScope("turn-dedupe"),
        type: "turn/started",
        data: {},
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued follow-up one" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued follow-up two" }],
        model: "gpt-5",
        serviceTier: "default",
      });

      const requestBody = JSON.stringify({
        sessionId: session.id,
        events: [
          createTestDaemonEventEnvelope({
            producerEventIdValue: 1,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-dedupe",
              scope: turnScope("turn-dedupe"),
              status: "completed",
            },
          }),
        ],
      });

      const firstResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: requestBody,
        },
      );
      expect(firstResponse.status).toBe(200);

      const queuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedCommand.command.type).toBe("turn.submit");

      const duplicateResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: requestBody,
        },
      );
      expect(duplicateResponse.status).toBe(200);

      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        1,
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      expect(
        harness.db.select().from(threads).where(eq(threads.id, thread.id)).get()
          ?.status,
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-mixed-batch",
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
          scope: threadScope(),
          data: {},
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: `provider-${thread.id}`,
          sequence: 2,
          scope: turnScope(`turn-${thread.id}`),
          type: "turn/started",
          data: {},
        });
      }

      seedQueuedMessage(harness.deps, {
        threadId: threadA.id,
        content: [{ type: "text", text: "Queued follow-up one" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedQueuedMessage(harness.deps, {
        threadId: threadA.id,
        content: [{ type: "text", text: "Queued follow-up two" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedQueuedMessage(harness.deps, {
        threadId: threadB.id,
        content: [{ type: "text", text: "Queued follow-up three" }],
        model: "gpt-5",
        serviceTier: "default",
      });

      const firstResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            events: [
              createTestDaemonEventEnvelope({
                producerEventIdValue: 1,
                event: {
                  type: "turn/completed",
                  threadId: threadA.id,
                  providerThreadId: `provider-${threadA.id}`,
                  scope: turnScope(`turn-${threadA.id}`),
                  status: "completed",
                },
              }),
            ],
          }),
        },
      );
      expect(firstResponse.status).toBe(200);

      const firstQueuedCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === threadA.id,
      );

      const mixedResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            events: [
              createTestDaemonEventEnvelope({
                producerEventIdValue: 1,
                event: {
                  type: "turn/completed",
                  threadId: threadA.id,
                  providerThreadId: `provider-${threadA.id}`,
                  scope: turnScope(`turn-${threadA.id}`),
                  status: "completed",
                },
              }),
              createTestDaemonEventEnvelope({
                producerEventIdValue: 2,
                event: {
                  type: "turn/completed",
                  threadId: threadB.id,
                  providerThreadId: `provider-${threadB.id}`,
                  scope: turnScope(`turn-${threadB.id}`),
                  status: "completed",
                },
              }),
            ],
          }),
        },
      );
      expect(mixedResponse.status).toBe(200);

      await waitForQueuedCommandAfter(
        harness,
        firstQueuedCommand.row.cursor,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === threadB.id,
      );

      expect(listQueuedThreadMessages(harness.db, threadA.id)).toHaveLength(1);
      expect(listQueuedThreadMessages(harness.db, threadB.id)).toHaveLength(0);
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        2,
      );
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
      seedTurnStarted(harness.deps, {
        threadId: managerThread.id,
        environmentId: environment.id,
        turnId: "turn-manager-awaiting-interaction",
        providerThreadId: "provider-manager-awaiting-interaction",
      });
      const pending =
        harness.deps.pendingInteractions.registerPendingInteraction({
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
        throw new Error(
          `Expected pending interaction registration to succeed: ${pending.reason}`,
        );
      }
      const existingManagerTurnRequestCount = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, managerThread.id))
        .orderBy(events.sequence)
        .all()
        .filter((row) => row.type === "client/turn/requested").length;
      const existingQueuedCommandCount = harness.db
        .select()
        .from(hostDaemonCommands)
        .all().length;

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
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        existingQueuedCommandCount,
      );
    } finally {
      await harness.cleanup();
    }
  });
});
