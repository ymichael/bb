import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  appendStoredThreadEvent,
  closeSession,
  createConnection,
  createEnvironment,
  createProject,
  createQueuedThreadMessage,
  createThread,
  hostDaemonSessions,
  listQueuedThreadMessages,
  migrate,
  noopNotifier,
  openSession,
  setQueuedThreadMessageFailureReason,
  upsertHost,
  type DbConnection,
  type ThreadWithPendingInteractionState,
} from "@bb/db";
import {
  formatClientTurnRequestIdSuffix,
  threadScope,
  turnScope,
} from "@bb/domain";
import type {
  ClientTurnRequestId,
  PromptInput,
  Thread,
  ThreadRuntimeState,
} from "@bb/domain";
import { DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS } from "../../../src/constants.js";
import {
  resolveThreadRuntimeState,
  toThreadListEntryResponses,
} from "../../../src/services/threads/thread-runtime-display.js";
import { NotificationHub } from "../../../src/ws/hub.js";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";

const providerRegistry = await createTestProviderRegistry();

interface SetupResult {
  db: DbConnection;
  hostId: string;
  hub: NotificationHub;
}

interface OpenTestSessionArgs {
  db: DbConnection;
  hostId: string;
  leaseExpiresAt?: number;
}

interface CloseTestSessionArgs {
  closedAt: number;
  db: DbConnection;
  sessionId: string;
}

interface CreateThreadWithEnvironmentArgs {
  db: DbConnection;
  hostId: string;
  providerId?: string;
  status?: Thread["status"];
}

interface ThreadWithPinSortKey extends Thread {
  pinSortKey: string | null;
}

interface CreateThreadListEntryArgs {
  environmentHostId: string | null;
  thread: ThreadWithPinSortKey;
}

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

function turnRequestData({
  input,
  requestId,
}: {
  input: PromptInput[];
  requestId: ClientTurnRequestId;
}) {
  return {
    direction: "outbound",
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    requestId,
    input,
    target: { kind: "new-turn" },
    request: { method: "turn/start", params: {} },
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "workspace-write",
      source: "client/turn/requested",
      serviceTier: "default",
    },
  } as const;
}

function setup(): SetupResult {
  const db = createConnection(":memory:");
  migrate(db);
  const hub = new NotificationHub();
  const host = upsertHost(db, noopNotifier, {
    id: "host-runtime-display",
    name: "Runtime Display Host",
    type: "persistent",
  });
  return { db, hostId: host.id, hub };
}

function registerTestDaemon(
  hub: NotificationHub,
  args: { hostId: string; sessionId: string },
): void {
  hub.registerDaemon(args.sessionId, args.hostId, {
    close() {},
    send() {},
  });
}

function openTestSession(args: OpenTestSessionArgs) {
  const session = openSession(args.db, {
    hostId: args.hostId,
    instanceId: `instance-${randomUUID()}`,
    hostName: "Runtime Display Host",
    hostType: "persistent",
    dataDir: `/tmp/${args.hostId}`,
    protocolVersion: 1,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });

  if (args.leaseExpiresAt !== undefined) {
    args.db
      .update(hostDaemonSessions)
      .set({ leaseExpiresAt: args.leaseExpiresAt })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
  }

  return session;
}

function closeTestSession(args: CloseTestSessionArgs): void {
  closeSession(args.db, noopNotifier, args.sessionId, "daemon-disconnect");
  args.db
    .update(hostDaemonSessions)
    .set({
      closedAt: args.closedAt,
      updatedAt: args.closedAt,
    })
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .run();
}

function createThreadWithEnvironment(args: CreateThreadWithEnvironmentArgs) {
  const suffix = randomUUID();
  const { project } = createProject(args.db, noopNotifier, {
    name: `Runtime Display Project ${suffix}`,
    source: {
      type: "local_path",
      hostId: args.hostId,
      path: `/tmp/${args.hostId}/project/${suffix}`,
    },
  });
  const environment = createEnvironment(args.db, noopNotifier, {
    hostId: args.hostId,
    projectId: project.id,
    workspaceProvisionType: "unmanaged",
    path: `/tmp/${args.hostId}/environment/${suffix}`,
    status: "ready",
  });
  const thread = createThread(args.db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: args.providerId ?? "codex",
    status: args.status ?? "active",
  });

  return { environment, project, thread };
}

function createThreadListEntry(
  args: CreateThreadListEntryArgs,
): ThreadWithPendingInteractionState {
  return {
    ...args.thread,
    modelOverride: null,
    reasoningLevelOverride: null,
    environmentBranchName: null,
    environmentHostId: args.environmentHostId,
    environmentName: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    // Only a `pending` thread whose first message queued carries one, and
    // these fixtures are all threads that already started.
    pendingStartContext: null,
  };
}

