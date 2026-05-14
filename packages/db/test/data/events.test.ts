import { describe, expect, it, vi } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  appendDaemonEventsInTransaction,
  appendStoredThreadEvent,
  appendStoredThreadEventInTransaction,
  appendStoredThreadEventsInTransaction,
  findStoredEventRow,
  getActiveStoredTurnId,
  getHighWaterMarks,
  getLastStoredProviderThreadId,
  getLastStoredTurnId,
  getLastStoredTurnRequestEvent,
  getLatestThreadOutputEventRow,
  getLatestThreadSequence,
  insertEvents,
  listContextWindowUsageRows,
  listCompletedTurnsByThreadIds,
  listEvents,
  listFilteredStoredEventRows,
  listRecentStoredEventRows,
  listStandardTimelineSegmentAnchorRows,
  listStoredClientTurnRequestIdsInRange,
  listStoredEventRows,
  listStoredEventRowsInRange,
  listStoredEventRowsByThreadSequences,
  listStoredThreadProvisioningRowsByProvisioningId,
  listStoredTimelineWindowEventRows,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  MissingStoredTurnStartedError,
  listThreadTurnInterruptionEventStates,
  pruneContextWindowUsageEventsBeforeSequence,
  pruneTokenUsageEventsBeforeSequence,
  pruneResolvedItemDeltas,
  pruneThreadEventsBeforeSequence,
  ProducerEventPayloadMismatchError,
  type StoredEventRowTypeFilter,
} from "../../src/data/events.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
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
} as const;

const threadEventFields = {
  ...emptyItemFields,
  scope: threadScope(),
};

