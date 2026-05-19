import { setImmediate as waitForImmediate } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { events, getThread, hostDaemonCommands, queueCommand } from "@bb/db";
import { turnScope } from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import { describe, expect, it } from "vitest";
import { buildManagerToolReminderText } from "../../src/services/threads/manager-tool-reminder.js";
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
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface ExpectFailedManagerNotificationArgs {
  afterCursor: number;
  childThreadId: string;
  childTitle: string;
  environmentId: string;
  environmentPath: string;
  hostId: string;
  managerProviderThreadId: string;
  managerThreadId: string;
  projectId: string;
}

interface QueueManagedTurnSubmitScenarioArgs {
  childTitle: string;
  environmentPath: string;
  hostId: string;
  managerProviderThreadId: string;
  providerThreadId: string;
  turnId: string;
}

function managerToolReminderInput() {
  return {
    type: "text",
    text: buildManagerToolReminderText("codex"),
  };
}

async function expectFailedManagerNotificationQueued(
  harness: TestAppHarness,
  args: ExpectFailedManagerNotificationArgs,
): Promise<void> {
  const managerPreferencesPath = `/tmp/bb-host-data/${args.hostId}/thread-storage/${args.managerThreadId}/PREFERENCES.md`;
  const preferencesReadCommand = await waitForQueuedCommandAfter(
    harness,
    args.afterCursor,
    ({ command }) =>
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
      command.type === "turn.submit" &&
      command.threadId === args.managerThreadId,
  );
  expect(queuedCommand.command).toMatchObject({
    environmentId: args.environmentId,
    input: [
      {
        type: "text",
        text: renderTemplate("systemMessageManagedThreadFailed", {
          threadId: args.childThreadId,
          titleSuffix: ` (${args.childTitle})`,
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
      providerId: "codex",
      providerThreadId: args.managerProviderThreadId,
      projectId: args.projectId,
      workspaceContext: {
        workspacePath: args.environmentPath,
        workspaceProvisionType: "unmanaged",
      },
    },
  });
}

async function queueManagedTurnSubmitScenario(
  harness: TestAppHarness,
  args: QueueManagedTurnSubmitScenarioArgs,
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: args.hostId,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: args.environmentPath,
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
    providerThreadId: args.managerProviderThreadId,
    inputText: "Initial manager task",
    model: "gpt-5.4",
  });
  const childThread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
    parentThreadId: managerThread.id,
    title: args.childTitle,
  });
  seedTurnStarted(harness.deps, {
    threadId: childThread.id,
    environmentId: environment.id,
    turnId: args.turnId,
    providerThreadId: args.providerThreadId,
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
          workspacePath: args.environmentPath,
          workspaceProvisionType: "unmanaged",
        },
        projectId: project.id,
        providerId: "codex",
        providerThreadId: args.providerThreadId,
        instructions: "You are a helpful assistant.",
        dynamicTools: [],
        instructionMode: "append",
      },
      target: { mode: "steer", expectedTurnId: args.turnId },
    }),
  });
  const queued = await waitForQueuedCommand(
    harness,
    ({ row }) => row.id === command.id,
  );

  return {
    childThread,
    environment,
    host,
    managerThread,
    project,
    queued,
  };
}

