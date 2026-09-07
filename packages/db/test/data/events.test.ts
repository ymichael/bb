import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_AGENT_TASK_TYPE,
  LOCAL_BASH_TASK_TYPE,
  LOCAL_SUBAGENT_TASK_TYPE,
  LOCAL_WORKFLOW_TASK_TYPE,
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  turnScope,
  type PromptInput,
} from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  appendDaemonEventsInTransaction,
  appendStoredThreadEvent,
  appendStoredThreadEventInTransaction,
  appendStoredThreadEventsInTransaction,
  findStoredEventRow,
  findStoredTimelineWindowByteBudgetFloor,
  findTimelineWindowBudgetFloorSequence,
  getActiveStoredTurnId,
  getHighWaterMarks,
  getLastStoredProviderThreadId,
  getLatestCompletedThreadContextClearSequence,
  getLatestStoredConversationOutlineSequence,
  getLastStoredTurnRequestEvent,
  getLatestThreadOutputEventRow,
  getLatestThreadSequence,
  getStoredTimelineWindowEventDataBytes,
  insertEvents,
  listContextWindowUsageRows,
  listCompletedTurnsByThreadIds,
  listEvents,
  listLatestThreadStateEventRowsByThreadIds,
  listRecentStoredEventRows,
  listStoredConversationOutlineEventRows,
  listTimelineSegmentAnchorsDescending,
  getTimelineSegmentAnchorAtSequence,
  listOpenTurnInputAcceptedRowsByThreadIds,
  listStoredClientTurnRequestIdsInRange,
  listStoredClientTurnRequestRowsByKeys,
  listStoredEventRows,
  listStoredThreadProvisioningRowsByProvisioningId,
  findUnfinishedTurnCoveringSequence,
  hasParentedEventCrossingSequence,
  listStoredTimelineWindowEventRows,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnRejectedRowsByClientRequestIds,
  MissingStoredTurnStartedError,
  listActiveBackgroundTaskCountsByThreadIds,
  listLatestBackgroundTaskStateRowsByItemIds,
  listOpenBackgroundTaskItemRowsForHost,
  listThreadTurnInterruptionEventStates,
  pruneBackgroundTaskProgressEvents,
  pruneContextWindowUsageEventsBeforeSequence,
  pruneTokenUsageEventsBeforeSequence,
  pruneResolvedItemDeltas,
  pruneThreadEventsBeforeSequence,
  listLatestOpenBackgroundTaskStateRowsForThread,
  STORED_TIMELINE_BYTE_PREFLIGHT_EVENT_LIMIT,
} from "../../src/data/events.js";
import { createEnvironment } from "../../src/data/environments.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, thread };
}

const emptyItemFields = {
  itemId: null,
  itemKind: null,
  parentToolCallId: null,
} as const;

const threadEventFields = {
  ...emptyItemFields,
  scope: threadScope(),
};

const daemonThreadEventFields = {
  ...threadEventFields,
  environmentId: null,
  providerThreadId: null,
};

interface CreateTurnEventFieldsArgs {
  turnId: string;
}

function createTurnEventFields(args: CreateTurnEventFieldsArgs) {
  return {
    ...emptyItemFields,
    scope: turnScope(args.turnId),
  };
}

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

function clientTurnRequestData(requestId: string, text: string): string {
  return JSON.stringify({
    direction: "outbound",
    requestId,
    source: "tell",
    initiator: "user",
    input: textInput(text),
    target: { kind: "new-turn" },
    request: { method: "turn/start", params: {} },
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "workspace-write",
      source: "client/turn/requested",
      serviceTier: "auto",
    },
  });
}

interface CreateTokenUsageDataArgs {
  modelContextWindow: number | null;
  totalTokens: number;
}

