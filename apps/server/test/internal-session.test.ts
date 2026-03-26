import { eq } from "drizzle-orm";
import {
  events,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  hostDaemonSessions,
  queueCommand,
} from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { appendClientTurnEvent } from "../src/services/thread-events.js";
import {
  internalAuthHeaders,
  waitForQueuedCommandAfter,
} from "./helpers/commands.js";
import {
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

describe("internal session routes", () => {
  it("opens sessions, replaces existing ones, and returns thread high-water marks", async () => {
    const harness = await createTestAppHarness();
    try {
      const existing = seedHostSession(harness.deps, {
        id: "host-open",
        name: "Original Host",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: existing.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: existing.host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-open",
        turnId: "turn-1",
        sequence: 4,
        type: "turn/started",
        data: {},
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: existing.host.id,
          instanceId: "instance-2",
          hostName: "Reconnected Host",
          hostType: "persistent",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
        threadHighWaterMarks: {
          [thread.id]: 4,
        },
      });
      const replaced = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, existing.session.id))
        .get();
      expect(replaced?.status).toBe("closed");
      expect(replaced?.closeReason).toBe("replaced");
    } finally {
      await harness.cleanup();
    }
  });

  it("fetches pending commands, marks them fetched, and long-polls to 204", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.stop",
        payload: JSON.stringify({
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        }),
      });

      const fetchResponse = await harness.app.request(
        `/internal/session/commands?sessionId=${session.id}&afterCursor=0&limit=10`,
        {
          headers: {
            authorization: `Bearer ${harness.config.authToken}`,
          },
        },
      );
      expect(fetchResponse.status).toBe(200);
      await expect(readJson(fetchResponse)).resolves.toEqual({
        commands: [
          expect.objectContaining({
            id: command.id,
            cursor: command.cursor,
            command: {
              type: "thread.stop",
              environmentId: environment.id,
              threadId: thread.id,
            },
          }),
        ],
      });
      const fetched = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.id, command.id))
        .get();
      expect(fetched?.state).toBe("fetched");

      const timeoutResponse = await harness.app.request(
        `/internal/session/commands?sessionId=${session.id}&afterCursor=${command.cursor}&waitMs=1`,
        {
          headers: {
            authorization: `Bearer ${harness.config.authToken}`,
          },
        },
      );
      expect(timeoutResponse.status).toBe(204);
    } finally {
      await harness.cleanup();
    }
  });

  it("handles provisioning command success and failure", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-results",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });

      const successEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provision-success",
        status: "provisioning",
      });
      const successThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: successEnvironment.id,
        status: "provisioning",
      });
      appendClientTurnEvent(
        harness.deps,
        successThread.id,
        successEnvironment.id,
        "client/thread/start",
        {
          input: [{ type: "text", text: "Start when ready" }],
          execution: { source: "client/thread/start" },
          initiator: "user",
          requestMethod: "thread/start",
          source: "spawn",
        },
      );
      const successCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: successEnvironment.id,
          projectId: project.id,
          workspaceProvisionType: "unmanaged",
          path: "/tmp/provision-success",
        }),
      });

      const successResponse = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: successCommand.id,
          cursor: successCommand.cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/provision-success",
            branchName: "bb/success",
            isGitRepo: true,
            isWorktree: false,
            ranSetup: false,
          },
        }),
      });
      expect(successResponse.status).toBe(200);
      expect(getEnvironment(harness.db, successEnvironment.id)?.status).toBe("ready");
      expect(getThread(harness.db, successThread.id)?.status).toBe("active");
      const threadStartCommand = await waitForQueuedCommandAfter(
        harness,
        successCommand.cursor,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === successThread.id,
      );
      expect(threadStartCommand.command).toMatchObject({
        environmentId: successEnvironment.id,
        workspacePath: "/tmp/provision-success",
      });

      const failureEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provision-failure",
        status: "provisioning",
      });
      const failureThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: failureEnvironment.id,
        status: "provisioning",
      });
      const failureCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: failureEnvironment.id,
          projectId: project.id,
          workspaceProvisionType: "unmanaged",
          path: "/tmp/provision-failure",
        }),
      });

      const failureResponse = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: failureCommand.id,
          cursor: failureCommand.cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: false,
          errorCode: "provision_failed",
          errorMessage: "Provisioning failed",
        }),
      });
      expect(failureResponse.status).toBe(200);
      expect(getEnvironment(harness.db, failureEnvironment.id)?.status).toBe("error");
      expect(getThread(harness.db, failureThread.id)?.status).toBe("error");
      const failureEvent = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, failureThread.id))
        .all()
        .find((event) => event.type === "system/error");
      expect(failureEvent).toBeTruthy();
      expect(
        failureEvent ? JSON.parse(failureEvent.data) : null,
      ).toMatchObject({
        code: "thread_provisioning_failed",
        detail: "Provisioning failed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("reconciles errored and orphaned active threads when a session opens", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const erroredThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "error",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile",
          hostName: "Reconcile Host",
          hostType: "persistent",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [
            {
              environmentId: environment.id,
              providerThreadId: "provider-recovered",
              threadId: erroredThread.id,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, erroredThread.id)?.status).toBe("active");
      expect(getThread(harness.db, activeThread.id)?.status).toBe("idle");
    } finally {
      await harness.cleanup();
    }
  });
});
