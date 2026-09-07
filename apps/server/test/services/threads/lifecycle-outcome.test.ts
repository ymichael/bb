import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendStoredThreadEvent,
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  getThread,
  migrate,
  noopNotifier,
  openSession,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import {
  changedMessageSchema,
  formatClientTurnRequestIdSuffix,
  threadScope,
  turnScope,
  type PromptInput,
  type ThreadChangedMessage,
  type ThreadStatus,
} from "@bb/domain";
import { applyLoggedThreadLifecycleEvent } from "../../../src/services/threads/lifecycle-outcome.js";
import { NotificationHub } from "../../../src/ws/hub.js";
import { createMockHubSocket } from "../../helpers/mock-hub-socket.js";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";
import { testLogger } from "../../helpers/test-app.js";

const providerRegistry = await createTestProviderRegistry();

const NO_ACTIVITY = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeWorkflowCount: 0,
};

const planPromptInput: PromptInput[] = [
  {
    type: "text",
    text: "/plan inspect the failing command",
    mentions: [
      {
        start: 0,
        end: 5,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "user",
          label: "plan",
          argumentHint: null,
        },
      },
    ],
  },
];

function seedOpenPlanTurnWithGoal(db: DbConnection, threadId: string): void {
  const requestId = formatClientTurnRequestIdSuffix({ suffix: "23456789ab" });
  appendStoredThreadEvent(db, noopNotifier, {
    threadId,
    scope: threadScope(),
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      requestId,
      input: planPromptInput,
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "workspace-write",
        source: "client/turn/requested",
        serviceTier: "default",
      },
    },
  });
  appendStoredThreadEvent(db, noopNotifier, {
    threadId,
    scope: turnScope("turn-plan"),
    providerThreadId: "provider-plan",
    type: "turn/input/accepted",
    data: { providerThreadId: "provider-plan", clientRequestId: requestId },
  });
  appendStoredThreadEvent(db, noopNotifier, {
    threadId,
    scope: threadScope(),
    providerThreadId: "provider-plan",
    type: "thread/goal/updated",
    data: {
      providerThreadId: "provider-plan",
      objective: "Finish the sidebar activity indicator",
      status: "active",
      tokenBudget: null,
      tokensUsed: 64,
      timeUsedSeconds: 5,
    },
  });
}

interface Setup {
  db: DbConnection;
  hostId: string;
  hub: NotificationHub;
  threadId: string;
  projectId: string;
}

function setup(status: ThreadStatus): Setup {
  const db = createConnection(":memory:");
  migrate(db);
  const hub = new NotificationHub();
  const host = upsertHost(db, noopNotifier, {
    id: "host-lifecycle-outcome",
    name: "Lifecycle Outcome Host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "Lifecycle Outcome Project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/lifecycle" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    projectId: project.id,
    workspaceProvisionType: "unmanaged",
    path: "/tmp/lifecycle/env",
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status,
  });
  return {
    db,
    hostId: host.id,
    hub,
    projectId: project.id,
    threadId: thread.id,
  };
}

function connectDaemon(db: DbConnection, hub: NotificationHub, hostId: string) {
  const session = openSession(db, {
    hostId,
    instanceId: `instance-${randomUUID()}`,
    hostName: "Lifecycle Outcome Host",
    hostType: "persistent",
    dataDir: `/tmp/${hostId}`,
    protocolVersion: 1,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });
  hub.registerDaemon(session.id, hostId, { close() {}, send() {} });
}

function lastThreadListMessage(
  messages: readonly string[],
): ThreadChangedMessage {
  const last = messages.at(-1);
  if (last === undefined) {
    throw new Error("no realtime message was broadcast");
  }
  const message = changedMessageSchema.parse(JSON.parse(last));
  if (message.entity !== "thread") {
    throw new Error(`expected a thread message, got ${message.entity}`);
  }
  return message;
}

describe("applyLoggedThreadLifecycleEvent", () => {
  it("broadcasts status-changed with the post-transition row and runtime", () => {
    const { db, hostId, hub, projectId, threadId } = setup("idle");
    connectDaemon(db, hub, hostId);
    const socket = createMockHubSocket();
    hub.subscribe(socket, { kind: "thread-list" });

    const outcome = applyLoggedThreadLifecycleEvent(
      { db, hub, logger: testLogger, providerRegistry },
      { event: { type: "run.started" }, threadId },
    );

    expect(outcome.applied).toBe(true);
    const row = getThread(db, threadId);
    expect(row?.status).toBe("active");
    expect(socket.messages).toHaveLength(1);
    expect(lastThreadListMessage(socket.messages)).toEqual({
      type: "changed",
      entity: "thread",
      id: threadId,
      metadata: {
        projectId,
        statusChange: {
          status: "active",
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
          activity: NO_ACTIVITY,
          latestAttentionAt: row?.latestAttentionAt,
          updatedAt: row?.updatedAt,
        },
      },
      changes: ["status-changed"],
    });
  });

  it("reports the host-derived runtime when the thread activates without a connected daemon", () => {
    const { db, hub, threadId } = setup("idle");
    const socket = createMockHubSocket();
    hub.subscribe(socket, { kind: "thread-list" });

    applyLoggedThreadLifecycleEvent(
      { db, hub, logger: testLogger, providerRegistry },
      { event: { type: "run.started" }, threadId },
    );

    expect(
      lastThreadListMessage(socket.messages).metadata?.statusChange?.runtime
        .displayStatus,
    ).toBe("waiting-for-host");
  });

  it("carries the status-gated plan and goal activity of the post-transition row", () => {
    const { db, hostId, hub, threadId } = setup("idle");
    connectDaemon(db, hub, hostId);
    seedOpenPlanTurnWithGoal(db, threadId);
    const socket = createMockHubSocket();
    hub.subscribe(socket, { kind: "thread-list" });

    applyLoggedThreadLifecycleEvent(
      { db, hub, logger: testLogger, providerRegistry },
      { event: { type: "run.started" }, threadId },
    );
    expect(
      lastThreadListMessage(socket.messages).metadata?.statusChange?.activity,
    ).toEqual({ ...NO_ACTIVITY, activeGoalCount: 1, activePlanModeCount: 1 });

    applyLoggedThreadLifecycleEvent(
      { db, hub, logger: testLogger, providerRegistry },
      { event: { type: "run.succeeded" }, threadId },
    );
    expect(
      lastThreadListMessage(socket.messages).metadata?.statusChange,
    ).toMatchObject({
      status: "idle",
      activity: { ...NO_ACTIVITY, activeGoalCount: 1, activePlanModeCount: 0 },
    });
  });

  it("does not broadcast when the event is not applied", () => {
    const { db, hub, threadId } = setup("idle");
    const socket = createMockHubSocket();
    hub.subscribe(socket, { kind: "thread-list" });

    const outcome = applyLoggedThreadLifecycleEvent(
      { db, hub, logger: testLogger, providerRegistry },
      { event: { type: "run.succeeded" }, threadId },
    );

    expect(outcome.applied).toBe(false);
    expect(socket.messages).toHaveLength(0);
  });
});