interface CreateContextWindowUsageDataArgs {
  estimated?: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

function createTokenUsageData(args: CreateTokenUsageDataArgs): string {
  return JSON.stringify({
    tokenUsage: {
      total: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: args.modelContextWindow,
    },
  });
}

function createContextWindowUsageData(
  args: CreateContextWindowUsageDataArgs,
): string {
  return JSON.stringify({
    contextWindowUsage: {
      usedTokens: args.usedTokens,
      modelContextWindow: args.modelContextWindow,
      estimated: args.estimated ?? false,
    },
  });
}

describe("events", () => {
  it("inserts events and returns count", () => {
    const { db, thread } = setup();

    const result = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "test" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "test2" }),
      },
    ]);

    expect(result).toEqual({
      insertedCount: 2,
      insertedInputIndexes: [0, 1],
    });
    const all = listEvents(db, { threadId: thread.id });
    expect(all).toHaveLength(2);
  });

  it("stores derived item columns when provided", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "msg-1",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "msg-1",
            type: "agentMessage",
            text: "hello",
          },
        }),
      },
    ]);

    const all = listEvents(db, { threadId: thread.id });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      itemId: "msg-1",
      itemKind: "agentMessage",
      parentToolCallId: null,
    });
  });

  it("rejects turn scope rows without a stored turn id", () => {
    const { db, thread } = setup();

    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO events (
            id,
            thread_id,
            scope_kind,
            turn_id,
            sequence,
            type,
            item_id,
            item_kind,
            data,
            created_at
          )
          VALUES (
            'evt_bad_scope_shape',
            ?,
            'turn',
            NULL,
            1,
            'system/error',
            NULL,
            NULL,
            '{}',
            1
          )`,
        )
        .run(thread.id),
    ).toThrow(/events_scope_shape_check|CHECK constraint failed/);
  });

  it("deduplicates on (threadId, sequence)", () => {
    const { db, thread } = setup();

    const result1 = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "first" }),
      },
    ]);
    expect(result1).toEqual({
      insertedCount: 1,
      insertedInputIndexes: [0],
    });

    const result2 = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "duplicate" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "new" }),
      },
    ]);
    expect(result2).toEqual({
      insertedCount: 1,
      insertedInputIndexes: [1],
    });

    const all = listEvents(db, { threadId: thread.id });
    expect(all).toHaveLength(2);
    expect(JSON.parse(all[0]!.data)).toMatchObject({ message: "first" });
  });

  it("appends daemon events with server-owned sequences", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 5,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "existing" }),
      },
    ]);

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "first daemon" }),
          },
          {
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "second daemon" }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(result).toEqual({
      acceptedEvents: [
        {
          threadId: thread.id,
          sequence: 6,
        },
        {
          threadId: thread.id,
          sequence: 7,
        },
      ],
      insertedInputIndexes: [0, 1],
      skippedTurnUnstartedInputIndexes: [],
    });
    expect(listEvents(db, { threadId: thread.id })).toMatchObject([
      { sequence: 5 },
      {
        sequence: 6,
      },
      {
        sequence: 7,
      },
    ]);
  });

  it("deduplicates a settled item until item/started reopens it", () => {
    const { db, thread } = setup();
    const turnId = "turn-denied-approval";
    const itemId = "command-denied-approval";

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope(turnId),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        providerThreadId: "provider-thread-denied-approval",
        data: JSON.stringify({
          providerThreadId: "provider-thread-denied-approval",
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope(turnId),
        itemId,
        itemKind: "commandExecution",
        parentToolCallId: null,
        providerThreadId: "provider-thread-denied-approval",
        data: JSON.stringify({
          providerThreadId: "provider-thread-denied-approval",
          item: {
            type: "commandExecution",
            id: itemId,
            command: "false",
            cwd: "/tmp/project",
            status: "pending",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        scope: turnScope(turnId),
        itemId,
        itemKind: "commandExecution",
        parentToolCallId: null,
        providerThreadId: "provider-thread-denied-approval",
        data: JSON.stringify({
          providerThreadId: "provider-thread-denied-approval",
          item: {
            type: "commandExecution",
            id: itemId,
            command: "false",
            cwd: "/tmp/project",
            status: "interrupted",
            approvalStatus: "denied",
          },
        }),
      },
    ]);

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/completed",
            scope: turnScope(turnId),
            itemId,
            itemKind: "commandExecution",
            parentToolCallId: null,
            providerThreadId: "provider-thread-denied-approval",
            data: JSON.stringify({
              providerThreadId: "provider-thread-denied-approval",
              item: {
                type: "commandExecution",
                id: itemId,
                command: "false",
                cwd: "/tmp/project",
                status: "interrupted",
                approvalStatus: "denied",
              },
            }),
          },
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/started",
            scope: turnScope(turnId),
            itemId,
            itemKind: "commandExecution",
            parentToolCallId: null,
            providerThreadId: "provider-thread-after-restart",
            data: JSON.stringify({
              providerThreadId: "provider-thread-after-restart",
              item: {
                type: "commandExecution",
                id: itemId,
                command: "false",
                cwd: "/tmp/project",
                status: "pending",
              },
            }),
          },
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/completed",
            scope: turnScope(turnId),
            itemId,
            itemKind: "commandExecution",
            parentToolCallId: null,
            providerThreadId: "provider-thread-after-restart",
            data: JSON.stringify({
              providerThreadId: "provider-thread-after-restart",
              item: {
                type: "commandExecution",
                id: itemId,
                command: "false",
                cwd: "/tmp/project",
                status: "interrupted",
                approvalStatus: "denied",
              },
            }),
          },
          {
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "neighbor persisted" }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(result).toEqual({
      acceptedEvents: [
        { threadId: thread.id, sequence: 4 },
        { threadId: thread.id, sequence: 5 },
        { threadId: thread.id, sequence: 6 },
      ],
      insertedInputIndexes: [1, 2, 3],
      skippedTurnUnstartedInputIndexes: [],
    });
    expect(listEvents(db, { threadId: thread.id })).toMatchObject([
      { sequence: 1, type: "turn/started" },
      { sequence: 2, type: "item/started", itemId },
      { sequence: 3, type: "item/completed", itemId },
      { sequence: 4, type: "item/started", itemId, turnId },
      {
        sequence: 5,
        type: "item/completed",
        itemId,
        turnId,
      },
      { sequence: 6, type: "system/error" },
    ]);
  });

  it("uses item/started to reopen a thread-scoped background completion", () => {
    const { db, thread } = setup();
    const turnId = "turn-background-reuse";
    const itemId = "background-reused";
    const providerThreadId = "provider-background-reuse";
    const backgroundItem = {
      type: "backgroundTask" as const,
      id: itemId,
      taskType: LOCAL_BASH_TASK_TYPE,
      status: "pending" as const,
      taskStatus: "running" as const,
      description: "Background command",
      skipTranscript: false,
    };
    const completedBackgroundItem = {
      ...backgroundItem,
      status: "completed" as const,
      taskStatus: "completed" as const,
    };

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope(turnId),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        providerThreadId,
        data: JSON.stringify({ providerThreadId }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope(turnId),
        itemId,
        itemKind: "backgroundTask",
        parentToolCallId: null,
        providerThreadId,
        data: JSON.stringify({ providerThreadId, item: backgroundItem }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        itemId,
        itemKind: "backgroundTask",
        parentToolCallId: null,
        providerThreadId,
        data: JSON.stringify({
          providerThreadId,
          item: completedBackgroundItem,
        }),
      },
    ]);

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/backgroundTask/completed",
            scope: threadScope(),
            itemId,
            itemKind: "backgroundTask",
            parentToolCallId: null,
            providerThreadId,
            data: JSON.stringify({
              providerThreadId,
              item: completedBackgroundItem,
            }),
          },
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/started",
            scope: turnScope(turnId),
            itemId,
            itemKind: "backgroundTask",
            parentToolCallId: null,
            providerThreadId,
            data: JSON.stringify({ providerThreadId, item: backgroundItem }),
          },
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/backgroundTask/completed",
            scope: threadScope(),
            itemId,
            itemKind: "backgroundTask",
            parentToolCallId: null,
            providerThreadId,
            data: JSON.stringify({
              providerThreadId,
              item: completedBackgroundItem,
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(result).toEqual({
      acceptedEvents: [
        { threadId: thread.id, sequence: 4 },
        { threadId: thread.id, sequence: 5 },
      ],
      insertedInputIndexes: [1, 2],
      skippedTurnUnstartedInputIndexes: [],
    });
  });

  it("skips turn/started when a daemon replays an already-committed batch", () => {
    const { db, thread } = setup();
    const turnStarted = {
      threadId: thread.id,
      type: "turn/started" as const,
      ...createTurnEventFields({ turnId: "turn_replayed" }),
      environmentId: null,
      providerThreadId: "provider_thr_replayed",
      data: JSON.stringify({
        providerThreadId: "provider_thr_replayed",
        turnId: "turn_replayed",
      }),
    };
    const turnCompleted = {
      threadId: thread.id,
      type: "turn/completed" as const,
      ...createTurnEventFields({ turnId: "turn_replayed" }),
      environmentId: null,
      providerThreadId: "provider_thr_replayed",
      data: JSON.stringify({
        providerThreadId: "provider_thr_replayed",
        status: "completed",
        turnId: "turn_replayed",
      }),
    };

    const first = db.transaction(
      (tx) => appendDaemonEventsInTransaction(tx, [turnStarted, turnCompleted]),
      { behavior: "immediate" },
    );
    const replay = db.transaction(
      (tx) => appendDaemonEventsInTransaction(tx, [turnStarted, turnCompleted]),
      { behavior: "immediate" },
    );

    expect(first.insertedInputIndexes).toEqual([0, 1]);
    expect(replay).toEqual({
      acceptedEvents: [{ threadId: thread.id, sequence: 3 }],
      insertedInputIndexes: [1],
      skippedTurnUnstartedInputIndexes: [],
    });
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.type),
    ).toEqual(["turn/started", "turn/completed", "turn/completed"]);
  });

  it("skips a turn/started repeated inside one daemon batch", () => {
    const { db, thread } = setup();
    const turnStarted = {
      threadId: thread.id,
      type: "turn/started" as const,
      ...createTurnEventFields({ turnId: "turn_twice" }),
      environmentId: null,
      providerThreadId: "provider_thr_twice",
      data: JSON.stringify({
        providerThreadId: "provider_thr_twice",
        turnId: "turn_twice",
      }),
    };

    const result = db.transaction(
      (tx) => appendDaemonEventsInTransaction(tx, [turnStarted, turnStarted]),
      { behavior: "immediate" },
    );

    expect(result.insertedInputIndexes).toEqual([0]);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.type),
    ).toEqual(["turn/started"]);
  });

  it("rejects daemon turn-scoped events before turn/started is stored", () => {
    const { db, thread } = setup();

    expect(() =>
      db.transaction(
        (tx) =>
          appendDaemonEventsInTransaction(tx, [
            {
              threadId: thread.id,
              type: "turn/completed",
              ...createTurnEventFields({ turnId: "turn_missing" }),
              environmentId: null,
              providerThreadId: "provider_thr_missing",
              data: JSON.stringify({
                providerThreadId: "provider_thr_missing",
                status: "completed",
                turnId: "turn_missing",
              }),
            },
          ]),
        { behavior: "immediate" },
      ),
    ).toThrow(MissingStoredTurnStartedError);
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(0);
  });

  it("rejects daemon turn-scoped events before turn/started in the same batch", () => {
    const { db, thread } = setup();

    expect(() =>
      db.transaction(
        (tx) =>
          appendDaemonEventsInTransaction(tx, [
            {
              threadId: thread.id,
              type: "turn/completed",
              ...createTurnEventFields({ turnId: "turn_late_start" }),
              environmentId: null,
              providerThreadId: "provider_thr_late",
              data: JSON.stringify({
                providerThreadId: "provider_thr_late",
                status: "completed",
                turnId: "turn_late_start",
              }),
            },
            {
              threadId: thread.id,
              type: "turn/started",
              ...createTurnEventFields({ turnId: "turn_late_start" }),
              environmentId: null,
              providerThreadId: "provider_thr_late",
              data: JSON.stringify({
                providerThreadId: "provider_thr_late",
                turnId: "turn_late_start",
              }),
            },
          ]),
        { behavior: "immediate" },
      ),
    ).toThrow(MissingStoredTurnStartedError);
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(0);
  });

  it("drops orphan token-usage snapshots with no stored turn/started instead of failing the batch", () => {
    const { db, thread } = setup();

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            type: "thread/tokenUsage/updated",
            ...createTurnEventFields({ turnId: "turn_carried_over" }),
            environmentId: null,
            providerThreadId: "provider_thr_resumed",
            data: createTokenUsageData({
              totalTokens: 42,
              modelContextWindow: 200_000,
            }),
          },
          {
            threadId: thread.id,
            type: "turn/started",
            ...createTurnEventFields({ turnId: "turn_new" }),
            environmentId: null,
            providerThreadId: "provider_thr_resumed",
            data: JSON.stringify({
              providerThreadId: "provider_thr_resumed",
              turnId: "turn_new",
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(result.skippedTurnUnstartedInputIndexes).toEqual([0]);
    expect(result.insertedInputIndexes).toEqual([1]);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.type),
    ).toEqual(["turn/started"]);
  });

  it("drops orphan provider/unhandled events instead of failing the batch", () => {
    const { db, thread } = setup();

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            type: "provider/unhandled",
            ...createTurnEventFields({ turnId: "auto-compact-1" }),
            environmentId: null,
            providerThreadId: "provider_thr_compacting",
            data: JSON.stringify({
              providerThreadId: "provider_thr_compacting",
              providerId: "codex",
              rawType: "sdk/custom",
              rawEvent: {
                jsonrpc: "2.0",
                method: "sdk/message",
                params: { turnId: "auto-compact-1" },
              },
            }),
          },
          {
            threadId: thread.id,
            type: "turn/started",
            ...createTurnEventFields({ turnId: "turn_after_compaction" }),
            environmentId: null,
            providerThreadId: "provider_thr_compacting",
            data: JSON.stringify({
              providerThreadId: "provider_thr_compacting",
              turnId: "turn_after_compaction",
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(result.skippedTurnUnstartedInputIndexes).toEqual([0]);
    expect(result.insertedInputIndexes).toEqual([1]);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.type),
    ).toEqual(["turn/started"]);
  });

  it("accepts daemon turn-scoped events after earlier turn/started in the same batch", () => {
    const { db, thread } = setup();

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            type: "turn/started",
            ...createTurnEventFields({ turnId: "turn_ordered" }),
            environmentId: null,
            providerThreadId: "provider_thr_ordered",
            data: JSON.stringify({
              providerThreadId: "provider_thr_ordered",
              turnId: "turn_ordered",
            }),
          },
          {
            threadId: thread.id,
            type: "turn/completed",
            ...createTurnEventFields({ turnId: "turn_ordered" }),
            environmentId: null,
            providerThreadId: "provider_thr_ordered",
            data: JSON.stringify({
              providerThreadId: "provider_thr_ordered",
              status: "completed",
              turnId: "turn_ordered",
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(result).toMatchObject({
      acceptedEvents: [
        { threadId: thread.id, sequence: 1 },
        { threadId: thread.id, sequence: 2 },
      ],
      insertedInputIndexes: [0, 1],
    });
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(2);
  });

  it("accepts daemon turn-scoped events after turn/started is stored", () => {
    const { db, thread } = setup();

    db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            type: "turn/started",
            ...createTurnEventFields({ turnId: "turn_prior" }),
            environmentId: null,
            providerThreadId: "provider_thr_prior",
            data: JSON.stringify({
              providerThreadId: "provider_thr_prior",
              turnId: "turn_prior",
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            type: "turn/completed",
            ...createTurnEventFields({ turnId: "turn_prior" }),
            environmentId: null,
            providerThreadId: "provider_thr_prior",
            data: JSON.stringify({
              providerThreadId: "provider_thr_prior",
              status: "completed",
              turnId: "turn_prior",
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(result).toMatchObject({
      acceptedEvents: [{ threadId: thread.id, sequence: 2 }],
      insertedInputIndexes: [0],
    });
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(2);
  });

  it("persists neighboring daemon events when accepted input data is malformed", () => {
    const { db, thread } = setup();

    db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            type: "turn/started",
            ...daemonThreadEventFields,
            scope: turnScope("turn-1"),
            providerThreadId: "provider-thread-1",
            data: JSON.stringify({ providerThreadId: "provider-thread-1" }),
          },
          {
            threadId: thread.id,
            type: "turn/input/accepted",
            ...daemonThreadEventFields,
            scope: turnScope("turn-1"),
            providerThreadId: "provider-thread-1",
            data: "{malformed-json",
          },
          {
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "neighbor persisted" }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(listEvents(db, { threadId: thread.id }).map((event) => event.type))
      .toEqual(["turn/started", "turn/input/accepted", "system/error"]);
  });

  it("stores the provided createdAt timestamp", () => {
    const { db, thread } = setup();
    const createdAt = 1_700_000_000_000;

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        createdAt,
        data: JSON.stringify({ message: "timestamped" }),
      },
    ]);

    const [event] = listEvents(db, { threadId: thread.id });
    expect(event?.createdAt).toBe(createdAt);
  });

  it("lists and finds stored event rows with shared DB helpers", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "first" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "second" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn_1" }),
        data: JSON.stringify({ turnId: "turn_1" }),
      },
    ]);

    expect(
      listStoredEventRows(db, {
        afterSequence: 1,
        limit: 1,
        threadId: thread.id,
      }),
    ).toMatchObject([
      {
        sequence: 2,
        type: "system/error",
      },
    ]);

    expect(
      listStoredEventRows(db, {
        beforeSequence: 3,
        order: "desc",
        threadId: thread.id,
        types: ["system/error"],
      }),
    ).toMatchObject([
      { sequence: 2, type: "system/error" },
      { sequence: 1, type: "system/error" },
    ]);

    expect(
      listStoredEventRows(db, {
        threadId: thread.id,
        types: [],
      }),
    ).toEqual([]);

    expect(
      findStoredEventRow(db, {
        afterSequence: 1,
        threadId: thread.id,
        type: "system/error",
      }),
    ).toMatchObject({
      sequence: 2,
      type: "system/error",
    });
  });

  it("finds the latest output event row without scanning unrelated event types", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/manager/user_message",
        ...threadEventFields,
        data: JSON.stringify({ text: "manager output" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "msg_1",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: { id: "msg_1", type: "agentMessage", text: "assistant output" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "call_1",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({ item: { id: "call_1", type: "toolCall" } }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "ignored" }),
      },
    ]);

    expect(
      getLatestThreadOutputEventRow(db, { threadId: thread.id }),
    ).toMatchObject({
      sequence: 2,
      itemKind: "agentMessage",
      parentToolCallId: null,
      type: "item/completed",
    });
  });

  it("skips empty assistant output when a manager user message is the latest visible output", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/manager/user_message",
        ...threadEventFields,
        data: JSON.stringify({ text: "manager output" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "msg_1",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: { id: "msg_1", type: "agentMessage", text: "" },
        }),
      },
    ]);

    expect(
      getLatestThreadOutputEventRow(db, { threadId: thread.id }),
    ).toMatchObject({
      sequence: 1,
      type: "system/manager/user_message",
    });
  });

  it("lists stored event rows by range and exclusion filters", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "first" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          modelContextWindow: 16_000,
          usedTokens: 100,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          modelContextWindow: null,
          usedTokens: 200,
        }),
      },
    ]);

    expect(
      listRecentStoredEventRows(db, {
        excludedTypes: ["system/error"],
        maxInlineOutputChars: null,
        sequenceStart: 0,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3]);

    expect(
      listContextWindowUsageRows(db, {
        sequenceStart: 0,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3]);
  });

  it("keeps nested-turn context usage from replacing the root turn report", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-root" }),
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-root" }),
        data: createContextWindowUsageData({
          modelContextWindow: 200_000,
          usedTokens: 80_000,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-subagent" }),
        parentToolCallId: "call-subagent",
        data: JSON.stringify({ parentToolCallId: "call-subagent" }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-subagent" }),
        data: createContextWindowUsageData({
          modelContextWindow: 200_000,
          usedTokens: 15_000,
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-root" }),
        data: createContextWindowUsageData({
          modelContextWindow: null,
          usedTokens: 90_000,
        }),
      },
    ]);

    expect(
      listContextWindowUsageRows(db, {
        sequenceStart: 0,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 5]);
  });

  it("lists bounded timeline segment anchors with request shape rules", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: textInput("user message"),
          target: { kind: "new-turn" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "system",
          input: textInput("system message"),
          target: { kind: "new-turn" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: textInput("accepted steer"),
          target: { kind: "auto", expectedTurnId: "turn-1" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: textInput("auto new turn"),
          target: { kind: "auto", expectedTurnId: null },
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: textInput("explicit steer"),
          target: { kind: "steer", expectedTurnId: "turn-1" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 6,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: textInput(""),
          target: { kind: "new-turn" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 7,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: [{ type: "localImage", path: "/tmp/image.png" }],
          target: { kind: "thread-start" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 8,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: textInput("legacy target"),
        }),
      },
      {
        threadId: thread.id,
        sequence: 9,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: [{ type: "image", url: "https://example.com/image.png" }],
          target: { kind: "new-turn" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 10,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: [{ type: "localFile", path: "/tmp/input.txt" }],
          target: { kind: "new-turn" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 11,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "agent",
          input: textInput("agent message"),
          target: { kind: "new-turn" },
        }),
      },
    ]);

    expect(
      listTimelineSegmentAnchorsDescending(db, {
        limit: 8,
        sequenceStart: 0,
        threadId: thread.id,
      }),
    ).toEqual([
      { rowId: `${thread.id}:user-seed:11`, sequence: 11 },
      { rowId: `${thread.id}:user-seed:10`, sequence: 10 },
      { rowId: `${thread.id}:user-seed:9`, sequence: 9 },
      { rowId: `${thread.id}:user-seed:8`, sequence: 8 },
      { rowId: `${thread.id}:user-seed:7`, sequence: 7 },
      { rowId: `${thread.id}:user-seed:4`, sequence: 4 },
      { rowId: `${thread.id}:user-seed:2`, sequence: 2 },
      { rowId: `${thread.id}:user-seed:1`, sequence: 1 },
    ]);

    expect(
      listTimelineSegmentAnchorsDescending(db, {
        limit: 3,
        sequenceStart: 0,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([11, 10, 9]);
    expect(
      listTimelineSegmentAnchorsDescending(db, {
        beforeSequence: 8,
        limit: 3,
        sequenceStart: 0,
        threadId: thread.id,
      }),
    ).toEqual([
      { rowId: `${thread.id}:user-seed:7`, sequence: 7 },
      { rowId: `${thread.id}:user-seed:4`, sequence: 4 },
      { rowId: `${thread.id}:user-seed:2`, sequence: 2 },
    ]);
    expect(
      getTimelineSegmentAnchorAtSequence(db, {
        sequence: 7,
        threadId: thread.id,
      }),
    ).toEqual({ rowId: `${thread.id}:user-seed:7`, sequence: 7 });
    expect(
      getTimelineSegmentAnchorAtSequence(db, {
        sequence: 2,
        threadId: thread.id,
      }),
    ).toEqual({ rowId: `${thread.id}:user-seed:2`, sequence: 2 });
  });

  it("loads timeline event windows with sequence bounds and exclusions", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "before" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          modelContextWindow: 16_000,
          usedTokens: 100,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "inside" }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "after" }),
      },
    ]);

    expect(
      listStoredTimelineWindowEventRows(db, {
        beforeSequence: 4,
        excludedTypes: ["thread/contextWindowUsage/updated"],
        maxInlineOutputChars: null,
        sequenceStart: 2,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([3]);

    expect(
      listStoredTimelineWindowEventRows(db, {
        excludedTypes: [],
        maxInlineOutputChars: null,
        sequenceStart: 2,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3, 4]);

    expect(
      listStoredTimelineWindowEventRows(db, {
        beforeSequence: 4,
        maxInlineOutputChars: null,
        sequenceStart: 2,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3]);
  });

  it("skips superseded backgroundTask progress snapshots in timeline reads", () => {
    const { db, thread } = setup();

    const taskData = (id: string, status: "pending" | "completed") =>
      JSON.stringify({
        item: {
          id,
          type: "backgroundTask",
          taskType: "local_workflow",
          description: "fixture workflow",
          status,
          taskStatus: status === "pending" ? "running" : "completed",
          skipTranscript: false,
        },
      });
    const progress = (sequence: number, itemId: string) => ({
      threadId: thread.id,
      sequence,
      scope: threadScope(),
      type: "item/backgroundTask/progress" as const,
      itemId,
      itemKind: "backgroundTask" as const,
      parentToolCallId: null,
      data: taskData(itemId, "pending"),
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-1", "pending"),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-2",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-2", "pending"),
      },
      progress(3, "task:wf-1"),
      progress(4, "task:wf-1"),
      progress(5, "task:wf-2"),
      progress(6, "task:wf-1"),
      {
        threadId: thread.id,
        sequence: 7,
        scope: threadScope(),
        type: "item/backgroundTask/completed",
        itemId: "task:wf-2",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-2", "completed"),
      },
    ]);

    expect(
      listStoredTimelineWindowEventRows(db, {
        maxInlineOutputChars: null,
        sequenceStart: 1,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([1, 2, 6, 7]);
    expect(
      listStoredTimelineWindowEventRows(db, {
        beforeSequence: 6,
        maxInlineOutputChars: null,
        sequenceStart: 1,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([1, 2]);
    expect(
      listRecentStoredEventRows(db, {
        maxInlineOutputChars: null,
        sequenceStart: 0,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([1, 2, 6, 7]);
    expect(
      findStoredTimelineWindowByteBudgetFloor(db, {
        maxDataBytes: 1_000_000,
        maxInlineOutputChars: null,
        sequenceStart: 1,
        threadId: thread.id,
      }),
    ).toEqual({
      eventDataBytes: getStoredTimelineWindowEventDataBytes(db, {
        maxInlineOutputChars: null,
        sequenceStart: 1,
        threadId: thread.id,
      }),
      kind: "fits",
    });
    expect(
      getStoredTimelineWindowEventDataBytes(db, {
        maxInlineOutputChars: null,
        sequenceStart: 1,
        threadId: thread.id,
      }),
    ).toBe(
      listStoredTimelineWindowEventRows(db, {
        maxInlineOutputChars: null,
        sequenceStart: 1,
        threadId: thread.id,
      }).reduce((bytes, row) => bytes + Buffer.byteLength(row.data), 0),
    );
    expect(
      findTimelineWindowBudgetFloorSequence(db, {
        eventBudget: 2,
        excludedTypes: [],
        sequenceStart: 0,
        threadId: thread.id,
      }),
    ).toBe(2);
    expect(
      findTimelineWindowBudgetFloorSequence(db, {
        eventBudget: 1,
        excludedTypes: [],
        sequenceStart: 0,
        threadId: thread.id,
      }),
    ).toBe(6);
    expect(
      listStoredConversationOutlineEventRows(db, {
        sequenceStart: 0,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([1, 2, 6]);
  });

  it("omits redundant structural completions and unused payload fields", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "tool-1",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "fixture",
            arguments: { prompt: "large input" },
            status: "pending",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "tool-1",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "fixture",
            status: "completed",
            result: "large output",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "tool-2",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: "tool-2",
            tool: "fixture",
            status: "completed",
            result: "completion without a start",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "tool-3",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: "tool-3",
            tool: "fixture",
            arguments: { prompt: "failing input" },
            status: "pending",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "tool-3",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: "tool-3",
            tool: "fixture",
            status: "failed",
            error: "large failure output",
          },
        }),
      },
    ]);

    const rows = listStoredConversationOutlineEventRows(db, {
      sequenceStart: 0,
      threadId: thread.id,
    });

    expect(rows.map((row) => row.sequence)).toEqual([1, 3, 4, 5]);
    expect(rows.map((row) => JSON.parse(row.data))).toEqual([
      {
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "fixture",
          status: "pending",
        },
      },
      {
        item: {
          type: "toolCall",
          id: "tool-2",
          tool: "fixture",
          status: "completed",
        },
      },
      {
        item: {
          type: "toolCall",
          id: "tool-3",
          tool: "fixture",
          status: "pending",
        },
      },
      {
        item: {
          type: "toolCall",
          id: "tool-3",
          tool: "fixture",
          status: "failed",
        },
      },
    ]);

    db.$client.close();
  });

  it("lists accepted input rows for requested client turn sequences", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          direction: "outbound",
          requestId: "creq_23456789ab",
          source: "tell",
          initiator: "user",
          input: textInput("first"),
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "workspace-write",
            source: "client/turn/requested",
            serviceTier: "auto",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          direction: "outbound",
          requestId: "creq_23456789ac",
          source: "tell",
          initiator: "user",
          input: textInput("second"),
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "workspace-write",
            source: "client/turn/requested",
            serviceTier: "auto",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: JSON.stringify({
          clientRequestId: "creq_23456789ab",
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-2" }),
        data: JSON.stringify({
          clientRequestId: "creq_23456789ad",
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-3" }),
        data: JSON.stringify({
          clientRequestId: "creq_23456789ac",
        }),
      },
    ]);

    expect(
      listStoredTurnInputAcceptedRowsByClientRequestIds(db, {
        threadId: thread.id,
        afterSequence: 2,
        clientRequestIds: ["creq_23456789ab", "creq_23456789ac"],
      }).map((row) => row.sequence),
    ).toEqual([3, 5]);
  });

  it("lists rejected rows for requested client turn sequences", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 3,
        type: "client/turn/rejected",
        ...threadEventFields,
        data: JSON.stringify({
          requestId: "creq_23456789ab",
          reason: "provider_rpc_error",
          message: "No active turn",
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "client/turn/rejected",
        ...threadEventFields,
        data: JSON.stringify({
          requestId: "creq_23456789ac",
          reason: "provider_rpc_error",
          message: "No active turn",
        }),
      },
    ]);

    expect(
      listStoredTurnRejectedRowsByClientRequestIds(db, {
        threadId: thread.id,
        afterSequence: 2,
        clientRequestIds: ["creq_23456789ac"],
      }).map((row) => row.sequence),
    ).toEqual([4]);
  });

  it("lists only the latest goal-state row per thread, legacy and extension rows alike", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "thread/goal/updated",
        ...threadEventFields,
        providerThreadId: "provider-thread-1",
        data: JSON.stringify({
          objective: "Old goal",
          status: "active",
          tokenBudget: null,
          tokensUsed: 1,
          timeUsedSeconds: 1,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/goal/cleared",
        ...threadEventFields,
        providerThreadId: "provider-thread-1",
        data: JSON.stringify({}),
      },
      {
        threadId: otherThread.id,
        sequence: 1,
        type: "thread/goal/updated",
        ...threadEventFields,
        providerThreadId: "provider-thread-2",
        data: JSON.stringify({
          objective: "Active goal",
          status: "active",
          tokenBudget: null,
          tokensUsed: 2,
          timeUsedSeconds: 2,
        }),
      },
      {
        threadId: otherThread.id,
        sequence: 2,
        type: "thread/extensionState/updated",
        ...threadEventFields,
        providerThreadId: "provider-thread-2",
        data: JSON.stringify({
          kind: "provider-codex/goal",
          payload: {
            objective: "Newer goal",
            status: "active",
            tokenBudget: null,
            tokensUsed: 3,
            timeUsedSeconds: 3,
          },
        }),
      },
      {
        threadId: otherThread.id,
        sequence: 3,
        type: "thread/extensionState/updated",
        ...threadEventFields,
        providerThreadId: "provider-thread-2",
        data: JSON.stringify({ kind: "other-plugin/widget", payload: {} }),
      },
    ]);

    const rowsByThreadId = new Map(
      listLatestThreadStateEventRowsByThreadIds(db, {
        threadIds: [thread.id, otherThread.id, thread.id],
        kind: "provider-codex/goal",
      }).map((row) => [row.threadId, row]),
    );

    expect(rowsByThreadId.get(thread.id)?.type).toBe("thread/goal/cleared");
    expect(rowsByThreadId.get(thread.id)?.sequence).toBe(2);
    expect(rowsByThreadId.get(otherThread.id)?.type).toBe(
      "thread/extensionState/updated",
    );
    expect(rowsByThreadId.get(otherThread.id)?.sequence).toBe(2);
  });

  it("batches latest goal lookups above the SQLite variable limit", () => {
    const { db } = setup();
    const threadIds = Array.from(
      { length: 32_767 },
      (_, index) => `thr_missing_goal_${index}`,
    );

    expect(
      listLatestThreadStateEventRowsByThreadIds(db, {
        threadIds,
        kind: "provider-codex/goal",
      }),
    ).toEqual([]);
  });

  it("lists only open accepted turn inputs after the latest interruption", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-completed" }),
        data: JSON.stringify({ clientRequestId: "creq_23456789aa" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "turn/completed",
        ...createTurnEventFields({ turnId: "turn-completed" }),
        data: JSON.stringify({ status: "completed" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-interrupted" }),
        data: JSON.stringify({ clientRequestId: "creq_23456789ab" }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/thread/interrupted",
        ...threadEventFields,
        data: JSON.stringify({ reason: "user" }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-open" }),
        data: JSON.stringify({ clientRequestId: "creq_23456789ac" }),
      },
      {
        threadId: otherThread.id,
        sequence: 1,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-other-open" }),
        data: JSON.stringify({ clientRequestId: "creq_23456789ad" }),
      },
    ]);

    const rowsByThreadId = new Map(
      listOpenTurnInputAcceptedRowsByThreadIds(db, {
        threadIds: [thread.id, otherThread.id, thread.id],
      }).map((row) => [row.threadId, row]),
    );

    expect(rowsByThreadId.get(thread.id)?.sequence).toBe(5);
    expect(rowsByThreadId.get(otherThread.id)?.sequence).toBe(1);
  });

  it("lists client turn request rows by thread/request keys", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: clientTurnRequestData("creq_23456789aa", "first"),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/requested",
        ...threadEventFields,
        data: clientTurnRequestData("creq_23456789ab", "ignored"),
      },
      {
        threadId: otherThread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: clientTurnRequestData("creq_23456789aa", "same id elsewhere"),
      },
    ]);

    const rowsByThreadId = new Map(
      listStoredClientTurnRequestRowsByKeys(db, {
        keys: [
          { threadId: thread.id, requestId: "creq_23456789aa" },
          { threadId: otherThread.id, requestId: "creq_23456789aa" },
          { threadId: thread.id, requestId: "creq_23456789aa" },
        ],
      }).map((row) => [row.threadId, row]),
    );

    expect(rowsByThreadId.get(thread.id)?.sequence).toBe(1);
    expect(rowsByThreadId.get(otherThread.id)?.sequence).toBe(1);
    expect(rowsByThreadId.size).toBe(2);
  });

  it("batches client turn request keys above the expression-depth limit", () => {
    const { db, thread } = setup();
    const requestId = "creq_23456789ab";
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: clientTurnRequestData(requestId, "second batch"),
      },
    ]);
    const keys = [
      ...Array.from({ length: 995 }, (_, index) => ({
        requestId,
        threadId: `thr_missing_request_${index}`,
      })),
      { requestId, threadId: thread.id },
    ];

    expect(listStoredClientTurnRequestRowsByKeys(db, { keys })).toEqual([
      expect.objectContaining({ sequence: 1, threadId: thread.id }),
    ]);
  });

  it("lists client turn request ids in range with a storage predicate", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          direction: "outbound",
          requestId: "creq_23456789ab",
          source: "tell",
          initiator: "user",
          input: textInput("first"),
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "workspace-write",
            source: "client/turn/requested",
            serviceTier: "auto",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ code: "debug", message: "ignored" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          direction: "outbound",
          requestId: "creq_23456789ac",
          source: "tell",
          initiator: "user",
          input: textInput("second"),
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "workspace-write",
            source: "client/turn/requested",
            serviceTier: "auto",
          },
        }),
      },
      {
        threadId: otherThread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          direction: "outbound",
          requestId: "creq_23456789ad",
          source: "tell",
          initiator: "user",
          input: textInput("other thread"),
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "workspace-write",
            source: "client/turn/requested",
            serviceTier: "auto",
          },
        }),
      },
    ]);

    expect(
      listStoredClientTurnRequestIdsInRange(db, {
        threadId: thread.id,
        seqStart: 1,
        seqEnd: 3,
      }),
    ).toEqual(["creq_23456789ab", "creq_23456789ac"]);
    expect(
      listStoredClientTurnRequestIdsInRange(db, {
        threadId: thread.id,
        seqStart: 2,
        seqEnd: 3,
      }),
    ).toEqual(["creq_23456789ac"]);
  });

  it("lists thread provisioning rows by provisioning id with a storage predicate", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread-provisioning",
        ...threadEventFields,
        data: JSON.stringify({
          provisioningId: "tpv-target",
          status: "active",
          environmentId: "env-1",
          entries: [],
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/thread-provisioning",
        ...threadEventFields,
        data: JSON.stringify({
          provisioningId: "tpv-other",
          status: "active",
          environmentId: "env-1",
          entries: [],
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "system/thread-provisioning",
        ...threadEventFields,
        data: JSON.stringify({
          provisioningId: "tpv-target",
          status: "completed",
          environmentId: "env-1",
          entries: [],
        }),
      },
    ]);

    expect(
      listStoredThreadProvisioningRowsByProvisioningId(db, {
        threadId: thread.id,
        provisioningId: "tpv-target",
      }).map((row) => row.sequence),
    ).toEqual([1, 3]);
  });

  it("appends stored thread events and exposes the latest thread runtime markers", () => {
    const { db, thread } = setup();

    const firstSequence = appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      type: "client/turn/requested",
      data: {
        direction: "outbound",
        source: "spawn",
        initiator: "user",
        senderThreadId: null,
        requestId: "creq_runtime",
        input: textInput("start"),
        target: { kind: "thread-start" },
        request: { method: "thread/start", params: {} },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "workspace-write",
          source: "client/turn/requested",
          serviceTier: "default",
        },
      },
    });

    const secondSequence = db.transaction(
      (tx) =>
        appendStoredThreadEventInTransaction(tx, {
          threadId: thread.id,
          scope: turnScope("turn_1"),
          providerThreadId: "provider_thr_1",
          type: "turn/started",
          data: {
            providerThreadId: "provider_thr_1",
          },
        }),
      { behavior: "immediate" },
    );

    expect(firstSequence).toBe(1);
    expect(secondSequence).toBe(2);
    expect(getActiveStoredTurnId(db, thread.id)).toBe("turn_1");
    expect(getLastStoredProviderThreadId(db, thread.id)).toBe("provider_thr_1");
    expect(getLastStoredTurnRequestEvent(db, thread.id)).toMatchObject({
      threadId: thread.id,
      sequence: 1,
      type: "client/turn/requested",
    });

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: turnScope("turn_1"),
      providerThreadId: "provider_thr_1",
      type: "turn/completed",
      data: {
        providerThreadId: "provider_thr_1",
        status: "completed",
      },
    });
    expect(getActiveStoredTurnId(db, thread.id)).toBeNull();
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: turnScope("turn_1"),
      providerThreadId: "provider_thr_1",
      type: "turn/started",
      data: {
        providerThreadId: "provider_thr_1",
      },
    });
    expect(getActiveStoredTurnId(db, thread.id)).toBeNull();
  });

  it("preserves the latest provider thread id after an environment directory update", () => {
    const { db, thread } = setup();

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      providerThreadId: "provider_old",
      type: "thread/identity",
      data: {
        providerThreadId: "provider_old",
      },
    });
    expect(getLastStoredProviderThreadId(db, thread.id)).toBe("provider_old");

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      type: "system/operation",
      data: {
        operation: "environment_directory_update",
        operationId: "evt_environment_switch",
        status: "completed",
        message: "Updated environment directory",
        metadata: {
          nextEnvironmentId: "env_next",
          nextPath: "/tmp/next",
          previousEnvironmentId: "env_previous",
          previousPath: "/tmp/previous",
        },
      },
    });
    expect(getLastStoredProviderThreadId(db, thread.id)).toBe("provider_old");
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: turnScope("turn_1"),
      providerThreadId: "provider_old",
      type: "turn/completed",
      data: {
        providerThreadId: "provider_old",
        status: "completed",
      },
    });
    expect(getLastStoredProviderThreadId(db, thread.id)).toBe("provider_old");

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      type: "system/operation",
      data: {
        operation: THREAD_CONTEXT_CLEAR_OPERATION,
        operationId: "evt_context_clear",
        status: "completed",
        message: "Context cleared",
      },
    });
    expect(getLastStoredProviderThreadId(db, thread.id)).toBeNull();

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      type: "system/operation",
      data: {
        operation: THREAD_CONTEXT_CLEAR_OPERATION,
        operationId: "evt_context_clear_again",
        status: "completed",
        message: "Context cleared",
      },
    });
    expect(getLastStoredProviderThreadId(db, thread.id)).toBeNull();

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      providerThreadId: "provider_new",
      type: "thread/identity",
      data: {
        providerThreadId: "provider_new",
      },
    });
    expect(getLastStoredProviderThreadId(db, thread.id)).toBe("provider_new");
  });

  it("omits provider identities before a clear from batched interruption state", () => {
    const { db, thread } = setup();

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      providerThreadId: "provider_old",
      type: "thread/identity",
      data: { providerThreadId: "provider_old" },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      type: "system/operation",
      data: {
        operation: THREAD_CONTEXT_CLEAR_OPERATION,
        operationId: "evt_context_clear",
        status: "completed",
        message: "Context cleared",
      },
    });

    expect(
      listThreadTurnInterruptionEventStates(db, { threadIds: [thread.id] }),
    ).toEqual([
      {
        activeTurnId: null,
        latestProviderThreadId: null,
        threadId: thread.id,
      },
    ]);
  });

  it("uses only the latest completed clear as the visible epoch boundary", () => {
    const { db, thread } = setup();
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      providerThreadId: "provider_old",
      type: "thread/identity",
      data: { providerThreadId: "provider_old" },
    });
    const failedSequence = appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      type: "system/operation",
      data: {
        operation: THREAD_CONTEXT_CLEAR_OPERATION,
        operationId: "failed_context_clear",
        status: "failed",
        message: "Clear failed",
      },
    });

    expect(getLastStoredProviderThreadId(db, thread.id)).toBe("provider_old");
    expect(
      getLatestCompletedThreadContextClearSequence(db, {
        threadId: thread.id,
      }),
    ).toBeNull();

    const completedSequence = appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: threadScope(),
      type: "system/operation",
      data: {
        operation: THREAD_CONTEXT_CLEAR_OPERATION,
        operationId: "completed_context_clear",
        status: "completed",
        message: "Context cleared",
      },
    });

    expect(
      getLatestCompletedThreadContextClearSequence(db, {
        atOrBeforeSequence: failedSequence,
        threadId: thread.id,
      }),
    ).toBeNull();
    expect(
      getLatestCompletedThreadContextClearSequence(db, {
        threadId: thread.id,
      }),
    ).toBe(completedSequence);
    expect(
      getLatestStoredConversationOutlineSequence(db, {
        threadId: thread.id,
      }),
    ).toBe(completedSequence);
    expect(
      listRecentStoredEventRows(db, {
        maxInlineOutputChars: null,
        sequenceStart: completedSequence,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([completedSequence]);
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(3);
  });

  it("ignores delegated child turn starts when reconstructing the active stored turn", () => {
    const { db, thread } = setup();

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: turnScope("root_turn"),
      providerThreadId: "provider_thr_1",
      type: "turn/started",
      data: {
        providerThreadId: "provider_thr_1",
      },
    });
    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: turnScope("child_turn"),
      providerThreadId: "provider_thr_1",
      type: "turn/started",
      data: {
        providerThreadId: "provider_thr_1",
        parentToolCallId: "delegation-1",
      },
    });

    expect(getActiveStoredTurnId(db, thread.id)).toBe("root_turn");

    appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      scope: turnScope("root_turn"),
      providerThreadId: "provider_thr_1",
      type: "turn/completed",
      data: {
        providerThreadId: "provider_thr_1",
        status: "completed",
      },
    });

    expect(getActiveStoredTurnId(db, thread.id)).toBeNull();
  });

  it("appends stored thread events in one transaction with per-thread sequences", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const sequences = db.transaction(
      (tx) =>
        appendStoredThreadEventsInTransaction(tx, [
          {
            threadId: thread.id,
            scope: turnScope("turn_1"),
            providerThreadId: "provider_thr_1",
            type: "turn/started",
            data: {
              providerThreadId: "provider_thr_1",
            },
          },
          {
            threadId: thread.id,
            scope: turnScope("turn_1"),
            providerThreadId: "provider_thr_1",
            type: "turn/completed",
            data: {
              providerThreadId: "provider_thr_1",
              status: "interrupted",
            },
          },
          {
            threadId: otherThread.id,
            scope: threadScope(),
            type: "system/thread/interrupted",
            data: {
              reason: "host-daemon-restarted",
            },
          },
        ]),
      { behavior: "immediate" },
    );

    expect(sequences).toEqual([1, 2, 1]);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 2]);
    expect(
      listEvents(db, { threadId: otherThread.id }).map(
        (event) => event.sequence,
      ),
    ).toEqual([1]);
  });

  it("lists completed turns for a specific thread set", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn_a"),
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider_a",
          turnId: "turn_a",
          status: "completed",
        }),
      },
      {
        threadId: otherThread.id,
        sequence: 1,
        scope: turnScope("turn_b"),
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider_b",
          turnId: "turn_b",
          status: "completed",
        }),
      },
    ]);

    expect(listCompletedTurnsByThreadIds(db, [thread.id])).toEqual([
      {
        threadId: thread.id,
        turnId: "turn_a",
      },
    ]);
  });

  it("lists active turn and latest provider state for thread interruption", () => {
    const { db, project, thread } = setup();
    const completedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const noProviderThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const noEventThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn_active"),
        providerThreadId: "provider_active",
        type: "turn/started",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider_active",
          turnId: "turn_active",
        }),
      },
      {
        threadId: completedThread.id,
        sequence: 1,
        scope: turnScope("turn_done"),
        providerThreadId: "provider_done",
        type: "turn/started",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider_done",
          turnId: "turn_done",
        }),
      },
      {
        threadId: completedThread.id,
        sequence: 2,
        scope: turnScope("turn_done"),
        providerThreadId: "provider_done",
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider_done",
          turnId: "turn_done",
          status: "completed",
        }),
      },
      {
        threadId: noProviderThread.id,
        sequence: 1,
        scope: turnScope("turn_no_provider"),
        providerThreadId: null,
        type: "turn/started",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: null,
          turnId: "turn_no_provider",
        }),
      },
    ]);

    expect(
      listThreadTurnInterruptionEventStates(db, {
        threadIds: [
          thread.id,
          completedThread.id,
          noProviderThread.id,
          noEventThread.id,
        ],
      }),
    ).toEqual([
      {
        activeTurnId: "turn_active",
        latestProviderThreadId: "provider_active",
        threadId: thread.id,
      },
      {
        activeTurnId: null,
        latestProviderThreadId: "provider_done",
        threadId: completedThread.id,
      },
      {
        activeTurnId: "turn_no_provider",
        latestProviderThreadId: null,
        threadId: noProviderThread.id,
      },
      {
        activeTurnId: null,
        latestProviderThreadId: null,
        threadId: noEventThread.id,
      },
    ]);
  });

  it("ignores delegated child turn starts for thread interruption active-turn lookup", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("root_turn"),
        providerThreadId: "provider_thr_1",
        type: "turn/started",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider_thr_1",
          turnId: "root_turn",
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("child_turn"),
        providerThreadId: "provider_thr_1",
        type: "turn/started",
        itemId: null,
        itemKind: null,
        parentToolCallId: "delegation-1",
        data: JSON.stringify({
          providerThreadId: "provider_thr_1",
          turnId: "child_turn",
          parentToolCallId: "delegation-1",
        }),
      },
    ]);

    expect(
      listThreadTurnInterruptionEventStates(db, {
        threadIds: [thread.id],
      }),
    ).toEqual([
      {
        activeTurnId: "root_turn",
        latestProviderThreadId: "provider_thr_1",
        threadId: thread.id,
      },
    ]);
  });

  it("returns high-water marks per thread", () => {
    const { db, project, thread } = setup();
    const thread2 = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread2.id,
        sequence: 3,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
    ]);

    const hwm = getHighWaterMarks(db);
    expect(hwm[thread.id]).toBe(5);
    expect(hwm[thread2.id]).toBe(3);
  });

  it("returns high-water marks for specific threads", () => {
    const { db, project, thread } = setup();
    const thread2 = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 10,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread2.id,
        sequence: 3,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
    ]);

    const hwm = getHighWaterMarks(db, [thread.id]);
    expect(hwm[thread.id]).toBe(10);
    expect(hwm[thread2.id]).toBeUndefined();
  });

  it("lists events after a given sequence", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
    ]);

    const after1 = listEvents(db, { threadId: thread.id, afterSequence: 1 });
    expect(after1).toHaveLength(2);
    expect(after1[0]!.sequence).toBe(2);
  });

  it("returns the latest sequence for a thread", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
    ]);

    expect(getLatestThreadSequence(db, { threadId: thread.id })).toBe(5);
  });

  it("prunes event types before a sequence cutoff and keeps recent rows", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
    ]);

    const latestSequence = getLatestThreadSequence(db, { threadId: thread.id });
    const removed = pruneThreadEventsBeforeSequence(db, {
      threadId: thread.id,
      sequenceCutoff: latestSequence - 2,
      types: ["thread/tokenUsage/updated"],
    });

    expect(removed).toBe(3);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([4, 5]);
  });

  it("prunes token-usage rows before a sequence cutoff but keeps the latest totals row and latest context row", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createTokenUsageData({
          totalTokens: 10,
          modelContextWindow: 200_000,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createTokenUsageData({
          totalTokens: 20,
          modelContextWindow: null,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createTokenUsageData({
          totalTokens: 30,
          modelContextWindow: null,
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createTokenUsageData({
          totalTokens: 40,
          modelContextWindow: null,
        }),
      },
    ]);

    const removed = pruneTokenUsageEventsBeforeSequence(db, {
      threadId: thread.id,
      sequenceCutoff: 4,
    });

    expect(removed).toBe(2);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 4]);
  });

  it("preserves root token usage instead of a newer nested-turn report while pruning", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-root" }),
        data: createTokenUsageData({
          totalTokens: 80_000,
          modelContextWindow: 200_000,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-root" }),
        data: createTokenUsageData({
          totalTokens: 90_000,
          modelContextWindow: null,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-subagent" }),
        parentToolCallId: "call-subagent",
        data: JSON.stringify({ parentToolCallId: "call-subagent" }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-subagent" }),
        data: createTokenUsageData({
          totalTokens: 15_000,
          modelContextWindow: 200_000,
        }),
      },
    ]);

    const removed = pruneTokenUsageEventsBeforeSequence(db, {
      threadId: thread.id,
      sequenceCutoff: 4,
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  it("prunes context-window rows before a sequence cutoff but keeps the latest usage row and latest context row", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          usedTokens: 10,
          modelContextWindow: 200_000,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          usedTokens: 20,
          modelContextWindow: null,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          usedTokens: 30,
          modelContextWindow: null,
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          usedTokens: 40,
          modelContextWindow: null,
        }),
      },
    ]);

    const removed = pruneContextWindowUsageEventsBeforeSequence(db, {
      threadId: thread.id,
      sequenceCutoff: 4,
    });

    expect(removed).toBe(2);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 4]);
  });

  it("prunes resolved assistant deltas but preserves the first delta row", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "!" }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "msg-1",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "msg-1",
            type: "agentMessage",
            text: "Hello!",
          },
        }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(2);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 4]);
  });

  it("bounds each resolved delta prune pass", () => {
    const { db, thread } = setup();
    const deltas = Array.from({ length: 502 }, (_, index) => ({
      threadId: thread.id,
      sequence: index + 1,
      scope: turnScope("turn-bounded-prune"),
      type: "item/agentMessage/delta" as const,
      itemId: "msg-bounded-prune",
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({
        itemId: "msg-bounded-prune",
        delta: `chunk-${index}`,
      }),
    }));
    insertEvents(db, noopNotifier, [
      ...deltas,
      {
        threadId: thread.id,
        sequence: 503,
        scope: turnScope("turn-bounded-prune"),
        type: "item/completed",
        itemId: "msg-bounded-prune",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "msg-bounded-prune",
            type: "agentMessage",
            text: "Complete response",
          },
        }),
      },
    ]);

    expect(pruneResolvedItemDeltas(db, { threadId: thread.id })).toBe(500);
    expect(pruneResolvedItemDeltas(db, { threadId: thread.id })).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 503]);
  });

  it("keeps unresolved assistant deltas", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "lo" }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(0);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 2]);
  });

  it("does not prune later-turn assistant deltas when the same item id is reused", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "msg-1",
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "msg-1",
            type: "agentMessage",
            text: "Hello",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-2"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "New " }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-2"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "answer" }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 3, 4, 5]);
  });

  it("does not prune same-turn assistant deltas for a different parent tool call", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: "tool-1",
        data: JSON.stringify({
          itemId: "msg-1",
          parentToolCallId: "tool-1",
          delta: "Hel",
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: "tool-1",
        data: JSON.stringify({
          itemId: "msg-1",
          parentToolCallId: "tool-1",
          delta: "lo",
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "msg-1",
        itemKind: "agentMessage",
        parentToolCallId: "tool-1",
        data: JSON.stringify({
          item: {
            id: "msg-1",
            type: "agentMessage",
            text: "Hello",
            parentToolCallId: "tool-1",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: "tool-2",
        data: JSON.stringify({
          itemId: "msg-1",
          parentToolCallId: "tool-2",
          delta: "New ",
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        parentToolCallId: "tool-2",
        data: JSON.stringify({
          itemId: "msg-1",
          parentToolCallId: "tool-2",
          delta: "answer",
        }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 3, 4, 5]);
  });

  it("prunes resolved command output deltas but preserves the first delta row", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "cmd-1",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf hello",
            cwd: "/workspace",
            status: "completed",
            approvalStatus: null,
            aggregatedOutput: "Hello",
            exitCode: 0,
          },
        }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 3]);
  });

  it("keeps command output deltas when completion has no aggregated output", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "cmd-1",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf hello",
            cwd: "/workspace",
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
          },
        }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(0);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  it("does not prune later-turn command deltas when the same item id is reused", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "cmd-1",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf hello",
            cwd: "/workspace",
            status: "completed",
            approvalStatus: null,
            aggregatedOutput: "Hello",
            exitCode: 0,
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-2"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "New " }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-2"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "output" }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 3, 4, 5]);
  });

  it("does not prune same-turn command deltas for a different parent tool call", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: "tool-1",
        data: JSON.stringify({
          itemId: "cmd-1",
          parentToolCallId: "tool-1",
          delta: "Hel",
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: "tool-1",
        data: JSON.stringify({
          itemId: "cmd-1",
          parentToolCallId: "tool-1",
          delta: "lo",
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "cmd-1",
        itemKind: "commandExecution",
        parentToolCallId: "tool-1",
        data: JSON.stringify({
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "printf hello",
            cwd: "/workspace",
            status: "completed",
            approvalStatus: null,
            aggregatedOutput: "Hello",
            exitCode: 0,
            parentToolCallId: "tool-1",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: "tool-2",
        data: JSON.stringify({
          itemId: "cmd-1",
          parentToolCallId: "tool-2",
          delta: "New ",
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        parentToolCallId: "tool-2",
        data: JSON.stringify({
          itemId: "cmd-1",
          parentToolCallId: "tool-2",
          delta: "output",
        }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 3, 4, 5]);
  });

  it("prunes resolved reasoning deltas but preserves the first delta row per stream type", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/reasoning/textDelta",
        itemId: "reasoning-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "raw " }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/reasoning/textDelta",
        itemId: "reasoning-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "content" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/reasoning/summaryTextDelta",
        itemId: "reasoning-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "summary " }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/reasoning/summaryTextDelta",
        itemId: "reasoning-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "content" }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "reasoning-1",
        itemKind: "reasoning",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: "reasoning-1",
            type: "reasoning",
            content: ["raw content"],
            summary: ["summary content"],
          },
        }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(2);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 3, 5]);
  });

  it("keeps unresolved reasoning deltas", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/reasoning/textDelta",
        itemId: "reasoning-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "raw " }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/reasoning/textDelta",
        itemId: "reasoning-1",
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "content" }),
      },
    ]);

    const removed = pruneResolvedItemDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(0);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 2]);
  });

  it("keeps only the latest backgroundTask progress row while the task runs", () => {
    const { db, thread } = setup();

    const progressData = (taskStatus: string) =>
      JSON.stringify({
        item: {
          id: "task:wf-1",
          type: "backgroundTask",
          taskType: "local_workflow",
          description: "fixture workflow",
          status: "pending",
          taskStatus,
          skipTranscript: false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: progressData("running"),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: progressData("running"),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: progressData("running"),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: progressData("running"),
      },
    ]);

    const removed = pruneBackgroundTaskProgressEvents(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(2);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 4]);
  });

  it("removes all backgroundTask progress rows once the completed event exists", () => {
    const { db, thread } = setup();

    const itemData = (taskStatus: string) =>
      JSON.stringify({
        item: {
          id: "task:wf-1",
          type: "backgroundTask",
          taskType: "local_workflow",
          description: "fixture workflow",
          status: taskStatus === "completed" ? "completed" : "pending",
          taskStatus,
          skipTranscript: false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: itemData("running"),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: itemData("running"),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: itemData("running"),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: threadScope(),
        type: "item/backgroundTask/completed",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: itemData("completed"),
      },
    ]);

    const removed = pruneBackgroundTaskProgressEvents(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(2);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([1, 4]);
  });

  it("prunes settled tasks without touching another in-flight task's rows", () => {
    const { db, thread } = setup();

    const taskData = (taskId: string) =>
      JSON.stringify({
        item: {
          id: taskId,
          type: "backgroundTask",
          taskType: "local_workflow",
          description: "fixture workflow",
          status: "pending",
          taskStatus: "running",
          skipTranscript: false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-1"),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-2",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-2"),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: threadScope(),
        type: "item/backgroundTask/completed",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-1"),
      },
    ]);

    const removed = pruneBackgroundTaskProgressEvents(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([2, 3]);
  });

  it("returns only the highest-sequence backgroundTask state row per item", () => {
    const { db, thread } = setup();

    const taskData = (itemId: string, taskStatus: string) =>
      JSON.stringify({
        item: {
          id: itemId,
          type: "backgroundTask",
          taskType: "local_workflow",
          description: "fixture workflow",
          status: taskStatus === "completed" ? "completed" : "pending",
          taskStatus,
          skipTranscript: false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-1", "running"),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-1", "running"),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-2",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-2", "running"),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: threadScope(),
        type: "item/backgroundTask/completed",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-1", "completed"),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-other",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-other", "running"),
      },
    ]);

    const rows = listLatestBackgroundTaskStateRowsByItemIds(db, {
      threadId: thread.id,
      itemIds: ["task:wf-1", "task:wf-2"],
    });

    expect(
      rows.map((row) => ({
        itemId: row.itemId,
        sequence: row.sequence,
        type: row.type,
      })),
    ).toEqual([
      {
        itemId: "task:wf-2",
        sequence: 3,
        type: "item/backgroundTask/progress",
      },
      {
        itemId: "task:wf-1",
        sequence: 4,
        type: "item/backgroundTask/completed",
      },
    ]);

    expect(
      listLatestBackgroundTaskStateRowsByItemIds(db, {
        threadId: thread.id,
        itemIds: [],
      }),
    ).toEqual([]);
  });

  it("returns latest non-terminal open backgroundTask state rows for a thread", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const taskData = (args: {
      itemId: string;
      itemStatus: "pending" | "completed";
      taskStatus: "running" | "completed";
      taskType: string;
    }) =>
      JSON.stringify({
        item: {
          id: args.itemId,
          type: "backgroundTask",
          taskType: args.taskType,
          description: "fixture background task",
          status: args.itemStatus,
          taskStatus: args.taskStatus,
          skipTranscript: false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-start-only",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-start-only",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-progress",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-progress",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-progress",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-progress",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-terminal-progress",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-terminal-progress",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-terminal-progress",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-terminal-progress",
          itemStatus: "completed",
          taskStatus: "completed",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 6,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-completed",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-completed",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 7,
        scope: threadScope(),
        type: "item/backgroundTask/completed",
        itemId: "task:wf-completed",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-completed",
          itemStatus: "completed",
          taskStatus: "completed",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 8,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:cmd-open",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:cmd-open",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: "local_bash",
        }),
      },
      {
        threadId: thread.id,
        sequence: 9,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:cmd-open",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:cmd-open",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: "local_bash",
        }),
      },
      {
        threadId: otherThread.id,
        sequence: 1,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:other-thread",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:other-thread",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
    ]);

    const rows = listLatestOpenBackgroundTaskStateRowsForThread(db, {
      threadId: thread.id,
    });

    expect(
      rows.map((row) => ({
        itemId: row.itemId,
        sequence: row.sequence,
        type: row.type,
      })),
    ).toEqual([
      {
        itemId: "task:wf-start-only",
        sequence: 1,
        type: "item/started",
      },
      {
        itemId: "task:wf-progress",
        sequence: 3,
        type: "item/backgroundTask/progress",
      },
      {
        itemId: "task:cmd-open",
        sequence: 9,
        type: "item/backgroundTask/progress",
      },
    ]);
  });

  it("counts active workflow, agent, subagent, and command snapshots by thread", () => {
    const { db, thread } = setup();

    const taskData = (args: {
      itemId: string;
      itemStatus: string;
      taskStatus: string;
      taskType: string;
      skipTranscript?: boolean;
    }) =>
      JSON.stringify({
        item: {
          id: args.itemId,
          type: "backgroundTask",
          taskType: args.taskType,
          description: "fixture background task",
          status: args.itemStatus,
          taskStatus: args.taskStatus,
          skipTranscript: args.skipTranscript ?? false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-active",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-active",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-active",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-active",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-terminal-progress",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-terminal-progress",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-terminal-progress",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-terminal-progress",
          itemStatus: "completed",
          taskStatus: "completed",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-completed",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-completed",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 6,
        scope: threadScope(),
        type: "item/backgroundTask/completed",
        itemId: "task:wf-completed",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-completed",
          itemStatus: "completed",
          taskStatus: "completed",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 7,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-skip-transcript",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:wf-skip-transcript",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_WORKFLOW_TASK_TYPE,
          skipTranscript: true,
        }),
      },
      {
        threadId: thread.id,
        sequence: 8,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:cmd-active",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:cmd-active",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_BASH_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 9,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:agent-active",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:agent-active",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_AGENT_TASK_TYPE,
        }),
      },
      {
        threadId: thread.id,
        sequence: 10,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:subagent-active",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData({
          itemId: "task:subagent-active",
          itemStatus: "pending",
          taskStatus: "running",
          taskType: LOCAL_SUBAGENT_TASK_TYPE,
        }),
      },
    ]);

    const countsByThreadId = new Map(
      listActiveBackgroundTaskCountsByThreadIds(db, {
        threadIds: [thread.id, thread.id],
      }).map((row) => [row.threadId, row]),
    );

    expect(countsByThreadId.get(thread.id)).toEqual({
      threadId: thread.id,
      activeWorkflowCount: 1,
      activeBackgroundAgentCount: 2,
      activeBackgroundCommandCount: 1,
    });
  });

  it("chunks thread IDs before SQLite reaches its variable limit", () => {
    const { db } = setup();
    const threadIds = Array.from(
      { length: 32_753 },
      (_, index) => `thr_missing_${index}`,
    );

    expect(
      listActiveBackgroundTaskCountsByThreadIds(db, { threadIds }),
    ).toEqual([]);
  });

  it("returns the same counts from chunked and unchunked thread IDs", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const taskData = (itemId: string, taskType: string) =>
      JSON.stringify({
        item: {
          id: itemId,
          type: "backgroundTask",
          taskType,
          description: "fixture background task",
          status: "pending",
          taskStatus: "running",
          skipTranscript: false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:workflow",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:workflow", LOCAL_WORKFLOW_TASK_TYPE),
      },
      {
        threadId: otherThread.id,
        sequence: 1,
        scope: turnScope("turn-2"),
        type: "item/started",
        itemId: "task:command",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:command", LOCAL_BASH_TASK_TYPE),
      },
    ]);

    const unchunkedRows = listActiveBackgroundTaskCountsByThreadIds(db, {
      threadIds: [thread.id, otherThread.id],
    });
    const missingThreadIds = Array.from(
      { length: 32_751 },
      (_, index) => `thr_missing_${index}`,
    );
    const chunkedRows = listActiveBackgroundTaskCountsByThreadIds(db, {
      threadIds: [thread.id, ...missingThreadIds, otherThread.id],
    });

    expect(chunkedRows).toEqual(unchunkedRows);
  });

  it("lists the latest lifecycle row per open backgroundTask item on a host", () => {
    const db = createMigratedConnection();
    const host = upsertHost(db, noopNotifier, {
      name: "task-host",
      type: "persistent",
    });
    const { project } = createProject(db, noopNotifier, {
      name: "task-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
    });
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "claude-code",
    });

    const taskData = (itemId: string, taskStatus: string) =>
      JSON.stringify({
        item: {
          id: itemId,
          type: "backgroundTask",
          taskType: "local_workflow",
          description: "fixture workflow",
          status: taskStatus === "completed" ? "completed" : "pending",
          taskStatus,
          skipTranscript: false,
        },
      });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-open",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-open", "running"),
      },
      {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-open",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-open", "running"),
      },
      {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        scope: threadScope(),
        type: "item/backgroundTask/progress",
        itemId: "task:wf-open",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-open", "paused"),
      },
      {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/started",
        itemId: "task:wf-done",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-done", "running"),
      },
      {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 5,
        scope: threadScope(),
        type: "item/backgroundTask/completed",
        itemId: "task:wf-done",
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: taskData("task:wf-done", "completed"),
      },
    ]);

    const rows = listOpenBackgroundTaskItemRowsForHost(db, {
      hostId: host.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: "task:wf-open",
      threadId: thread.id,
      environmentId: environment.id,
    });
    expect(JSON.parse(rows[0]!.data)).toMatchObject({
      item: { taskStatus: "paused" },
    });

    const otherHost = upsertHost(db, noopNotifier, {
      name: "other-host",
      type: "persistent",
    });
    expect(
      listOpenBackgroundTaskItemRowsForHost(db, { hostId: otherHost.id }),
    ).toEqual([]);
  });

  it("pruning is scoped to the target thread", () => {
    const { db, project, thread } = setup();
    const thread2 = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
      {
        threadId: thread2.id,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
      {
        threadId: thread2.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: "{}",
      },
    ]);

    const removed = pruneThreadEventsBeforeSequence(db, {
      threadId: thread.id,
      sequenceCutoff: 1,
      types: ["thread/tokenUsage/updated"],
    });

    expect(removed).toBe(1);
    expect(
      listEvents(db, { threadId: thread.id }).map((event) => event.sequence),
    ).toEqual([2]);
    expect(
      listEvents(db, { threadId: thread2.id }).map((event) => event.sequence),
    ).toEqual([1, 2]);
  });

  it("notifies on events-appended per thread", () => {
    const { db, project, thread } = setup();
    const thread2 = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    insertEvents(db, spy, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "client/turn/requested",
        ...threadEventFields,
        data: "{}",
      },
      {
        threadId: thread2.id,
        sequence: 1,
        type: "system/error",
        ...threadEventFields,
        data: "{}",
      },
    ]);

    expect(spy.notifyThread).toHaveBeenCalledWith(
      thread.id,
      ["events-appended"],
      {
        eventTypes: ["system/error", "client/turn/requested"],
      },
    );
    expect(spy.notifyThread).toHaveBeenCalledWith(
      thread2.id,
      ["events-appended"],
      {
        eventTypes: ["system/error"],
      },
    );
    expect(spy.notifyThread).toHaveBeenCalledTimes(2);
  });
});

describe("timeline read-boundary output truncation", () => {
  const maxInlineOutputChars = 1_000;

  function readWindowData(
    db: ReturnType<typeof setup>["db"],
    threadId: string,
    limit: number | null,
  ): Record<string, unknown> {
    const rows = listStoredTimelineWindowEventRows(db, {
      maxInlineOutputChars: limit,
      sequenceStart: 0,
      threadId,
    });
    const row = rows.at(-1);
    if (!row) {
      throw new Error("expected a window row");
    }
    return JSON.parse(row.data) as Record<string, unknown>;
  }

  it("measures the exact UTF-8 bytes returned by the capped read", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        ...threadEventFields,
        itemId: "cmd-bytes",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          note: "Unicode: 🐝",
          item: {
            type: "commandExecution",
            id: "cmd-bytes",
            command: "cat big",
            cwd: "/tmp/test",
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput: "x".repeat(maxInlineOutputChars + 500),
          },
        }),
      },
    ]);
    const args = {
      maxInlineOutputChars,
      sequenceStart: 0,
      threadId: thread.id,
    };
    const rows = listStoredTimelineWindowEventRows(db, args);

    expect(getStoredTimelineWindowEventDataBytes(db, args)).toBe(
      rows.reduce((total, row) => total + Buffer.byteLength(row.data), 0),
    );
  });

  it("finds the oldest row in the newest suffix that fits a byte budget", () => {
    const { db, thread } = setup();
    insertEvents(
      db,
      noopNotifier,
      [100, 200, 300].map((messageChars, index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type: "system/error" as const,
        ...threadEventFields,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ message: "x".repeat(messageChars) }),
      })),
    );
    const args = {
      maxInlineOutputChars: null,
      sequenceStart: 0,
      threadId: thread.id,
    };
    const rows = listStoredTimelineWindowEventRows(db, args);
    const rowBytes = new Map(
      rows.map((row) => [row.sequence, Buffer.byteLength(row.data)]),
    );
    const newestTwoBytes = (rowBytes.get(3) ?? 0) + (rowBytes.get(2) ?? 0);

    expect(
      findStoredTimelineWindowByteBudgetFloor(db, {
        ...args,
        maxDataBytes: newestTwoBytes,
      }),
    ).toEqual({
      eventDataBytes: newestTwoBytes,
      kind: "floor",
      sequenceStart: 2,
    });
    expect(
      findStoredTimelineWindowByteBudgetFloor(db, {
        ...args,
        maxDataBytes: getStoredTimelineWindowEventDataBytes(db, args),
      }),
    ).toEqual({
      eventDataBytes: getStoredTimelineWindowEventDataBytes(db, args),
      kind: "fits",
    });
    expect(
      findStoredTimelineWindowByteBudgetFloor(db, {
        ...args,
        maxDataBytes: (rowBytes.get(3) ?? 0) - 1,
      }),
    ).toEqual(expect.objectContaining({
      eventDataBytes: rowBytes.get(3),
      hasOlderRows: true,
      kind: "single-event-too-large",
      sequenceStart: 3,
      turnId: null,
    }));
  });

  it("bounds the byte-total preflight before using the early-stopping iterator", () => {
    const { db, thread } = setup();
    const validData = JSON.stringify({ message: "valid" });
    insertEvents(
      db,
      noopNotifier,
      Array.from(
        { length: STORED_TIMELINE_BYTE_PREFLIGHT_EVENT_LIMIT + 2 },
        (_, index) => ({
          threadId: thread.id,
          sequence: index + 1,
          type: "system/error" as const,
          ...threadEventFields,
          data: validData,
        }),
      ),
    );
    db.$client
      .prepare("UPDATE events SET data = ? WHERE thread_id = ? AND sequence = 1")
      .run(`{"item":{"resultText":"${"x".repeat(1_100)}`, thread.id);

    expect(
      findStoredTimelineWindowByteBudgetFloor(db, {
        maxDataBytes: 1,
        maxInlineOutputChars: 1_000,
        sequenceStart: 1,
        threadId: thread.id,
      }),
    ).toEqual({
      createdAt: expect.any(Number),
      eventDataBytes: Buffer.byteLength(validData),
      hasOlderRows: true,
      kind: "single-event-too-large",
      sequenceStart: STORED_TIMELINE_BYTE_PREFLIGHT_EVENT_LIMIT + 2,
      turnId: null,
    });
  });

  it.each(["floor", "single-event-too-large"] as const)(
    "releases its statement after a %s byte-cut result",
    (expectedKind) => {
      const { db, thread } = setup();
      insertEvents(
        db,
        noopNotifier,
        [100, 200].map((messageChars, index) => ({
          threadId: thread.id,
          sequence: index + 1,
          type: "system/error" as const,
          ...threadEventFields,
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ message: "x".repeat(messageChars) }),
        })),
      );
      const args = {
        maxInlineOutputChars: null,
        sequenceStart: 0,
        threadId: thread.id,
      };
      const newestRow = listStoredTimelineWindowEventRows(db, args).at(-1);
      if (!newestRow) {
        throw new Error("expected a newest event row");
      }
      const newestRowBytes = Buffer.byteLength(newestRow.data);

      expect(
        findStoredTimelineWindowByteBudgetFloor(db, {
          ...args,
          maxDataBytes:
            expectedKind === "floor" ? newestRowBytes : newestRowBytes - 1,
        }).kind,
      ).toBe(expectedKind);
      insertEvents(db, noopNotifier, [
        {
          threadId: thread.id,
          sequence: 3,
          type: "system/error",
          ...threadEventFields,
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ message: "write after byte-cut read" }),
        },
      ]);
      expect(getLatestThreadSequence(db, { threadId: thread.id })).toBe(3);
    },
  );

  it("shortens an oversized text output and leaves the rest of the payload alone", () => {
    const { db, thread } = setup();
    const output = "x".repeat(maxInlineOutputChars + 2_345);
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        ...threadEventFields,
        itemId: "cmd-1",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider-root",
          item: {
            type: "commandExecution",
            id: "cmd-1",
            command: "cat big",
            cwd: "/tmp/test",
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput: output,
          },
        }),
      },
    ]);

    const stored = readWindowData(db, thread.id, null);
    const capped = readWindowData(db, thread.id, maxInlineOutputChars);
    const storedItem = stored.item as Record<string, unknown>;
    const cappedItem = capped.item as Record<string, unknown>;

    expect(storedItem.aggregatedOutput).toBe(output);
    expect(cappedItem.aggregatedOutput).toBe(
      `${"x".repeat(maxInlineOutputChars)}\n\u2026[2,345 more characters truncated]`,
    );
    expect({ ...cappedItem, aggregatedOutput: null }).toEqual({
      ...storedItem,
      aggregatedOutput: null,
    });
  });

  it("leaves a non-text tool result untouched", () => {
    const { db, thread } = setup();
    const result = { rows: "y".repeat(maxInlineOutputChars + 500) };
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        ...threadEventFields,
        itemId: "tool-1",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider-root",
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "Read",
            status: "completed",
            result,
          },
        }),
      },
    ]);

    const capped = readWindowData(db, thread.id, maxInlineOutputChars);
    expect((capped.item as Record<string, unknown>).result).toEqual(result);
  });

  it("returns a payload under the cap exactly as stored", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        ...threadEventFields,
        itemId: "cmd-2",
        itemKind: "commandExecution",
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider-root",
          item: {
            type: "commandExecution",
            id: "cmd-2",
            command: "echo hi",
            cwd: "/tmp/test",
            status: "completed",
            approvalStatus: null,
            exitCode: 0,
            aggregatedOutput: "hi",
          },
        }),
      },
    ]);

    const rows = listStoredTimelineWindowEventRows(db, {
      maxInlineOutputChars,
      sequenceStart: 0,
      threadId: thread.id,
    });
    const stored = listStoredTimelineWindowEventRows(db, {
      maxInlineOutputChars: null,
      sequenceStart: 0,
      threadId: thread.id,
    });
    expect(rows.at(-1)?.data).toBe(stored.at(-1)?.data);
  });
});