describe("thread runtime display", () => {
  it("keeps active threads active while the host daemon websocket is registered", () => {
    const { db, hostId, hub } = setup();
    const now = 1_000;
    const session = openTestSession({
      db,
      hostId,
      leaseExpiresAt: now - 1,
    });
    registerTestDaemon(hub, { hostId, sessionId: session.id });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("does not treat a fresh lease as active without a registered daemon websocket", () => {
    const { db, hostId, hub } = setup();
    const now = 1_000;
    openTestSession({
      db,
      hostId,
      leaseExpiresAt: now + 30_000,
    });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "waiting-for-host",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("shows host-reconnecting for the full active-work grace after a daemon disconnect", () => {
    const { db, hostId, hub } = setup();
    const now = 60_000;
    const session = openTestSession({ db, hostId });
    const closedAt = now - DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS + 1_000;
    closeTestSession({
      closedAt,
      db,
      sessionId: session.id,
    });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "host-reconnecting",
      hostReconnectGraceExpiresAt:
        closedAt + DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
    } satisfies ThreadRuntimeState);
  });

  it("shows waiting-for-host after the active-work disconnect grace expires", () => {
    const { db, hostId, hub } = setup();
    const now = 60_000;
    const session = openTestSession({ db, hostId });
    closeTestSession({
      closedAt: now - DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - 1,
      db,
      sessionId: session.id,
    });

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        { environmentHostId: hostId, now, status: "active" },
      ),
    ).toEqual({
      displayStatus: "waiting-for-host",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("uses the thread status directly for non-active statuses", () => {
    const { db, hostId, hub } = setup();

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        {
          environmentHostId: hostId,
          now: 1_000,
          status: "idle",
        },
      ),
    ).toEqual({
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("does not require a host id for active threads without an environment host", () => {
    const { db, hub } = setup();

    expect(
      resolveThreadRuntimeState(
        { db, hub },
        {
          environmentHostId: null,
          now: 1_000,
          status: "active",
        },
      ),
    ).toEqual({
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    } satisfies ThreadRuntimeState);
  });

  it("resolves list entry runtime from daemon registration per host", () => {
    const { db, hostId, hub } = setup();
    const now = 1_000;
    const session = openTestSession({
      db,
      hostId,
      leaseExpiresAt: now - 1,
    });
    registerTestDaemon(hub, { hostId, sessionId: session.id });
    const first = createThreadWithEnvironment({ db, hostId });
    const second = createThreadWithEnvironment({ db, hostId });
    const noHost = createThreadWithEnvironment({
      db,
      hostId,
      status: "active",
    });

    const entries = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      {
        now,
        threads: [
          createThreadListEntry({
            environmentHostId: hostId,
            thread: first.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: second.thread,
          }),
          createThreadListEntry({
            environmentHostId: null,
            thread: noHost.thread,
          }),
        ],
      },
    );

    expect(entries.map((entry) => entry.runtime)).toEqual([
      {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
    ] satisfies ThreadRuntimeState[]);
  });

  it("reports each thread's queued work, with a failure outranking a wait", () => {
    const { db, hostId, hub } = setup();
    const empty = createThreadWithEnvironment({ db, hostId, status: "idle" });
    const waiting = createThreadWithEnvironment({ db, hostId, status: "idle" });
    const failed = createThreadWithEnvironment({ db, hostId, status: "idle" });

    // The failed thread holds BOTH a healthy row and a failed one, which is the
    // case the precedence rule exists for: a thread that queued two messages
    // and only the first one blew up must not read as merely waiting.
    for (const { thread, count } of [
      { thread: waiting.thread, count: 1 },
      { thread: failed.thread, count: 2 },
    ]) {
      for (let index = 0; index < count; index += 1) {
        createQueuedThreadMessage(db, noopNotifier, {
          threadId: thread.id,
          content: [{ type: "text", text: `queued ${index}`, mentions: [] }],
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "default",
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        });
      }
    }
    const failedRow = listQueuedThreadMessages(db, failed.thread.id)[0]!;
    setQueuedThreadMessageFailureReason(db, noopNotifier, {
      id: failedRow.id,
      threadId: failed.thread.id,
      failureReason: "The message could not be sent.",
    });

    const entries = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      {
        now: 1_000,
        threads: [empty.thread, waiting.thread, failed.thread].map((thread) =>
          createThreadListEntry({ environmentHostId: hostId, thread: { ...thread, pinSortKey: null } }),
        ),
      },
    );

    expect(entries.map((entry) => entry.queuedWork)).toEqual([
      "none",
      "waiting",
      "failed",
    ]);
  });

  it("builds active list entries above the SQLite variable limit", () => {
    const { db, hostId, hub } = setup();
    const { thread } = createThreadWithEnvironment({ db, hostId });
    const template = createThreadListEntry({
      environmentHostId: null,
      thread,
    });
    const threads = Array.from({ length: 32_767 }, (_, index) => ({
      ...template,
      id: `thr_variable_limit_${index}`,
    }));

    expect(
      toThreadListEntryResponses(
        { db, hub, providerRegistry },
        {
          now: 1_000,
          threads,
        },
      ),
    ).toHaveLength(32_767);
  });

  it("marks list entries active when the prompt banner would show plan or goal state", () => {
    const { db, hostId, hub } = setup();
    const activePlan = createThreadWithEnvironment({ db, hostId });
    const completedPlan = createThreadWithEnvironment({ db, hostId });
    const activeGoal = createThreadWithEnvironment({ db, hostId });
    const clearedGoal = createThreadWithEnvironment({ db, hostId });
    const concurrentPlanGoal = createThreadWithEnvironment({ db, hostId });
    const claudePlan = createThreadWithEnvironment({
      db,
      hostId,
      providerId: "claude-code",
    });
    const activePlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ab",
    });
    const completedPlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ac",
    });
    const concurrentPlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ad",
    });
    const claudePlanRequestId = formatClientTurnRequestIdSuffix({
      suffix: "23456789ae",
    });

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: activePlan.thread.id,
      scope: threadScope(),
      type: "client/turn/requested",
      data: turnRequestData({
        input: planPromptInput,
        requestId: activePlanRequestId,
      }),
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: activePlan.thread.id,
      scope: turnScope("turn-active-plan"),
      providerThreadId: "provider-active-plan",
      type: "turn/input/accepted",
      data: {
        providerThreadId: "provider-active-plan",
        clientRequestId: activePlanRequestId,
      },
    });

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: completedPlan.thread.id,
      scope: threadScope(),
      type: "client/turn/requested",
      data: turnRequestData({
        input: planPromptInput,
        requestId: completedPlanRequestId,
      }),
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: completedPlan.thread.id,
      scope: turnScope("turn-completed-plan"),
      providerThreadId: "provider-completed-plan",
      type: "turn/input/accepted",
      data: {
        providerThreadId: "provider-completed-plan",
        clientRequestId: completedPlanRequestId,
      },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: completedPlan.thread.id,
      scope: turnScope("turn-completed-plan"),
      providerThreadId: "provider-completed-plan",
      type: "turn/completed",
      data: {
        providerThreadId: "provider-completed-plan",
        status: "completed",
      },
    });

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: activeGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-active-goal",
      type: "thread/goal/updated",
      data: {
        providerThreadId: "provider-active-goal",
        objective: "Finish the sidebar activity indicator",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 512,
        timeUsedSeconds: 42,
      },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: clearedGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-cleared-goal",
      type: "thread/goal/updated",
      data: {
        providerThreadId: "provider-cleared-goal",
        objective: "This goal was cleared",
        status: "active",
        tokenBudget: null,
        tokensUsed: 128,
        timeUsedSeconds: 10,
      },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: clearedGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-cleared-goal",
      type: "thread/goal/cleared",
      data: { providerThreadId: "provider-cleared-goal" },
    });
    for (const [target, requestId, turnId, providerThreadId] of [
      [
        concurrentPlanGoal,
        concurrentPlanRequestId,
        "turn-concurrent-plan-goal",
        "provider-concurrent-plan-goal",
      ],
      [
        claudePlan,
        claudePlanRequestId,
        "turn-claude-plan",
        "provider-claude-plan",
      ],
    ] as const) {
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: target.thread.id,
        scope: threadScope(),
        type: "client/turn/requested",
        data: turnRequestData({ input: planPromptInput, requestId }),
      });
      appendStoredThreadEvent(db, noopNotifier, {
        threadId: target.thread.id,
        scope: turnScope(turnId),
        providerThreadId,
        type: "turn/input/accepted",
        data: { providerThreadId, clientRequestId: requestId },
      });
    }
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: concurrentPlanGoal.thread.id,
      scope: threadScope(),
      providerThreadId: "provider-concurrent-plan-goal",
      type: "thread/goal/updated",
      data: {
        providerThreadId: "provider-concurrent-plan-goal",
        objective: "Keep working while planning",
        status: "active",
        tokenBudget: null,
        tokensUsed: 64,
        timeUsedSeconds: 5,
      },
    });

    const entries = toThreadListEntryResponses(
      { db, hub, providerRegistry },
      {
        threads: [
          createThreadListEntry({
            environmentHostId: hostId,
            thread: activePlan.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: completedPlan.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: activeGoal.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: clearedGoal.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: concurrentPlanGoal.thread,
          }),
          createThreadListEntry({
            environmentHostId: hostId,
            thread: claudePlan.thread,
          }),
        ],
      },
    );
    const activityByThreadId = new Map(
      entries.map((entry) => [entry.id, entry.activity]),
    );

    expect(activityByThreadId.get(activePlan.thread.id)).toMatchObject({
      activePlanModeCount: 1,
      activeGoalCount: 0,
    });
    expect(activityByThreadId.get(completedPlan.thread.id)).toMatchObject({
      activePlanModeCount: 0,
      activeGoalCount: 0,
    });
    expect(activityByThreadId.get(activeGoal.thread.id)).toMatchObject({
      activePlanModeCount: 0,
      activeGoalCount: 1,
    });
    expect(activityByThreadId.get(clearedGoal.thread.id)).toMatchObject({
      activePlanModeCount: 0,
      activeGoalCount: 0,
    });
    expect(activityByThreadId.get(concurrentPlanGoal.thread.id)).toMatchObject({
      activePlanModeCount: 1,
      activeGoalCount: 1,
    });
    expect(activityByThreadId.get(claudePlan.thread.id)).toMatchObject({
      activePlanModeCount: 1,
      activeGoalCount: 0,
    });
  });
});
