import { closeSession, getThread, listEvents } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { threadScope, turnScope } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleDanglingBackgroundTasks } from "../../src/services/threads/background-task-reconciliation.js";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import {
  DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
  DAEMON_DISCONNECT_GRACE_MS,
} from "../../src/constants.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function backgroundTaskItemData(args: {
  itemId: string;
  taskStatus: string;
  status: string;
}): Record<string, unknown> {
  return {
    providerThreadId: "claude-session-1",
    item: {
      id: args.itemId,
      type: "backgroundTask",
      taskType: "local_workflow",
      description: "fixture workflow",
      status: args.status,
      taskStatus: args.taskStatus,
      skipTranscript: false,
      workflowName: "fixture-mini",
      usage: { totalTokens: 100, toolUses: 2, durationMs: 1500 },
    },
  };
}

interface SeedOpenBackgroundTaskArgs {
  itemId?: string;
  taskStatus?: string;
  status?: string;
}

function seedOpenBackgroundTaskThread(
  harness: TestAppHarness,
  args: SeedOpenBackgroundTaskArgs = {},
) {
  const fixture = seedThreadFixture(harness, {});
  const itemId = args.itemId ?? "task:wf-1";
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    sequence: 1,
    type: "turn/started",
    scope: turnScope("turn-1"),
    providerThreadId: "claude-session-1",
    data: { providerThreadId: "claude-session-1" },
  });
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    sequence: 2,
    type: "item/started",
    scope: turnScope("turn-1"),
    providerThreadId: "claude-session-1",
    itemId,
    itemKind: "backgroundTask",
    data: backgroundTaskItemData({
      itemId,
      status: "pending",
      taskStatus: "running",
    }),
  });
  seedStoredEvent(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    sequence: 3,
    type: "item/backgroundTask/progress",
    scope: threadScope(),
    providerThreadId: "claude-session-1",
    itemId,
    itemKind: "backgroundTask",
    data: backgroundTaskItemData({
      itemId,
      status: args.status ?? "pending",
      taskStatus: args.taskStatus ?? "running",
    }),
  });
  return { ...fixture, itemId };
}

function seedActiveTurnThread(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, {
    thread: { status: "active" },
  });
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    threadId: fixture.thread.id,
    turnId: "turn-live-1",
  });
  return fixture;
}

function listSettledBackgroundTaskItems(
  harness: TestAppHarness,
  threadId: string,
): Array<{ status: string; taskStatus: string }> {
  return listEvents(harness.deps.db, { threadId })
    .filter((row) => row.type === "item/backgroundTask/completed")
    .map((row) => {
      const { item } = JSON.parse(row.data) as {
        item: { status: string; taskStatus: string };
      };
      return { status: item.status, taskStatus: item.taskStatus };
    });
}

describe("settleDanglingBackgroundTasks", () => {
  it("settles open backgroundTask items as interrupted and is idempotent", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
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

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        providerThreadId: "claude-session-1",
        data: { providerThreadId: "claude-session-1" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope("turn-1"),
        providerThreadId: "claude-session-1",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-1",
          status: "pending",
          taskStatus: "running",
        }),
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 3,
        type: "item/backgroundTask/progress",
        scope: threadScope(),
        providerThreadId: "claude-session-1",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-1",
          status: "pending",
          taskStatus: "running",
        }),
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      const rows = listEvents(harness.deps.db, { threadId: thread.id });
      const completed = rows.filter(
        (row) => row.type === "item/backgroundTask/completed",
      );
      expect(completed).toHaveLength(1);
      const data = JSON.parse(completed[0]!.data) as {
        item: { status: string; taskStatus: string; workflowName: string };
      };
      expect(data.item.status).toBe("interrupted");
      expect(data.item.taskStatus).toBe("stopped");
      expect(data.item.workflowName).toBe("fixture-mini");

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });
      expect(
        listEvents(harness.deps.db, { threadId: thread.id }).filter(
          (row) => row.type === "item/backgroundTask/completed",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not touch already-settled tasks or other hosts", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const otherHost = seedHost(harness.deps, {
        id: "host_other",
        name: "Other Host",
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

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        data: { providerThreadId: "claude-session-1" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope("turn-1"),
        itemId: "task:wf-done",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-done",
          status: "pending",
          taskStatus: "running",
        }),
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 3,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        itemId: "task:wf-done",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-done",
          status: "completed",
          taskStatus: "completed",
        }),
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: otherHost.id });
      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      const completed = listEvents(harness.deps.db, {
        threadId: thread.id,
      }).filter((row) => row.type === "item/backgroundTask/completed");
      expect(completed).toHaveLength(1);
      const data = JSON.parse(completed[0]!.data) as {
        item: { status: string };
      };
      expect(data.item.status).toBe("completed");
    });
  });

  it("preserves an already-finished task status instead of stomping it to interrupted", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedOpenBackgroundTaskThread(harness, {
        status: "completed",
        taskStatus: "completed",
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "completed", taskStatus: "completed" },
      ]);
    });
  });
});

