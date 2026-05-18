import { setImmediate as waitImmediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import {
  archiveThread,
  cancelCommand,
  events,
  fetchCommands,
  getCommand,
  getEnvironment,
  getEnvironmentOperation,
  getThread,
  getThreadOperation,
  hostDaemonCommands,
  pruneCompletedCommandPayloads,
  reportCommandResult,
  sweepExpiredCommands,
} from "@bb/db";
import { upsertThreadOperationRecord } from "@bb/db/internal-lifecycle";
import { systemThreadProvisioningEventDataSchema } from "@bb/domain";
import { makeWorkspaceMergeBase, makeWorkspaceStatus } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import { handleCommandResult } from "../../src/internal/command-results.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
} from "../../src/services/environments/environment-cleanup.js";
import { appendClientTurnEvent } from "../../src/services/threads/thread-events.js";
import {
  advanceEnvironmentProvisioning,
  requestEnvironmentProvision,
} from "../../src/services/environments/environment-provisioning.js";
import { buildDirectEnvironmentProvisionRequest } from "../../src/services/environments/environment-provision-request.js";
import {
  requestThreadStart,
  requestThreadStop,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  runManagedEnvironmentArchiveCleanupSweep,
  runThreadLifecycleSweep,
} from "../../src/services/system/periodic-sweeps.js";
import { buildEnvironmentProvisionCommand } from "../../src/services/threads/thread-create-helpers.js";
import type { QueueThreadStartCommandArgs } from "../../src/services/threads/thread-commands.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { queueEnvironmentProvisionLifecycleCommand } from "../helpers/lifecycle-commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

interface ReuseThreadProvisionOperationArgs {
  clientRequestId: string;
  environmentId: string;
  inputText: string;
  provisionEventSequence: number;
  provisioningId: string;
  titleProvided: boolean;
}

function buildReuseThreadProvisionOperation(
  args: ReuseThreadProvisionOperationArgs,
) {
  return {
    payload: JSON.stringify({
      branchSlug: null,
      clientRequestId: args.clientRequestId,
      environmentIntent: {
        type: "reuse",
        environmentId: args.environmentId,
      },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      input: [{ type: "text", text: args.inputText }],
      titleProvided: args.titleProvided,
    }),
    provisioningState: {
      environmentId: args.environmentId,
      provisionEventSequence: args.provisionEventSequence,
      provisioningId: args.provisioningId,
      stage: "environment-provisioning" as const,
      workspaceReadyEventSequence: null,
    },
  };
}

