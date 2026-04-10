import { eq } from "drizzle-orm";
import {
  cancelCommand,
  getEnvironment,
  getEnvironmentOperation,
  getThreadOperation,
  hostDaemonCommands,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { appendClientTurnEvent } from "../../src/services/threads/thread-events.js";
import {
  advanceEnvironmentProvisioning,
  requestEnvironmentProvision,
} from "../../src/services/environments/environment-provisioning.js";
import { buildDirectEnvironmentProvisionRequest } from "../../src/services/environments/environment-provision-request.js";
import {
  requestThreadStart,
} from "../../src/services/threads/thread-lifecycle.js";
import { buildEnvironmentProvisionCommand } from "../../src/services/threads/thread-create-helpers.js";
import {
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

describe("internal command result idempotency", () => {
  it("does not replay side effects when the same command result is reported twice", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-result-idempotent",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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
      appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/thread/start",
        input: [{ type: "text", text: "Start once" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          approvalPolicy: "on-request",
          questionPolicy: "allow",
          source: "client/thread/start",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
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
          sandboxMode: "danger-full-access",
          approvalPolicy: "on-request",
          questionPolicy: "allow",
          serviceTier: "default",
          source: "client/thread/start",
        },
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
          sandboxMode: "danger-full-access",
          approvalPolicy: "on-request",
          questionPolicy: "allow",
          serviceTier: "default",
          source: "client/thread/start",
        },
        projectId: project.id,
        providerId: thread.providerId,
      });

      const requeuedStart = await waitForQueuedCommandAfter(
        harness,
        originalStart.row.cursor,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );

      const response = await reportQueuedCommandSuccess(harness, originalStart, {
        providerThreadId: "provider-thread-stale",
      });
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
          command.type === "environment.provision"
          && command.environmentId === environment.id,
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
          command.type === "environment.provision"
          && command.environmentId === environment.id,
      );

      const response = await reportQueuedCommandSuccess(harness, originalProvision, {
        path: environment.path ?? "/tmp/stale-provision",
        branchName: "bb/stale",
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: false,
        transcript: [],
      });
      expect(response.status).toBe(200);

      const operation = getEnvironmentOperation(harness.db, {
        environmentId: environment.id,
        kind: "provision",
      });
      expect(operation).toMatchObject({
        commandId: requeuedProvision.row.id,
        state: "queued",
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("provisioning");
    } finally {
      await harness.cleanup();
    }
  });
});