const managerConversationTimelineTestFilter = {
  eventTypes: [
    "client/turn/requested",
    "provider/error",
    "provider/unhandled",
    "provider/warning",
    "system/manager/user_message",
    "system/operation",
    "system/permissionGrant/lifecycle",
    "system/thread/interrupted",
    "system/thread-provisioning",
    "thread/compacted",
    "turn/completed",
    "turn/input/accepted",
    "turn/started",
  ],
  itemEventTypes: ["item/completed", "item/started"],
  itemKinds: ["contextCompaction"],
} as const satisfies StoredEventRowTypeFilter;

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

    // Same threadId + sequence should be ignored
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
    }); // only sequence 2 inserted

    const all = listEvents(db, { threadId: thread.id });
    expect(all).toHaveLength(2);
    // Original data preserved for sequence 1
    expect(JSON.parse(all[0]!.data)).toMatchObject({ message: "first" });
  });

  it("appends daemon events with server-owned sequences and producer identities", () => {
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
            producerEventId: "hdevt_23456789abcdefghijkm",
            producerEventPayloadHash: "hash-a",
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "first daemon" }),
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
            producerEventPayloadHash: "hash-b",
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
          producerEventId: "hdevt_23456789abcdefghijkm",
          threadId: thread.id,
          sequence: 6,
        },
        {
          producerEventId: "hdevt_23456789abcdefghijkn",
          threadId: thread.id,
          sequence: 7,
        },
      ],
      insertedInputIndexes: [0, 1],
    });
    expect(listEvents(db, { threadId: thread.id })).toMatchObject([
      { sequence: 5, producerEventId: null },
      {
        sequence: 6,
        producerEventId: "hdevt_23456789abcdefghijkm",
        producerEventPayloadHash: "hash-a",
      },
      {
        sequence: 7,
        producerEventId: "hdevt_23456789abcdefghijkn",
        producerEventPayloadHash: "hash-b",
      },
    ]);
  });

  it("rejects daemon turn-scoped events before turn/started is stored", () => {
    const { db, thread } = setup();

    expect(() =>
      db.transaction(
        (tx) =>
          appendDaemonEventsInTransaction(tx, [
            {
              producerEventId: "hdevt_23456789abcdefghijkt",
              producerEventPayloadHash: "hash-missing-start",
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
              producerEventId: "hdevt_23456789abcdefghijkv",
              producerEventPayloadHash: "hash-before-start",
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
              producerEventId: "hdevt_23456789abcdefghijkw",
              producerEventPayloadHash: "hash-late-start",
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

  it("accepts daemon turn-scoped events after earlier turn/started in the same batch", () => {
    const { db, thread } = setup();

    const result = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            producerEventId: "hdevt_23456789abcdefghijkx",
            producerEventPayloadHash: "hash-start",
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
            producerEventId: "hdevt_23456789abcdefghijky",
            producerEventPayloadHash: "hash-completed",
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
        { producerEventId: "hdevt_23456789abcdefghijkx", sequence: 1 },
        { producerEventId: "hdevt_23456789abcdefghijky", sequence: 2 },
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
            producerEventId: "hdevt_23456789abcdefghijkz",
            producerEventPayloadHash: "hash-prior-start",
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
            producerEventId: "hdevt_23456789abcdefghijk2",
            producerEventPayloadHash: "hash-prior-completed",
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
      acceptedEvents: [
        { producerEventId: "hdevt_23456789abcdefghijk2", sequence: 2 },
      ],
      insertedInputIndexes: [0],
    });
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(2);
  });

  it("accepts daemon turn-scoped retries idempotently by producerEventId and payload hash", () => {
    const { db, thread } = setup();

    db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            producerEventId: "hdevt_23456789abcdefghijk3",
            producerEventPayloadHash: "hash-retry-start",
            threadId: thread.id,
            type: "turn/started",
            ...createTurnEventFields({ turnId: "turn_retry" }),
            environmentId: null,
            providerThreadId: "provider_thr_retry",
            data: JSON.stringify({
              providerThreadId: "provider_thr_retry",
              turnId: "turn_retry",
            }),
          },
          {
            producerEventId: "hdevt_23456789abcdefghijk4",
            producerEventPayloadHash: "hash-retry-completed",
            threadId: thread.id,
            type: "turn/completed",
            ...createTurnEventFields({ turnId: "turn_retry" }),
            environmentId: null,
            providerThreadId: "provider_thr_retry",
            data: JSON.stringify({
              providerThreadId: "provider_thr_retry",
              status: "completed",
              turnId: "turn_retry",
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    const retry = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            producerEventId: "hdevt_23456789abcdefghijk4",
            producerEventPayloadHash: "hash-retry-completed",
            threadId: thread.id,
            type: "turn/completed",
            ...createTurnEventFields({ turnId: "turn_retry" }),
            environmentId: null,
            providerThreadId: "provider_thr_retry",
            data: JSON.stringify({
              providerThreadId: "provider_thr_retry",
              status: "completed",
              turnId: "turn_retry",
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(retry).toEqual({
      acceptedEvents: [
        {
          producerEventId: "hdevt_23456789abcdefghijk4",
          threadId: thread.id,
          sequence: 2,
        },
      ],
      insertedInputIndexes: [],
    });
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(2);
  });

  it("accepts daemon retries idempotently by producerEventId and payload hash", () => {
    const { db, thread } = setup();

    db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            producerEventPayloadHash: "hash-a",
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "first daemon" }),
          },
        ]),
      { behavior: "immediate" },
    );

    const retry = db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            producerEventPayloadHash: "hash-a",
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "first daemon" }),
          },
          {
            producerEventId: "hdevt_23456789abcdefghijkn",
            producerEventPayloadHash: "hash-b",
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "second daemon" }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(retry).toEqual({
      acceptedEvents: [
        {
          producerEventId: "hdevt_23456789abcdefghijkm",
          threadId: thread.id,
          sequence: 1,
        },
        {
          producerEventId: "hdevt_23456789abcdefghijkn",
          threadId: thread.id,
          sequence: 2,
        },
      ],
      insertedInputIndexes: [1],
    });
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(2);
  });

  it("rejects daemon producerEventId retries with a different payload hash", () => {
    const { db, thread } = setup();

    db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            producerEventPayloadHash: "hash-a",
            threadId: thread.id,
            type: "system/error",
            ...daemonThreadEventFields,
            data: JSON.stringify({ message: "first daemon" }),
          },
        ]),
      { behavior: "immediate" },
    );

    expect(() =>
      db.transaction(
        (tx) =>
          appendDaemonEventsInTransaction(tx, [
            {
              producerEventId: "hdevt_23456789abcdefghijkm",
              producerEventPayloadHash: "hash-b",
              threadId: thread.id,
              type: "system/error",
              ...daemonThreadEventFields,
              data: JSON.stringify({ message: "second daemon" }),
            },
          ]),
        { behavior: "immediate" },
      ),
    ).toThrow(ProducerEventPayloadMismatchError);
    expect(listEvents(db, { threadId: thread.id })).toHaveLength(1);
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

  it("chunks stored event row lookups by thread sequence", () => {
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
        sequence: 600,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "middle" }),
      },
      {
        threadId: thread.id,
        sequence: 1_200,
        type: "system/error",
        ...threadEventFields,
        data: JSON.stringify({ message: "last" }),
      },
    ]);

    const keys = Array.from({ length: 1_200 }, (_entry, index) => ({
      threadId: thread.id,
      sequence: index + 1,
    }));

    expect(
      listStoredEventRowsByThreadSequences(db, { keys }).map(
        (row) => row.sequence,
      ),
    ).toEqual([1, 600, 1_200]);
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
      listStoredEventRowsInRange(db, {
        seqEnd: 2,
        seqStart: 1,
        threadId: thread.id,
      }),
    ).toHaveLength(2);

    expect(
      listRecentStoredEventRows(db, {
        excludedTypes: ["system/error"],
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3]);

    expect(
      listContextWindowUsageRows(db, {
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3]);
  });

  it("lists only rows needed by manager conversation timelines", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({ input: [{ type: "text", text: "request" }] }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "turn/started",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/started",
        scope: turnScope("turn-1"),
        itemId: "compaction-1",
        itemKind: "contextCompaction",
        data: JSON.stringify({
          item: { id: "compaction-1", type: "contextCompaction" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "cmd-1",
        itemKind: "commandExecution",
        data: JSON.stringify({
          item: { id: "cmd-1", type: "commandExecution" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "msg-1",
        itemKind: "agentMessage",
        data: JSON.stringify({
          item: { id: "msg-1", type: "agentMessage", text: "internal" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 6,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "compaction-1",
        itemKind: "contextCompaction",
        data: JSON.stringify({
          item: { id: "compaction-1", type: "contextCompaction" },
        }),
      },
      {
        threadId: thread.id,
        sequence: 7,
        type: "system/manager/user_message",
        ...threadEventFields,
        data: JSON.stringify({ text: "manager-visible" }),
      },
      {
        threadId: thread.id,
        sequence: 8,
        type: "system/operation",
        ...threadEventFields,
        data: JSON.stringify({ title: "operation" }),
      },
      {
        threadId: thread.id,
        sequence: 9,
        type: "provider/warning",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: JSON.stringify({ message: "warning" }),
      },
      {
        threadId: thread.id,
        sequence: 10,
        type: "provider/error",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: JSON.stringify({ message: "provider error" }),
      },
      {
        threadId: thread.id,
        sequence: 11,
        type: "provider/unhandled",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: JSON.stringify({ message: "provider unhandled" }),
      },
      {
        threadId: thread.id,
        sequence: 12,
        type: "system/permissionGrant/lifecycle",
        ...threadEventFields,
        data: JSON.stringify({ status: "pending" }),
      },
      {
        threadId: thread.id,
        sequence: 13,
        type: "system/thread/interrupted",
        ...threadEventFields,
        data: JSON.stringify({ reason: "user-requested" }),
      },
      {
        threadId: thread.id,
        sequence: 14,
        type: "system/thread-provisioning",
        ...threadEventFields,
        data: JSON.stringify({ stage: "started" }),
      },
      {
        threadId: thread.id,
        sequence: 15,
        type: "thread/compacted",
        ...threadEventFields,
        data: JSON.stringify({}),
      },
      {
        threadId: thread.id,
        sequence: 16,
        type: "turn/input/accepted",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: JSON.stringify({ clientRequestId: "creq_23456789ab" }),
      },
      {
        threadId: thread.id,
        sequence: 17,
        type: "turn/completed",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: JSON.stringify({ status: "completed" }),
      },
      {
        threadId: thread.id,
        sequence: 18,
        type: "thread/contextWindowUsage/updated",
        ...createTurnEventFields({ turnId: "turn-1" }),
        data: createContextWindowUsageData({
          modelContextWindow: 16_000,
          usedTokens: 100,
        }),
      },
    ]);

    expect(
      listFilteredStoredEventRows(db, {
        filter: managerConversationTimelineTestFilter,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("lists standard timeline segment anchors with SQL-visible request rules", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        ...threadEventFields,
        data: JSON.stringify({
          initiator: "user",
          input: [{ type: "text", text: "user message" }],
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
          input: [{ type: "text", text: "system message" }],
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
          input: [{ type: "text", text: "accepted steer" }],
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
          input: [{ type: "text", text: "auto new turn" }],
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
          input: [{ type: "text", text: "explicit steer" }],
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
          input: [{ type: "text", text: "" }],
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
          input: [{ type: "text", text: "legacy target" }],
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
    ]);

    const userVisibleAnchors = listStandardTimelineSegmentAnchorRows(db, {
      includeSystemClientRequests: false,
      threadId: thread.id,
    });
    expect(userVisibleAnchors).toEqual([
      { rowId: `${thread.id}:user-seed:1`, sequence: 1 },
      { rowId: `${thread.id}:user-seed:4`, sequence: 4 },
      { rowId: `${thread.id}:user-seed:7`, sequence: 7 },
      { rowId: `${thread.id}:user-seed:8`, sequence: 8 },
      { rowId: `${thread.id}:user-seed:9`, sequence: 9 },
      { rowId: `${thread.id}:user-seed:10`, sequence: 10 },
    ]);

    expect(
      listStandardTimelineSegmentAnchorRows(db, {
        includeSystemClientRequests: true,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([1, 2, 4, 7, 8, 9, 10]);
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
        sequenceStart: 2,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([3]);

    expect(
      listStoredTimelineWindowEventRows(db, {
        excludedTypes: [],
        sequenceStart: 2,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3, 4]);

    expect(
      listStoredTimelineWindowEventRows(db, {
        beforeSequence: 4,
        sequenceStart: 2,
        threadId: thread.id,
      }).map((row) => row.sequence),
    ).toEqual([2, 3]);
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
          input: [{ type: "text", text: "first" }],
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
          input: [{ type: "text", text: "second" }],
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
          input: [{ type: "text", text: "first" }],
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
          input: [{ type: "text", text: "second" }],
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
          input: [{ type: "text", text: "other thread" }],
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
        requestId: "creq_runtime",
        input: [{ type: "text", text: "start" }],
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
    expect(getLastStoredTurnId(db, thread.id)).toBe("turn_1");
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
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "!" }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "msg-1",
        itemKind: "agentMessage",
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
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
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
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "msg-1",
        itemKind: "agentMessage",
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
        data: JSON.stringify({ itemId: "msg-1", delta: "New " }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-2"),
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
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
        data: JSON.stringify({ itemId: "cmd-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "cmd-1",
        itemKind: "commandExecution",
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
        data: JSON.stringify({ itemId: "cmd-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "cmd-1",
        itemKind: "commandExecution",
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
        data: JSON.stringify({ itemId: "cmd-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "cmd-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "cmd-1",
        itemKind: "commandExecution",
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
        data: JSON.stringify({ itemId: "cmd-1", delta: "New " }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-2"),
        type: "item/commandExecution/outputDelta",
        itemId: "cmd-1",
        itemKind: null,
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
        data: JSON.stringify({ itemId: "reasoning-1", delta: "raw " }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/reasoning/textDelta",
        itemId: "reasoning-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "content" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope("turn-1"),
        type: "item/reasoning/summaryTextDelta",
        itemId: "reasoning-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "summary " }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-1"),
        type: "item/reasoning/summaryTextDelta",
        itemId: "reasoning-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "reasoning-1", delta: "content" }),
      },
      {
        threadId: thread.id,
        sequence: 5,
        scope: turnScope("turn-1"),
        type: "item/completed",
        itemId: "reasoning-1",
        itemKind: "reasoning",
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
        data: JSON.stringify({ itemId: "reasoning-1", delta: "raw " }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        scope: turnScope("turn-1"),
        type: "item/reasoning/textDelta",
        itemId: "reasoning-1",
        itemKind: null,
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
      notifyCommand: vi.fn(),
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