describe("findUnfinishedTurnCoveringSequence", () => {
  it("names the unfinished turn a mid-turn cut would land in", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-open" }),
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "item/completed",
        ...createTurnEventFields({ turnId: "turn-open" }),
        data: JSON.stringify({
          providerThreadId: "provider-root",
          item: {
            type: "agentMessage",
            id: "m1",
            text: "still going",
          },
        }),
      },
    ]);

    expect(
      findUnfinishedTurnCoveringSequence(db, {
        sequence: 2,
        threadId: thread.id,
      }),
    ).toBe("turn-open");
  });

  it("refuses a cut that a finished turn would be split by", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-done" }),
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: 9,
        type: "turn/completed",
        ...createTurnEventFields({ turnId: "turn-done" }),
        data: JSON.stringify({
          status: "completed",
          providerThreadId: "provider-root",
        }),
      },
    ]);

    expect(
      findUnfinishedTurnCoveringSequence(db, {
        sequence: 2,
        threadId: thread.id,
      }),
    ).toBeNull();
  });

  it("refuses a cut that lands outside any turn", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-done" }),
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "turn/completed",
        ...createTurnEventFields({ turnId: "turn-done" }),
        data: JSON.stringify({
          status: "completed",
          providerThreadId: "provider-root",
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "after the turn" }),
      },
    ]);

    expect(
      findUnfinishedTurnCoveringSequence(db, {
        sequence: 3,
        threadId: thread.id,
      }),
    ).toBeNull();
  });

  it("refuses a cut spanning more than one turn", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-a" }),
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-b" }),
        data: JSON.stringify({}),
      },
    ]);

    expect(
      findUnfinishedTurnCoveringSequence(db, {
        sequence: 1,
        threadId: thread.id,
      }),
    ).toBeNull();
  });
});