describe("thread command failure side effects", () => {
  it("transitions thread to error when thread.start fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-start-fail",
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

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.start",
        payload: JSON.stringify({
          type: "thread.start",
          environmentId: environment.id,
          threadId: thread.id,
          workspaceContext: {
            workspacePath: "/tmp/test",
            workspaceProvisionType: "unmanaged",
          },
          projectId: project.id,
          providerId: "codex",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "Hello" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
          },
          instructions: "You are a helpful assistant.",
          dynamicTools: [],
          instructionMode: "append",
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "invalid_request",
        errorMessage: "Unsupported service_tier: flex",
      });
      expect(response.status).toBe(200);

      const updated = getThread(harness.db, thread.id);
      expect(updated?.status).toBe("error");

      const errorEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .filter((e) => e.type === "system/error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        scopeKind: "thread",
        turnId: null,
      });
      expect(JSON.parse(errorEvents[0]!.data)).toMatchObject({
        code: "thread_command_failed",
        message: "Command thread.start failed",
        detail: "Unsupported service_tier: flex",
      });
      await waitForImmediate();
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        1,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("queues a manager follow-up turn when a managed thread.start fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-start-fail-manager-notification",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environmentPath = "/tmp/managed-thread-start-failure-environment";
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
        providerThreadId: "provider-manager-start-failure",
        inputText: "Initial manager task",
        model: "gpt-5.4",
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        parentThreadId: managerThread.id,
        title: "Turbo config audit",
      });

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.start",
        payload: JSON.stringify({
          type: "thread.start",
          environmentId: environment.id,
          threadId: childThread.id,
          workspaceContext: {
            workspacePath: "/tmp/test",
            workspaceProvisionType: "unmanaged",
          },
          projectId: project.id,
          providerId: "codex",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "Hello" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
          },
          instructions: "You are a helpful assistant.",
          dynamicTools: [],
          instructionMode: "append",
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider process crashed before turn completion",
      });
      expect(response.status).toBe(200);

      await expectFailedManagerNotificationQueued(harness, {
        afterCursor: queued.row.cursor,
        childThreadId: childThread.id,
        childTitle: "Turbo config audit",
        environmentId: environment.id,
        environmentPath,
        hostId: host.id,
        managerProviderThreadId: "provider-manager-start-failure",
        managerThreadId: managerThread.id,
        projectId: project.id,
      });
      expect(getThread(harness.db, managerThread.id)?.status).toBe("active");
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("transitions thread to error without manager notification when unmanaged turn.submit fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-turn-fail",
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
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-active",
        providerThreadId: "provider-thread-1",
      });

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "turn.submit",
        payload: JSON.stringify({
          type: "turn.submit",
          environmentId: environment.id,
          threadId: thread.id,
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
              workspacePath: "/tmp/test",
              workspaceProvisionType: "unmanaged",
            },
            projectId: project.id,
            providerId: "codex",
            providerThreadId: "provider-thread-1",
            instructions: "You are a helpful assistant.",
            dynamicTools: [],
            instructionMode: "append",
          },
          target: { mode: "steer", expectedTurnId: "turn-active" },
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider process crashed",
      });
      expect(response.status).toBe(200);

      const retryResponse = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider process crashed",
      });
      expect(retryResponse.status).toBe(200);

      const updated = getThread(harness.db, thread.id);
      expect(updated?.status).toBe("error");

      const errorEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .filter((e) => e.type === "system/error");
      expect(errorEvents).toHaveLength(1);
      const errorEvent = errorEvents[0];
      if (!errorEvent) {
        throw new Error("Expected a thread error event");
      }
      expect(errorEvent).toMatchObject({
        scopeKind: "turn",
        turnId: "turn-active",
      });
      expect(JSON.parse(errorEvent.data)).toMatchObject({
        code: "thread_command_failed",
        message: "Command turn.submit failed",
        detail: "Provider process crashed",
      });
      await waitForImmediate();
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        1,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("queues one manager follow-up turn when a managed turn.submit fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const environmentPath = "/tmp/managed-turn-failure-environment";
      const { childThread, environment, host, managerThread, project, queued } =
        await queueManagedTurnSubmitScenario(harness, {
          childTitle: "Runtime material cleanup",
          environmentPath,
          hostId: "host-turn-fail-manager-notification",
          managerProviderThreadId: "provider-manager-turn-failure",
          providerThreadId: "provider-managed-turn-failure",
          turnId: "turn-managed-failure",
        });

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider process crashed",
      });
      expect(response.status).toBe(200);

      await expectFailedManagerNotificationQueued(harness, {
        afterCursor: queued.row.cursor,
        childThreadId: childThread.id,
        childTitle: "Runtime material cleanup",
        environmentId: environment.id,
        environmentPath,
        hostId: host.id,
        managerProviderThreadId: "provider-manager-turn-failure",
        managerThreadId: managerThread.id,
        projectId: project.id,
      });

      const retryResponse = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider process crashed",
      });
      expect(retryResponse.status).toBe(200);
      await waitForImmediate();
      expect(
        listQueuedThreadCommands(harness, "turn.submit", managerThread.id),
      ).toHaveLength(1);
      expect(getThread(harness.db, managerThread.id)?.status).toBe("active");
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not duplicate manager notification or system error when a failed turn event precedes turn.submit failure", async () => {
    const harness = await createTestAppHarness();
    try {
      const environmentPath = "/tmp/managed-turn-event-command-failure";
      const turnId = "turn-managed-event-command-failure";
      const { childThread, environment, host, managerThread, project, queued } =
        await queueManagedTurnSubmitScenario(harness, {
          childTitle: "Event command duplicate guard",
          environmentPath,
          hostId: "host-turn-event-command-failure",
          managerProviderThreadId: "provider-manager-event-command-failure",
          providerThreadId: "provider-managed-event-command-failure",
          turnId,
        });

      const eventResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: queued.row.sessionId,
            events: [
              createTestDaemonEventEnvelope({
                producerEventIdValue: 1,
                event: {
                  type: "turn/completed",
                  threadId: childThread.id,
                  providerThreadId: "provider-managed-event-command-failure",
                  scope: turnScope(turnId),
                  status: "failed",
                },
              }),
            ],
          }),
        },
      );
      expect(eventResponse.status).toBe(200);

      await expectFailedManagerNotificationQueued(harness, {
        afterCursor: queued.row.cursor,
        childThreadId: childThread.id,
        childTitle: "Event command duplicate guard",
        environmentId: environment.id,
        environmentPath,
        hostId: host.id,
        managerProviderThreadId: "provider-manager-event-command-failure",
        managerThreadId: managerThread.id,
        projectId: project.id,
      });

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider reported failure after terminal event",
      });
      expect(response.status).toBe(200);
      await waitForImmediate();

      expect(
        listQueuedThreadCommands(harness, "turn.submit", managerThread.id),
      ).toHaveLength(1);
      const errorEvents = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, childThread.id),
            eq(events.type, "system/error"),
          ),
        )
        .all();
      expect(errorEvents).toHaveLength(0);
      expect(getThread(harness.db, managerThread.id)?.status).toBe("active");
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("preserves a completed turn event outcome when turn.submit later fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const environmentPath = "/tmp/managed-turn-completed-command-failure";
      const turnId = "turn-managed-completed-command-failure";
      const { childThread, environment, host, managerThread, project, queued } =
        await queueManagedTurnSubmitScenario(harness, {
          childTitle: "Completed event owns outcome",
          environmentPath,
          hostId: "host-turn-completed-command-failure",
          managerProviderThreadId: "provider-manager-completed-command-failure",
          providerThreadId: "provider-managed-completed-command-failure",
          turnId,
        });

      const eventResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: queued.row.sessionId,
            events: [
              createTestDaemonEventEnvelope({
                producerEventIdValue: 1,
                event: {
                  type: "turn/completed",
                  threadId: childThread.id,
                  providerThreadId:
                    "provider-managed-completed-command-failure",
                  scope: turnScope(turnId),
                  status: "completed",
                },
              }),
            ],
          }),
        },
      );
      expect(eventResponse.status).toBe(200);

      const managerPreferencesPath = `/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}/PREFERENCES.md`;
      const preferencesReadCommand = await waitForQueuedCommandAfter(
        harness,
        queued.row.cursor,
        ({ command }) =>
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
            text: renderTemplate("systemMessageManagedThreadComplete", {
              threadId: childThread.id,
              titleSuffix: " (Completed event owns outcome)",
            }),
          },
          managerToolReminderInput(),
        ],
        resumeContext: {
          providerId: "codex",
          providerThreadId: "provider-manager-completed-command-failure",
          projectId: project.id,
          workspaceContext: {
            workspacePath: environmentPath,
            workspaceProvisionType: "unmanaged",
          },
        },
      });

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_error",
        errorMessage: "Provider reported failure after completed event",
      });
      expect(response.status).toBe(200);
      await waitForImmediate();

      const managerTurns = listQueuedThreadCommands(
        harness,
        "turn.submit",
        managerThread.id,
      );
      expect(managerTurns).toHaveLength(1);
      const managerTurn = managerTurns[0];
      if (!managerTurn) {
        throw new Error("Expected one manager turn notification");
      }
      expect(managerTurn).toMatchObject({
        input: [
          {
            type: "text",
            text: renderTemplate("systemMessageManagedThreadComplete", {
              threadId: childThread.id,
              titleSuffix: " (Completed event owns outcome)",
            }),
          },
          managerToolReminderInput(),
        ],
      });
      const errorEvents = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, childThread.id),
            eq(events.type, "system/error"),
          ),
        )
        .all();
      expect(errorEvents).toHaveLength(0);
      expect(getThread(harness.db, managerThread.id)?.status).toBe("active");
      expect(getThread(harness.db, childThread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue a manager follow-up turn when a managed turn.submit succeeds", async () => {
    const harness = await createTestAppHarness();
    try {
      const environmentPath = "/tmp/managed-turn-success-environment";
      const { childThread, managerThread, queued } =
        await queueManagedTurnSubmitScenario(harness, {
          childTitle: "No notification expected",
          environmentPath,
          hostId: "host-turn-success-manager-no-notification",
          managerProviderThreadId: "provider-manager-turn-success",
          providerThreadId: "provider-managed-turn-success",
          turnId: "turn-managed-success",
        });

      const response = await reportQueuedCommandSuccess(harness, queued, {
        appliedAs: "steer",
      });
      expect(response.status).toBe(200);
      await waitForImmediate();

      expect(
        listQueuedThreadCommands(harness, "turn.submit", managerThread.id),
      ).toHaveLength(0);
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        1,
      );
      expect(getThread(harness.db, managerThread.id)?.status).toBe("idle");
      expect(getThread(harness.db, childThread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps thread active when a successful turn.submit result is retried", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-turn-success-retry",
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

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "turn.submit",
        payload: JSON.stringify({
          type: "turn.submit",
          environmentId: environment.id,
          threadId: thread.id,
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
              workspacePath: "/tmp/test",
              workspaceProvisionType: "unmanaged",
            },
            projectId: project.id,
            providerId: "codex",
            providerThreadId: "provider-thread-1",
            instructions: "You are a helpful assistant.",
            dynamicTools: [],
            instructionMode: "append",
          },
          target: { mode: "start" },
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandSuccess(harness, queued, {
        appliedAs: "new-turn",
      });
      expect(response.status).toBe(200);

      const retryResponse = await reportQueuedCommandSuccess(harness, queued, {
        appliedAs: "new-turn",
      });
      expect(retryResponse.status).toBe(200);

      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      const errorEvents = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .filter((e) => e.type === "system/error");
      expect(errorEvents).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not transition thread when a successful thread.start is reported", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-start-ok",
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

      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.start",
        payload: JSON.stringify({
          type: "thread.start",
          environmentId: environment.id,
          threadId: thread.id,
          workspaceContext: {
            workspacePath: "/tmp/test",
            workspaceProvisionType: "unmanaged",
          },
          projectId: project.id,
          providerId: "codex",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "Hello" }],
          options: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
          },
          instructions: "You are a helpful assistant.",
          dynamicTools: [],
          instructionMode: "append",
        }),
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      // Report success — thread.start result is empty
      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: queued.row.id,
            completedAt: Date.now(),
            type: "thread.start",
            ok: true,
            result: { providerThreadId: "provider-thread-1" },
          }),
        },
      );
      expect(response.status).toBe(200);

      const updated = getThread(harness.db, thread.id);
      expect(updated?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });
});
