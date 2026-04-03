import { and, eq } from "drizzle-orm";
import {
  events,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  hostDaemonSessions,
  markThreadDeleted,
  markThreadStopRequested,
  queueCommand,
} from "@bb/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandSchema,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { appendClientTurnEvent } from "../src/services/thread-events.js";
import {
  internalAuthHeaders,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
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
          dataDir: "/tmp/host-open-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      const body = await readJson(response) as {
        heartbeatIntervalMs: number;
        leaseTimeoutMs: number;
        sessionId: string;
        threadHighWaterMarks: Record<string, number>;
      };
      expect(body).toMatchObject({
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
      const current = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, body.sessionId))
        .get();
      expect(current?.dataDir).toBe("/tmp/host-open-data");
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
        `/internal/session/commands?sessionId=${session.id}&limit=10&waitMs=0`,
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
        `/internal/session/commands?sessionId=${session.id}&limit=100&waitMs=1`,
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
      const successCompletedAt = 1_700_000_000_000;
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
      appendClientTurnEvent(harness.deps, {
        threadId: successThread.id,
        environmentId: successEnvironment.id,
        type: "client/thread/start",
        input: [{ type: "text", text: "Start when ready" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/thread/start",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      const successCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: successEnvironment.id,
          initiator: { threadId: successThread.id, eventSequence: 0 },
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
          completedAt: successCompletedAt,
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/provision-success",
            branchName: "bb/success",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: false,
            transcript: [],
          },
        }),
      });
      expect(successResponse.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, successCommand.id))
          .get()?.completedAt,
      ).toBe(successCompletedAt);
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
        workspaceContext: { workspacePath: "/tmp/provision-success", workspaceProvisionType: "unmanaged" },
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
          initiator: { threadId: failureThread.id, eventSequence: 0 },
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

  it("gives the initiator thread the daemon transcript when non-empty", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-transcript",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/transcript-test",
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
        input: [{ type: "text", text: "Start" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/thread/start",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: environment.id,
          initiator: { threadId: thread.id, eventSequence: 0 },
          workspaceProvisionType: "managed-worktree",
          targetPath: "/tmp/transcript-test",
          sourcePath: "/tmp/transcript-source",
          branchName: "bb/transcript",
          setupScript: ".bb-env-setup.sh",
          setupTimeoutMs: 900000,
        }),
      });

      const transcriptEntries = [
        { type: "step", key: "cwd", text: "cwd: /tmp/transcript-source", status: "completed" },
        { type: "step", key: "git-worktree", text: "git worktree add -B bb/transcript /tmp/transcript-test", status: "completed" },
        { type: "step", key: "cwd", text: "cwd: /tmp/transcript-test", status: "completed" },
        { type: "step", key: "branch", text: "Branch: bb/transcript (abc1234)", status: "completed" },
      ];
      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: command.id,
          cursor: command.cursor,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/transcript-test",
            branchName: "bb/transcript",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: true,
            transcript: transcriptEntries,
          },
        }),
      });
      expect(response.status).toBe(200);

      const completedEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(and(eq(events.threadId, thread.id), eq(events.type, "system/provisioning")))
        .all()
        .map((row) => JSON.parse(row.data))
        .filter((d: { status: string }) => d.status === "completed");
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0].entries).toEqual(transcriptEntries);
    } finally {
      await harness.cleanup();
    }
  });

  it("restarts reprovisioned threads with thread.start instead of turn.run", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-reprovision-start",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-start",
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-old",
        sequence: 1,
        type: "thread/identity",
        data: {},
      });
      appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Resume after reprovision" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "turn/start",
        source: "tell",
      });
      const provisionCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: environment.id,
          initiator: { threadId: thread.id, eventSequence: 0 },
          workspaceProvisionType: "managed-worktree",
          targetPath: "/tmp/reprovision-start",
          sourcePath: "/tmp/reprovision-source",
          branchName: "bb/reprovision-start",
          setupScript: ".bb-env-setup.sh",
          setupTimeoutMs: 900000,
        }),
      });

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: provisionCommand.id,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/reprovision-start",
            branchName: "bb/reprovision-start",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: true,
            transcript: [],
          },
        }),
      });

      expect(response.status).toBe(200);
      const queuedRestart = await waitForQueuedCommandAfter(
        harness,
        provisionCommand.cursor,
        ({ command }) => command.threadId === thread.id,
      );
      expect(queuedRestart.command.type).toBe("thread.start");
      const followupCommands = harness.db
        .select({
          cursor: hostDaemonCommands.cursor,
          payload: hostDaemonCommands.payload,
        })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.hostId, host.id))
        .all()
        .filter((row) => row.cursor > provisionCommand.cursor)
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)));
      expect(followupCommands).toEqual([
        expect.objectContaining({
          type: "thread.start",
          threadId: thread.id,
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("fails reprovision restart loudly when the latest stored request event is malformed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-reprovision-malformed",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-malformed",
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Valid earlier request" }],
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Malformed latest request" }],
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      const provisionCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: environment.id,
          initiator: { threadId: thread.id, eventSequence: 0 },
          workspaceProvisionType: "managed-worktree",
          targetPath: "/tmp/reprovision-malformed",
          sourcePath: "/tmp/reprovision-malformed-source",
          branchName: "bb/reprovision-malformed",
          setupScript: ".bb-env-setup.sh",
          setupTimeoutMs: 900000,
        }),
      });

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: provisionCommand.id,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/reprovision-malformed",
            branchName: "bb/reprovision-malformed",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: true,
            transcript: [],
          },
        }),
      });

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining(`thread ${thread.id}`),
      });
      const followupCommands = harness.db
        .select({
          cursor: hostDaemonCommands.cursor,
          payload: hostDaemonCommands.payload,
        })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.hostId, host.id))
        .all()
        .filter((row) => row.cursor > provisionCommand.cursor)
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)));
      expect(followupCommands).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("only restarts threads that are still provisioning when reprovision completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-reprovision-filter",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-filter",
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const provisioningThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const idleSibling = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      appendClientTurnEvent(harness.deps, {
        threadId: provisioningThread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Resume provisioning thread" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "turn/start",
        source: "tell",
      });
      appendClientTurnEvent(harness.deps, {
        threadId: idleSibling.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Do not restart this sibling" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "turn/start",
        source: "tell",
      });
      const provisionCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.provision",
        payload: JSON.stringify({
          type: "environment.provision",
          environmentId: environment.id,
          initiator: { threadId: provisioningThread.id, eventSequence: 0 },
          workspaceProvisionType: "managed-worktree",
          targetPath: "/tmp/reprovision-filter",
          sourcePath: "/tmp/reprovision-filter-source",
          branchName: "bb/reprovision-filter",
          setupScript: ".bb-env-setup.sh",
          setupTimeoutMs: 900000,
        }),
      });

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: provisionCommand.id,
          completedAt: Date.now(),
          type: "environment.provision",
          ok: true,
          result: {
            path: "/tmp/reprovision-filter",
            branchName: "bb/reprovision-filter",
            defaultBranch: "main",
            isGitRepo: true,
            isWorktree: true,
            transcript: [
              { type: "step", key: "cwd-source", text: "cwd: /tmp/reprovision-filter-source", status: "completed" },
              { type: "step", key: "git-worktree", text: "git worktree add -B bb/reprovision-filter /tmp/reprovision-filter", status: "completed" },
              { type: "step", key: "cwd-target", text: "cwd: /tmp/reprovision-filter", status: "completed" },
              { type: "step", key: "branch", text: "Branch: bb/reprovision-filter (abc1234)", status: "completed" },
            ],
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, provisioningThread.id)?.status).toBe("active");
      expect(getThread(harness.db, idleSibling.id)?.status).toBe("idle");

      // Initiator gets the full daemon transcript
      const initiatorEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(and(eq(events.threadId, provisioningThread.id), eq(events.type, "system/provisioning")))
        .all()
        .map((row) => JSON.parse(row.data))
        .filter((d: { status: string }) => d.status === "completed");
      expect(initiatorEvents).toHaveLength(1);
      expect(initiatorEvents[0].entries).toHaveLength(4);
      expect(initiatorEvents[0].entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "git-worktree" }),
          expect.objectContaining({ key: "branch", text: "Branch: bb/reprovision-filter (abc1234)" }),
        ]),
      );
      // Sibling gets server-generated cwd/branch fallback (no git commands)
      const siblingEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(and(eq(events.threadId, idleSibling.id), eq(events.type, "system/provisioning")))
        .all()
        .map((row) => JSON.parse(row.data))
        .filter((d: { status: string }) => d.status === "completed");
      expect(siblingEvents).toHaveLength(1);
      expect(siblingEvents[0].entries).toHaveLength(2);
      expect(siblingEvents[0].entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "cwd", text: "cwd: /tmp/reprovision-filter" }),
          expect.objectContaining({ key: "branch", text: "Branch: bb/reprovision-filter" }),
        ]),
      );

      const queuedStarts = harness.db
        .select({ cursor: hostDaemonCommands.cursor, payload: hostDaemonCommands.payload })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all()
        .filter((row) => row.cursor > provisionCommand.cursor)
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)))
        .filter((command) => command.type === "thread.start");

      expect(queuedStarts).toHaveLength(1);
      expect(queuedStarts[0]?.threadId).toBe(provisioningThread.id);
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
          dataDir: "/tmp/host-reconcile-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [
            {
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

  it("hard-deletes deleted tombstones and queues cleanup when reconciliation sees the thread is gone", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-deleted",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/reconcile-deleted",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile-deleted",
          hostName: "Reconcile Deleted Host",
          hostType: "persistent",
          dataDir: "/tmp/reconcile-deleted",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.row.sessionId).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("re-queues stop for stop-pending threads that are still active on reconnect", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-stop-pending",
      });
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
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: thread.id,
        requestedAt: 123,
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile-stop-pending",
          hostName: "Reconcile Stop Pending Host",
          hostType: "persistent",
          dataDir: "/tmp/reconcile-stop-pending",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
        }),
      });

      expect(response.status).toBe(201);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("requests stop for deleted tombstones that are still active on reconnect", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-deleted-active",
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
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile-deleted-active",
          hostName: "Reconcile Deleted Active Host",
          hostType: "persistent",
          dataDir: "/tmp/reconcile-deleted-active",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, thread.id)?.deletedAt).toBeTypeOf("number");
      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeTypeOf("number");

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("hard-deletes deleted stop-pending threads and queues cleanup on successful stop results", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stop-finalize-delete",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/stop-finalize-delete",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: thread.id,
        requestedAt: 123,
      });
      const stopCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.stop",
        payload: JSON.stringify({
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        }),
      });

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: stopCommand.id,
          completedAt: Date.now(),
          type: "thread.stop",
          ok: true,
          result: {},
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.row.cursor).toBeGreaterThan(stopCommand.cursor);
    } finally {
      await harness.cleanup();
    }
  });

  it("marks environments destroyed after a successful destroy result", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-destroy-result",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/destroy-result-environment",
        managed: true,
        status: "destroying",
      });
      const destroyCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.destroy",
        payload: JSON.stringify({
          type: "environment.destroy",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "managed-worktree",
          },
        }),
      });

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: destroyCommand.id,
          completedAt: Date.now(),
          type: "environment.destroy",
          ok: true,
          result: {},
        }),
      });

      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroyed");
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores stale destroy results after reprovision has already started", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stale-destroy",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stale-destroy",
        managed: true,
        status: "provisioning",
      });
      const destroyCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.destroy",
        payload: JSON.stringify({
          type: "environment.destroy",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "managed-worktree",
          },
        }),
      });

      const response = await harness.app.request("/internal/session/command-result", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          commandId: destroyCommand.id,
          completedAt: Date.now(),
          type: "environment.destroy",
          ok: true,
          result: {},
        }),
      });

      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("provisioning");
    } finally {
      await harness.cleanup();
    }
  });
});