describe("hasParentedEventCrossingSequence", () => {
  it("finds a child event whose tool-call parent began below the cut", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/completed",
        ...createTurnEventFields({ turnId: "turn-open" }),
        itemId: "parent-call",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: "parent-call",
            tool: "Agent",
            arguments: {},
            result: "",
            status: "completed",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        ...createTurnEventFields({ turnId: "child-turn" }),
        itemId: "child-message",
        itemKind: "agentMessage",
        parentToolCallId: "parent-call",
        data: JSON.stringify({
          item: {
            type: "agentMessage",
            id: "child-message",
            parentToolCallId: "parent-call",
            text: "child output",
          },
        }),
      },
    ]);

    expect(
      hasParentedEventCrossingSequence(db, {
        sequence: 2,
        threadId: thread.id,
      }),
    ).toBe(true);
    expect(
      hasParentedEventCrossingSequence(db, {
        sequence: 4,
        threadId: thread.id,
      }),
    ).toBe(false);
  });

  it("ignores ordinary events and parents on the same side of the cut", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        ...createTurnEventFields({ turnId: "turn-open" }),
        itemId: "parent-call",
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: "parent-call",
            tool: "Agent",
            arguments: {},
            result: "",
            status: "completed",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        ...createTurnEventFields({ turnId: "child-turn" }),
        itemId: "child-message",
        itemKind: "agentMessage",
        parentToolCallId: "parent-call",
        data: JSON.stringify({
          item: {
            type: "agentMessage",
            id: "child-message",
            parentToolCallId: "parent-call",
            text: "child output",
          },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "ordinary row" }),
      },
    ]);

    expect(
      hasParentedEventCrossingSequence(db, {
        sequence: 2,
        threadId: thread.id,
      }),
    ).toBe(false);
  });
});
