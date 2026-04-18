import { eq } from "drizzle-orm";
import {
  cancelCommand,
  events,
  getEnvironment,
  getEnvironmentOperation,
  getHostOperation,
  getThread,
  getThreadOperation,
  hostDaemonCommands,
  queueCommand,
  reportCommandResult,
} from "@bb/db";
import {
  markHostOperationRecordQueued,
  upsertHostOperationRecord,
  upsertThreadOperationRecord,
} from "@bb/db/internal-lifecycle";
import { describe, expect, it } from "vitest";
import { appendClientTurnEvent } from "../../src/services/threads/thread-events.js";
import {
  advanceEnvironmentProvisioning,
  requestEnvironmentProvision,
} from "../../src/services/environments/environment-provisioning.js";
import { requestEnvironmentCleanup } from "../../src/services/environments/environment-cleanup.js";
import { buildDirectEnvironmentProvisionRequest } from "../../src/services/environments/environment-provision-request.js";
import {
  requestThreadStart,
  requestThreadStop,
} from "../../src/services/threads/thread-lifecycle.js";
import { buildEnvironmentProvisionCommand } from "../../src/services/threads/thread-create-helpers.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import {
  queueEnvironmentDestroyLifecycleCommand,
  queueEnvironmentProvisionLifecycleCommand,
} from "../helpers/lifecycle-commands.js";
import {
  createAllowOnceResolution,
  createCommandApprovalPayload,
} from "../helpers/pending-interactions.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("internal command result idempotency", () => {
  it("fails active lifecycle state when a command-result retry arrives after partial settlement", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-result-retry-after-partial-settlement",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/retry-partial-provision",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const provisionEventSequence = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Retry partial result" }],
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
        payload: JSON.stringify({
          attachedEnvironmentId: environment.id,
          branchSlug: null,
          clientRequestSequence: provisionEventSequence,
          environmentIntent: {
            type: "reuse",
            environmentId: environment.id,
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
            source: "client/turn/requested",
          },
          input: [{ type: "text", text: "Retry partial result" }],
          provisionEventSequence,
          stage: "environment-provisioning",
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
          initiator: { threadId: thread.id, eventSequence: 0 },
          workspaceProvisionType: "unmanaged",
          path: "/tmp/retry-partial-provision",
        },
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );
      const result = {
        path: "/tmp/retry-partial-provision",
        branchName: "bb/retry-partial",
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: false,
        transcript: [],
      };

      reportCommandResult(harness.db, harness.hub, {
        commandId: command.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify(result),
      });

      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "provision",
        })?.state,
      ).toBe("queued");

      const retryResponse = await reportQueuedCommandSuccess(
        harness,
        queued,
        result,
      );
      expect(retryResponse.status).toBe(200);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "provision",
        }),
      ).toMatchObject({
        failureReason: expect.stringContaining(
          "Command result reached terminal state before lifecycle side effects completed",
        ),
        state: "failed",
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("error");

      const startCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all();
      expect(startCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("fails lifecycle state when command-result side effects throw", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-result-side-effect-failure",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/side-effect-failure",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      upsertThreadOperationRecord(harness.db, {
        threadId: thread.id,
        kind: "provision",
        payload: JSON.stringify({ invalid: true }),
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: null,
          workspaceProvisionType: "unmanaged",
          path: "/tmp/side-effect-failure",
        },
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );

      const response = await reportQueuedCommandSuccess(harness, queued, {
        path: "/tmp/side-effect-failure",
        branchName: "bb/side-effect-failure",
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: false,
        transcript: [],
      });
      expect(response.status).toBe(200);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "provision",
        }),
      ).toMatchObject({
        failureReason: expect.stringContaining(
          "Server failed to apply command result side effects",
        ),
        state: "failed",
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not replay side effects when the same command result is reported twice", async () => {
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
      const provisionEventSequence = appendClientTurnEvent(harness.deps, {
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
        payload: JSON.stringify({
          attachedEnvironmentId: environment.id,
          branchSlug: null,
          clientRequestSequence: provisionEventSequence,
          environmentIntent: {
            type: "reuse",
            environmentId: environment.id,
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            permissionEscalation: null,
            source: "client/turn/requested",
          },
          input: [{ type: "text", text: "Start once" }],
          provisionEventSequence,
          stage: "environment-provisioning",
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
          initiator: { threadId: thread.id, eventSequence: 0 },
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

  it("fails unaudited settled thread.start side effects", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-settled-thread-start-retry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/settled-thread-start-retry",
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
        eventSequence: 1,
        input: [{ type: "text", text: "Start retry guard thread" }],
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        permissionEscalation: "ask",
        projectId: project.id,
        providerId: thread.providerId,
      });

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      const result = { providerThreadId: "provider-thread-settled-retry" };
      reportCommandResult(harness.db, harness.hub, {
        commandId: queuedStart.row.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify(result),
      });

      const eventsBeforeRetry = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .filter((event) => event.type === "system/thread-provisioning");
      const retryResponse = await reportQueuedCommandSuccess(
        harness,
        queuedStart,
        result,
      );
      expect(retryResponse.status).toBe(200);

      const eventsAfterRetry = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all()
        .filter((event) => event.type === "system/thread-provisioning");
      expect(eventsAfterRetry).toHaveLength(eventsBeforeRetry.length + 1);
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      expect(
        getThreadOperation(harness.db, {
          threadId: thread.id,
          kind: "start",
        }),
      ).toMatchObject({
        commandId: queuedStart.row.id,
        failureReason: expect.stringContaining(
          "Command result reached terminal state before lifecycle side effects completed",
        ),
        state: "failed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails settled environment.destroy side effects when a success retry arrives", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-settled-destroy-retry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/settled-destroy-retry",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/settled-destroy-retry",
        projectId: project.id,
        status: "destroying",
        workspaceProvisionType: "managed-worktree",
      });
      requestEnvironmentCleanup(harness.deps, {
        environmentId: environment.id,
        mode: "force",
      });
      const command = queueEnvironmentDestroyLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.destroy",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
        },
      });
      const queuedDestroy = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );
      reportCommandResult(harness.db, harness.hub, {
        commandId: command.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      const retryResponse = await reportQueuedCommandSuccess(
        harness,
        queuedDestroy,
        {},
      );
      expect(retryResponse.status).toBe(200);

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupRequestedAt: null,
        status: "ready",
      });
      expect(
        getEnvironmentOperation(harness.db, {
          environmentId: environment.id,
          kind: "destroy",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: expect.stringContaining(
          "Command result reached terminal state before lifecycle side effects completed",
        ),
        state: "failed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails settled thread.stop side effects when a success retry arrives", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-settled-stop-retry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/settled-stop-retry",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/settled-stop-retry",
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

      const retryResponse = await reportQueuedCommandSuccess(
        harness,
        queuedStop,
        {},
      );
      expect(retryResponse.status).toBe(200);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "error",
        stopRequestedAt: null,
      });
      expect(
        getThreadOperation(harness.db, {
          threadId: thread.id,
          kind: "stop",
        }),
      ).toMatchObject({
        commandId: queuedStop.row.id,
        failureReason: expect.stringContaining(
          "Command result reached terminal state before lifecycle side effects completed",
        ),
        state: "failed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("interrupts settled interactive.resolve side effects when a success retry arrives", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-settled-interaction-retry",
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
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-settled-interaction-retry",
            providerId: "codex",
            providerThreadId: "provider-thread-settled-interaction-retry",
            providerRequestId: "request-settled-interaction-retry",
            payload: createCommandApprovalPayload({
              itemId: "item-settled-interaction-retry",
              reason: "Approve command",
              command: "git push",
              cwd: "/tmp/project",
            }),
          },
          sessionId: session.id,
        });
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
        resolution: createAllowOnceResolution(),
      });
      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === registered.interaction.id,
      );
      reportCommandResult(harness.db, harness.hub, {
        commandId: queuedResolve.row.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({}),
      });

      const retryResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(retryResponse.status).toBe(200);

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: registered.interaction.id,
        }),
      ).toMatchObject({
        status: "interrupted",
        statusReason: expect.stringContaining(
          "Command result reached terminal state before lifecycle side effects completed",
        ),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails settled runtime material side effects when a success retry arrives", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-settled-runtime-retry",
        type: "ephemeral",
      });
      upsertHostOperationRecord(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
        payload: JSON.stringify({
          appliedVersion: null,
          desiredVersion: "runtime-settled-retry",
        }),
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "host.sync_runtime_material",
        payload: JSON.stringify({
          type: "host.sync_runtime_material",
          version: "runtime-settled-retry",
        }),
      });
      markHostOperationRecordQueued(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
        commandId: command.id,
      });
      const queuedSync = await waitForQueuedCommand(
        harness,
        ({ row }) => row.id === command.id,
      );
      reportCommandResult(harness.db, harness.hub, {
        commandId: command.id,
        state: "success",
        completedAt: Date.now(),
        resultPayload: JSON.stringify({
          appliedVersion: "runtime-settled-retry",
        }),
      });

      const retryResponse = await reportQueuedCommandSuccess(
        harness,
        queuedSync,
        {
          appliedVersion: "runtime-settled-retry",
        },
      );
      expect(retryResponse.status).toBe(200);

      expect(
        getHostOperation(harness.db, {
          hostId: host.id,
          kind: "sync_runtime_material",
        }),
      ).toMatchObject({
        commandId: command.id,
        failureReason: expect.stringContaining(
          "Command result reached terminal state before lifecycle side effects completed",
        ),
        state: "failed",
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
        eventSequence: 1,
        input: [{ type: "text", text: "Start stale op thread" }],
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
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
        eventSequence: 2,
        input: [{ type: "text", text: "Restart stale op thread" }],
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
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
        request: buildDirectEnvironmentProvisionRequest(
          buildEnvironmentProvisionCommand({
            environmentId: environment.id,
            hostId: host.id,
            initiator: null,
            workspaceProvisionType: "unmanaged",
            path: environment.path ?? "/tmp/stale-provision",
          }),
        ),
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
        request: buildDirectEnvironmentProvisionRequest(
          buildEnvironmentProvisionCommand({
            environmentId: environment.id,
            hostId: host.id,
            initiator: null,
            workspaceProvisionType: "unmanaged",
            path: environment.path ?? "/tmp/stale-provision",
          }),
        ),
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
          initiator: { threadId: thread.id, eventSequence: 0 },
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