describe("internal command result idempotency", () => {
  it("does not replay side effects when the same command result is reported after terminal blobs are pruned", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-result-idempotent",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/idempotent-provision",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const provisionRequest = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Start once" }],
        target: { kind: "thread-start" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      upsertThreadOperationRecord(harness.db, {
        threadId: thread.id,
        kind: "provision",
        ...buildReuseThreadProvisionOperation({
          clientRequestId: provisionRequest.requestId,
          environmentId: environment.id,
          inputText: "Start once",
          provisionEventSequence: provisionRequest.sequence,
          provisioningId: "tpv-idempotency-2",
          titleProvided: true,
        }),
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: {
            threadId: thread.id,
            provisioningId: "tpv-idempotency-2",
          },
          workspaceProvisionType: "unmanaged",
          path: "/tmp/idempotent-provision",
        },
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const firstResponse = await reportQueuedCommandSuccess(harness, queued, {
        path: "/tmp/idempotent-provision",
        branchName: "bb/idempotent",
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: false,
        transcript: [],
      });
      expect(firstResponse.status).toBe(200);

      const threadStartCommand = await waitForQueuedCommandAfter(
        harness,
        command.cursor,
        ({ command: queuedCommand }) =>
          queuedCommand.type === "thread.start" &&
          queuedCommand.threadId === thread.id,
      );
      expect(threadStartCommand.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });

      expect(
        pruneCompletedCommandPayloads(harness.db, {
          completedBefore: Date.now() + 1,
        }),
      ).toEqual({ pruned: 1 });
      expect(getCommand(harness.db, command.id)).toMatchObject({
        payload: "{}",
        resultPayload: null,
        state: "success",
      });

      const secondResponse = await reportQueuedCommandSuccess(harness, queued, {
        path: "/tmp/idempotent-provision",
        branchName: "bb/idempotent",
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: false,
        transcript: [],
      });
      expect(secondResponse.status).toBe(200);

      const startCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all();
      expect(startCommands).toHaveLength(1);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("ready");
    } finally {
      await harness.cleanup();
    }
  });

  it("rolls back owner side effects when command result settlement fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-command-result-rollback",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/rollback-before",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: {
            threadId: thread.id,
            provisioningId: "tpv-command-result-rollback",
          },
          workspaceProvisionType: "unmanaged",
          path: "/tmp/rollback-after",
        },
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );
      const threadNotifications: string[] = [];
      const environmentNotifications: string[] = [];
      const originalNotifyThread = harness.hub.notifyThread.bind(harness.hub);
      const originalNotifyEnvironment =
        harness.hub.notifyEnvironment.bind(harness.hub);
      harness.hub.notifyThread = (threadId, changes) => {
        threadNotifications.push(`${threadId}:${changes.join(",")}`);
        originalNotifyThread(threadId, changes);
      };
      harness.hub.notifyEnvironment = (environmentId, changes) => {
        environmentNotifications.push(
          `${environmentId}:${changes.join(",")}`,
        );
        originalNotifyEnvironment(environmentId, changes);
      };

      harness.db.run(
        sql.raw(`
          CREATE TRIGGER abort_environment_provision_completion
          BEFORE UPDATE ON environment_operations
          WHEN OLD.kind = 'provision' AND NEW.state = 'completed'
          BEGIN
            SELECT RAISE(ABORT, 'abort provision completion');
          END
        `),
      );

      try {
        const response = await reportQueuedCommandSuccess(harness, queued, {
          path: "/tmp/rollback-after",
          branchName: "bb/rollback-after",
          defaultBranch: "main",
          isGitRepo: true,
          isWorktree: false,
          transcript: [],
        });
        expect(response.status).toBe(500);
      } finally {
        harness.hub.notifyThread = originalNotifyThread;
        harness.hub.notifyEnvironment = originalNotifyEnvironment;
        harness.db.run(
          sql.raw(
            "DROP TRIGGER IF EXISTS abort_environment_provision_completion",
          ),
        );
      }

      const storedCommand = getCommand(harness.db, command.id);
      expect(storedCommand?.state).toBe("pending");
      expect(storedCommand?.completedAt).toBeNull();
      expect(storedCommand?.resultPayload).toBeNull();

      const storedEnvironment = getEnvironment(harness.db, environment.id);
      expect(storedEnvironment?.status).toBe("provisioning");
      expect(storedEnvironment?.path).toBe("/tmp/rollback-before");
      expect(storedEnvironment?.branchName).toBe("bb/test");

      const provisionOperation = getEnvironmentOperation(harness.db, {
        environmentId: environment.id,
        kind: "provision",
      });
      expect(provisionOperation?.state).toBe("queued");

      const provisioningEvents = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all();
      expect(provisioningEvents).toHaveLength(0);
      expect(threadNotifications).toEqual([]);
      expect(environmentNotifications).toEqual([]);

      await expect(
        harness.hub.waitForCommandResult(command.id, 25),
      ).rejects.toThrow("Timed out waiting for command result");
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers environment provision post-commit work from the thread lifecycle sweep before scheduled dispatch runs", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-restart-window-provision-post-commit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/restart-window-provision-post-commit",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const provisionRequest = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [
          { type: "text", text: "Recover restart window provision action" },
        ],
        target: { kind: "thread-start" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      upsertThreadOperationRecord(harness.db, {
        threadId: thread.id,
        kind: "provision",
        ...buildReuseThreadProvisionOperation({
          clientRequestId: provisionRequest.requestId,
          environmentId: environment.id,
          inputText: "Recover restart window provision action",
          provisionEventSequence: provisionRequest.sequence,
          provisioningId: "tpv-restart-window-provision-post-commit",
          titleProvided: true,
        }),
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: {
            threadId: thread.id,
            provisioningId: "tpv-restart-window-provision-post-commit",
          },
          workspaceProvisionType: "unmanaged",
          path: "/tmp/restart-window-provision-post-commit",
        },
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );
      fetchCommands(harness.db, harness.hub, { hostId: host.id });

      await handleCommandResult(harness.deps, {
        sessionId: session.id,
        commandId: queued.row.id,
        completedAt: Date.now(),
        type: "environment.provision",
        ok: true,
        result: {
          path: "/tmp/restart-window-provision-post-commit",
          branchName: "bb/restart-window-provision",
          defaultBranch: "main",
          isGitRepo: true,
          isWorktree: false,
          transcript: [],
        },
      });
      const startCommandsBeforeSweep = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all();
      expect(startCommandsBeforeSweep).toHaveLength(0);

      await runThreadLifecycleSweep(harness.deps);

      const threadStartCommand = await waitForQueuedCommandAfter(
        harness,
        command.cursor,
        ({ command: queuedCommand }) =>
          queuedCommand.type === "thread.start" &&
          queuedCommand.threadId === thread.id,
      );
      expect(threadStartCommand.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });

      await waitImmediate();
      await expect(
        waitForQueuedCommandAfter(
          harness,
          threadStartCommand.row.cursor,
          ({ command: queuedCommand }) =>
            queuedCommand.type === "thread.start" &&
            queuedCommand.threadId === thread.id,
          50,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      const startCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all();
      expect(startCommands).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers thread stop cleanup post-commit work from the managed cleanup sweep before scheduled dispatch runs", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-restart-window-stop-cleanup-post-commit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        path: "/tmp/restart-window-stop-cleanup-post-commit",
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      archiveThread(harness.db, harness.hub, thread.id);
      requestThreadStop(harness.deps, {
        environmentId: environment.id,
        hostId: host.id,
        stopRequestedAt: null,
        threadId: thread.id,
      });
      requestEnvironmentCleanup(harness.deps, {
        environmentId: environment.id,
      });
      const queuedStop = await waitForQueuedCommand(
        harness,
        ({ command: queuedCommand }) =>
          queuedCommand.type === "thread.stop" &&
          queuedCommand.threadId === thread.id,
      );
      const fetchedStopCommands = fetchCommands(harness.db, harness.hub, {
        hostId: host.id,
      });
      expect(fetchedStopCommands.map((command) => command.id)).toContain(
        queuedStop.row.id,
      );
      expect(getCommand(harness.db, queuedStop.row.id)?.state).toBe("fetched");

      await handleCommandResult(harness.deps, {
        sessionId: session.id,
        commandId: queuedStop.row.id,
        completedAt: Date.now(),
        type: "thread.stop",
        ok: true,
        result: {},
      });
      expect(
        getThreadOperation(harness.db, {
          threadId: thread.id,
          kind: "stop",
        }),
      ).toMatchObject({ commandId: queuedStop.row.id, state: "completed" });

      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeNull();
      expect(getEnvironment(harness.db, environment.id)?.cleanupRequestedAt)
        .not.toBeNull();
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "destroy",
        }),
      ).toMatchObject({ state: "requested" });
      const destroyCommandsBeforeSweep = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.destroy"))
        .all();
      expect(destroyCommandsBeforeSweep).toHaveLength(0);

      const cleanupSweepPromise = runManagedEnvironmentArchiveCleanupSweep(
        harness.deps,
        advanceEnvironmentCleanup,
      );

      const statusCommand = await waitForQueuedCommandAfter(
        harness,
        queuedStop.row.cursor,
        ({ command: queuedCommand }) =>
          queuedCommand.type === "workspace.status" &&
          queuedCommand.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: makeWorkspaceStatus({
          branch: { currentBranch: "bb/thread", defaultBranch: "main" },
          mergeBase: makeWorkspaceMergeBase({ baseRef: "origin/main" }),
        }),
      });
      await cleanupSweepPromise;

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        statusCommand.row.cursor,
        ({ command: queuedCommand }) =>
          queuedCommand.type === "environment.destroy" &&
          queuedCommand.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });

      await waitImmediate();
      await expect(
        waitForQueuedCommandAfter(
          harness,
          destroyCommand.row.cursor,
          ({ command: queuedCommand }) =>
            queuedCommand.type === "environment.destroy" &&
            queuedCommand.environmentId === environment.id,
          50,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      const destroyCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.destroy"))
        .all();
      expect(destroyCommands).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("deduplicates concurrent thread.start requests during provisioning handoff", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-concurrent-thread-start-handoff",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/concurrent-thread-start-handoff",
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const provisionRequest = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Concurrent start handoff" }],
        target: { kind: "thread-start" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      upsertThreadOperationRecord(harness.db, {
        threadId: thread.id,
        kind: "provision",
        ...buildReuseThreadProvisionOperation({
          clientRequestId: provisionRequest.requestId,
          environmentId: environment.id,
          inputText: "Concurrent start handoff",
          provisionEventSequence: provisionRequest.sequence,
          provisioningId: "tpv-concurrent-start-handoff",
          titleProvided: true,
        }),
      });

      const requestArgs: Omit<
        QueueThreadStartCommandArgs,
        "input" | "requestId"
      > = {
        thread,
        environment: {
          id: environment.id,
          hostId: environment.hostId,
          path: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        managerTemplateName: null,
        permissionEscalation: "ask",
        projectId: project.id,
        providerId: thread.providerId,
      };

      await Promise.all([
        requestThreadStart(harness.deps, {
          ...requestArgs,
          requestId: provisionRequest.requestId,
          input: [{ type: "text", text: "First concurrent start" }],
        }),
        requestThreadStart(harness.deps, {
          ...requestArgs,
          requestId: "creq_23456789ac",
          input: [{ type: "text", text: "Second concurrent start" }],
        }),
      ]);

      const startCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all();
      expect(startCommands).toHaveLength(1);

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }

      const startOperation = getThreadOperation(harness.db, {
        threadId: thread.id,
        kind: "start",
      });
      expect(startOperation?.commandId).toBe(queuedStart.row.id);

      const provisionOperation = getThreadOperation(harness.db, {
        threadId: thread.id,
        kind: "provision",
      });
      expect(provisionOperation?.state).toBe("completed");

      const provisioningEvents = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all();
      const completedProvisioningEvent = provisioningEvents.find((event) => {
        const data = systemThreadProvisioningEventDataSchema.parse(
          JSON.parse(event.data),
        );
        return data.status === "completed";
      });
      expect(completedProvisioningEvent).toBeDefined();
      expect(queuedStart.command.requestId).toBe(provisionRequest.requestId);
    } finally {
      await harness.cleanup();
    }
  });

  it("rolls back provisioning completion when start operation creation fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-atomic-thread-start-handoff",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/atomic-thread-start-handoff",
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const provisionRequest = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Atomic start handoff" }],
        target: { kind: "thread-start" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      upsertThreadOperationRecord(harness.db, {
        threadId: thread.id,
        kind: "provision",
        ...buildReuseThreadProvisionOperation({
          clientRequestId: provisionRequest.requestId,
          environmentId: environment.id,
          inputText: "Atomic start handoff",
          provisionEventSequence: provisionRequest.sequence,
          provisioningId: "tpv-atomic-start-handoff",
          titleProvided: true,
        }),
      });

      harness.db.run(
        sql.raw(`
          CREATE TRIGGER abort_start_operation_insert
          BEFORE INSERT ON thread_operations
          WHEN NEW.kind = 'start'
          BEGIN
            SELECT RAISE(ABORT, 'abort start operation insert');
          END
        `),
      );

      try {
        await expect(
          requestThreadStart(harness.deps, {
            thread,
            environment: {
              id: environment.id,
              hostId: environment.hostId,
              path: environment.path,
              workspaceProvisionType: environment.workspaceProvisionType,
            },
            requestId: provisionRequest.requestId,
            input: [{ type: "text", text: "Atomic start handoff" }],
            execution: {
              model: "gpt-5",
              reasoningLevel: "medium",
              permissionMode: "full",
              serviceTier: "default",
              source: "client/turn/requested",
            },
            managerTemplateName: null,
            permissionEscalation: "ask",
            projectId: project.id,
            providerId: thread.providerId,
          }),
        ).rejects.toThrow("abort start operation insert");
      } finally {
        harness.db.run(
          sql.raw("DROP TRIGGER IF EXISTS abort_start_operation_insert"),
        );
      }

      const provisionOperation = getThreadOperation(harness.db, {
        threadId: thread.id,
        kind: "provision",
      });
      expect(provisionOperation?.state).toBe("requested");

      const startOperation = getThreadOperation(harness.db, {
        threadId: thread.id,
        kind: "start",
      });
      expect(startOperation).toBeNull();

      const completedProvisioningEvents = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .filter((event) => {
          const data = systemThreadProvisioningEventDataSchema.parse(
            JSON.parse(event.data),
          );
          return data.status === "completed";
        });
      expect(completedProvisioningEvents).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the stored error cached when a settled command retry reports success", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-settled-stop-conflict",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/settled-stop-conflict",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/settled-stop-conflict",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      requestThreadStop(harness.deps, {
        environmentId: environment.id,
        hostId: host.id,
        stopRequestedAt: null,
        threadId: thread.id,
      });
      const queuedStop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );

      reportCommandResult(harness.db, harness.hub, {
        commandId: queuedStop.row.id,
        state: "error",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({
          errorCode: "stop_failed",
          errorMessage: "Stored stop failure",
        }),
      });

      const retryResponse = await reportQueuedCommandSuccess(
        harness,
        queuedStop,
        {},
      );
      expect(retryResponse.status).toBe(200);

      await expect(
        harness.hub.waitForCommandResult(queuedStop.row.id, 1_000),
      ).resolves.toEqual({
        commandId: queuedStop.row.id,
        errorCode: "stop_failed",
        errorMessage: "Stored stop failure",
        ok: false,
        type: "thread.stop",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the canonical expired error cached when a late daemon result arrives after sweep expiry", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-expired-late-result",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/expired-late-result",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/expired-late-result",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      requestThreadStop(harness.deps, {
        environmentId: environment.id,
        hostId: host.id,
        stopRequestedAt: null,
        threadId: thread.id,
      });
      const queuedStop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      fetchCommands(harness.db, harness.hub, { hostId: host.id });
      const now = Date.now();
      harness.db
        .update(hostDaemonCommands)
        .set({ fetchedAt: now - 70_000, retryCount: 1 })
        .where(eq(hostDaemonCommands.id, queuedStop.row.id))
        .run();

      const expired = sweepExpiredCommands(harness.db, harness.hub, now);
      expect(expired.erroredCommandIds).toEqual([queuedStop.row.id]);
      expect(getCommand(harness.db, queuedStop.row.id)).toMatchObject({
        state: "error",
        resultPayload: JSON.stringify({
          errorCode: "command_expired",
          errorMessage: "Command expired after retry",
        }),
      });

      const lateResponse = await reportQueuedCommandSuccess(
        harness,
        queuedStop,
        {},
      );
      expect(lateResponse.status).toBe(200);

      await expect(
        harness.hub.waitForCommandResult(queuedStop.row.id, 1_000),
      ).resolves.toEqual({
        commandId: queuedStop.row.id,
        errorCode: "command_expired",
        errorMessage: "Command expired after retry",
        ok: false,
        type: "thread.stop",
      });
      expect(getCommand(harness.db, queuedStop.row.id)).toMatchObject({
        state: "error",
        resultPayload: JSON.stringify({
          errorCode: "command_expired",
          errorMessage: "Command expired after retry",
        }),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the stored success cached when a settled command retry reports error", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-settled-stop-conflict-inverse",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/settled-stop-conflict-inverse",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/settled-stop-conflict-inverse",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      requestThreadStop(harness.deps, {
        environmentId: environment.id,
        hostId: host.id,
        stopRequestedAt: null,
        threadId: thread.id,
      });
      const queuedStop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );

      reportCommandResult(harness.db, harness.hub, {
        commandId: queuedStop.row.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      const retryResponse = await reportQueuedCommandError(
        harness,
        queuedStop,
        {
          errorCode: "stop_failed",
          errorMessage: "Retry stop failure",
        },
      );
      expect(retryResponse.status).toBe(200);

      await expect(
        harness.hub.waitForCommandResult(queuedStop.row.id, 1_000),
      ).resolves.toEqual({
        commandId: queuedStop.row.id,
        ok: true,
        result: {},
        type: "thread.stop",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores stale thread.start successes after the active start operation is repointed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-stale-thread-start-result",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stale-thread-start",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "created",
      });

      await requestThreadStart(harness.deps, {
        thread,
        environment: {
          id: environment.id,
          hostId: environment.hostId,
          path: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
        requestId: "creq_23456789ab",
        input: [{ type: "text", text: "Start stale op thread" }],
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        managerTemplateName: null,
        permissionEscalation: "ask",
        projectId: project.id,
        providerId: thread.providerId,
      });

      const originalStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      cancelCommand(harness.db, {
        commandId: originalStart.row.id,
      });

      await requestThreadStart(harness.deps, {
        thread,
        environment: {
          id: environment.id,
          hostId: environment.hostId,
          path: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
        requestId: "creq_23456789ac",
        input: [{ type: "text", text: "Restart stale op thread" }],
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        managerTemplateName: null,
        permissionEscalation: "ask",
        projectId: project.id,
        providerId: thread.providerId,
      });

      const requeuedStart = await waitForQueuedCommandAfter(
        harness,
        originalStart.row.cursor,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );

      const response = await reportQueuedCommandSuccess(
        harness,
        originalStart,
        {
          providerThreadId: "provider-thread-stale",
        },
      );
      expect(response.status).toBe(200);

      const operation = getThreadOperation(harness.db, {
        threadId: thread.id,
        kind: "start",
      });
      expect(operation).toMatchObject({
        commandId: requeuedStart.row.id,
        state: "queued",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores stale environment.provision successes after the active operation is repointed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-stale-provision-result",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stale-provision",
        status: "provisioning",
      });

      requestEnvironmentProvision(harness.deps, {
        environmentId: environment.id,
        kind: "provision",
        request: buildDirectEnvironmentProvisionRequest({
          command: buildEnvironmentProvisionCommand({
            environmentId: environment.id,
            hostId: host.id,
            initiator: null,
            workspaceProvisionType: "unmanaged",
            path: environment.path ?? "/tmp/stale-provision",
          }),
          provisioningId: "epv-stale-provision-original",
        }),
      });
      const originalCommandId = advanceEnvironmentProvisioning(harness.deps, {
        environmentId: environment.id,
      });
      expect(originalCommandId).not.toBeNull();

      const originalProvision = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
      );
      cancelCommand(harness.db, {
        commandId: originalProvision.row.id,
      });

      requestEnvironmentProvision(harness.deps, {
        environmentId: environment.id,
        kind: "provision",
        request: buildDirectEnvironmentProvisionRequest({
          command: buildEnvironmentProvisionCommand({
            environmentId: environment.id,
            hostId: host.id,
            initiator: null,
            workspaceProvisionType: "unmanaged",
            path: environment.path ?? "/tmp/stale-provision",
          }),
          provisioningId: "epv-stale-provision-retry",
        }),
      });
      const requeuedCommandId = advanceEnvironmentProvisioning(harness.deps, {
        environmentId: environment.id,
      });
      expect(requeuedCommandId).not.toBeNull();

      const requeuedProvision = await waitForQueuedCommandAfter(
        harness,
        originalProvision.row.cursor,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
      );

      const response = await reportQueuedCommandSuccess(
        harness,
        originalProvision,
        {
          path: environment.path ?? "/tmp/stale-provision",
          branchName: "bb/stale",
          defaultBranch: "main",
          isGitRepo: true,
          isWorktree: false,
          transcript: [],
        },
      );
      expect(response.status).toBe(200);

      const operation = getEnvironmentOperation(harness.db, {
        environmentId: environment.id,
        kind: "provision",
      });
      expect(operation).toMatchObject({
        commandId: requeuedProvision.row.id,
        state: "queued",
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "provisioning",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("durably fails direct environment.provision command errors", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-direct-provision-failure",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/direct-provision-failure",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: {
            threadId: thread.id,
            provisioningId: "tpv-idempotency-3",
          },
          workspaceProvisionType: "unmanaged",
          path: "/tmp/direct-provision-failure",
        },
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandError(harness, queued, {
        errorCode: "workspace_setup_failed",
        errorMessage: "setup failed",
      });
      expect(response.status).toBe(200);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "provision",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: "setup failed",
        state: "failed",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