describe("background-task lifecycle reconciliation triggers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles open tasks when a restarted daemon re-registers after its previous session already closed", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: host.type,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hostType: host.type,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-restart",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it("does not settle tasks when the same daemon instance reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: host.type,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hostType: host.type,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
    });
  });

  it("does not tell a live daemon to shut down when that same instance reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);
      const previousSocket = createMockHubSocket();
      harness.deps.hub.registerDaemon(session.id, host.id, previousSocket);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: host.type,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          hostType: host.type,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-live-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(previousSocket.messages).toEqual([]);
      expect(previousSocket.closed).toEqual([
        { code: 1000, reason: "replaced" },
      ]);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
    });
  });

  it("still tells a superseded daemon instance to shut down", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);
      const previousSocket = createMockHubSocket();
      harness.deps.hub.registerDaemon(session.id, host.id, previousSocket);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: host.type,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hostType: host.type,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-live-restarted",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(previousSocket.messages).toEqual([
        JSON.stringify({ type: "session-close", reason: "replaced" }),
      ]);
      expect(previousSocket.closed).toEqual([
        { code: 1000, reason: "replaced" },
      ]);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it("settles open tasks after the disconnect grace elapses without a reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedOpenBackgroundTaskThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);

      vi.advanceTimersByTime(DAEMON_DISCONNECT_GRACE_MS + 1);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });
});

describe("active thread disconnect reconciliation triggers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not interrupt active turns when the same daemon instance reconnects with the thread active", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);

      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: host.type,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hostType: host.type,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-active-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type !== "turn/started")
          .map((row) => row.type),
      ).toEqual([]);
    });
  });

  it("records a confirmed daemon restart when a different daemon instance registers", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);

      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: host.type,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hostType: host.type,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-active-restarted-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
      const rows = listEvents(harness.deps.db, { threadId: thread.id }).filter(
        (row) => row.type !== "turn/started",
      );
      expect(rows.map((row) => row.type)).toEqual([
        "turn/completed",
        "system/error",
        "system/thread/interrupted",
      ]);
      expect(JSON.parse(rows[0]!.data)).toMatchObject({
        status: "interrupted",
      });
      expect(JSON.parse(rows[1]!.data)).toMatchObject({
        code: "thread_command_failed",
        message: "Thread interrupted because the host daemon disconnected",
        detail: "Please retry the thread to continue.",
      });
      expect(JSON.parse(rows[2]!.data)).toEqual({
        reason: "host-daemon-restarted",
      });
    });
  });

  it("records a lost host connection after the live event window elapses without a reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedActiveTurnThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS + 1);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type !== "turn/started")
          .map((row) => row.type),
      ).toEqual([]);

      await vi.advanceTimersByTimeAsync(
        DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - DAEMON_DISCONNECT_GRACE_MS,
      );
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type !== "turn/started")
          .map((row) => ({
            data: JSON.parse(row.data),
            type: row.type,
          })),
      ).toEqual([
        expect.objectContaining({
          type: "turn/completed",
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            code: "thread_command_failed",
            message:
              "Thread interrupted because the connection to the host was lost",
            detail: "Please retry the thread to continue.",
          }),
          type: "system/error",
        }),
        expect.objectContaining({
          data: {
            reason: "host-daemon-restarted",
            cause: "host-connection-lost",
          },
          type: "system/thread/interrupted",
        }),
      ]);
    });
  });
});
