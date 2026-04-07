import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  appendStoredThreadEvent,
  appendStoredThreadEventInTransaction,
  findStoredEventRow,
  getHighWaterMarks,
  getLastStoredProviderThreadId,
  getLastStoredTurnId,
  getLastStoredTurnRequestEvent,
  getLatestThreadOutputEventRow,
  getLatestThreadSequence,
  insertEvents,
  listCompletedTurnsByThreadIds,
  listEvents,
  listRecentStoredEventRows,
  listStoredEventRows,
  listStoredEventRowsInRange,
  listTokenUsageRowsForContextWindowUsage,
  pruneTokenUsageEventsBeforeSequence,
  pruneResolvedAgentMessageDeltas,
  pruneThreadEventsBeforeSequence,
} from "../../src/data/events.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "test-host", type: "persistent" });
  const { project } = createProject(db, noopNotifier, { name: "test-project", source: { type: "local_path", hostId: host.id, path: "/tmp/test" } });
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

interface CreateTokenUsageDataArgs {
  modelContextWindow: number | null;
  totalTokens: number;
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

describe("events", () => {
  it("inserts events and returns count", () => {
    const { db, thread } = setup();

    const result = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...emptyItemFields,
        data: JSON.stringify({ message: "test" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...emptyItemFields,
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

  it("deduplicates on (threadId, sequence)", () => {
    const { db, thread } = setup();

    const result1 = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...emptyItemFields,
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
        ...emptyItemFields,
        data: JSON.stringify({ message: "duplicate" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...emptyItemFields,
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

  it("stores the provided createdAt timestamp", () => {
    const { db, thread } = setup();
    const createdAt = 1_700_000_000_000;

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        ...emptyItemFields,
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
        ...emptyItemFields,
        data: JSON.stringify({ message: "first" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        ...emptyItemFields,
        data: JSON.stringify({ message: "second" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "turn/started",
        ...emptyItemFields,
        data: JSON.stringify({ turnId: "turn_1" }),
      },
    ]);

    expect(listStoredEventRows(db, {
      afterSequence: 1,
      limit: 1,
      threadId: thread.id,
    })).toMatchObject([
      {
        sequence: 2,
        type: "system/error",
      },
    ]);

    expect(findStoredEventRow(db, {
      afterSequence: 1,
      threadId: thread.id,
      type: "system/error",
    })).toMatchObject({
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
        ...emptyItemFields,
        data: JSON.stringify({ text: "manager output" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        itemId: "msg_1",
        itemKind: "agentMessage",
        data: JSON.stringify({ item: { id: "msg_1", type: "agentMessage", text: "assistant output" } }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/completed",
        itemId: "call_1",
        itemKind: "toolCall",
        data: JSON.stringify({ item: { id: "call_1", type: "toolCall" } }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "system/error",
        ...emptyItemFields,
        data: JSON.stringify({ message: "ignored" }),
      },
    ]);

    expect(getLatestThreadOutputEventRow(db, { threadId: thread.id })).toMatchObject({
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
        ...emptyItemFields,
        data: JSON.stringify({ text: "manager output" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        itemId: "msg_1",
        itemKind: "agentMessage",
        data: JSON.stringify({ item: { id: "msg_1", type: "agentMessage", text: "" } }),
      },
    ]);

    expect(getLatestThreadOutputEventRow(db, { threadId: thread.id })).toMatchObject({
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
        ...emptyItemFields,
        data: JSON.stringify({ message: "first" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: createTokenUsageData({
          modelContextWindow: 16_000,
          totalTokens: 100,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: createTokenUsageData({
          modelContextWindow: null,
          totalTokens: 200,
        }),
      },
    ]);

    expect(listStoredEventRowsInRange(db, {
      seqEnd: 2,
      seqStart: 1,
      threadId: thread.id,
    })).toHaveLength(2);

    expect(listRecentStoredEventRows(db, {
      excludedTypes: ["system/error"],
      threadId: thread.id,
    }).map((row) => row.sequence)).toEqual([2, 3]);

    expect(listTokenUsageRowsForContextWindowUsage(db, {
      threadId: thread.id,
    }).map((row) => row.sequence)).toEqual([2, 3]);
  });

  it("appends stored thread events and exposes the latest thread runtime markers", () => {
    const { db, thread } = setup();

    const firstSequence = appendStoredThreadEvent(db, noopNotifier, {
      threadId: thread.id,
      type: "client/thread/start",
      data: {
        direction: "outbound",
        source: "spawn",
        initiator: "user",
        input: [{ type: "text", text: "start" }],
        request: { method: "thread/start", params: {} },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          sandboxMode: "workspace-write",
          source: "client/thread/start",
          serviceTier: "auto",
        },
      },
    });

    const secondSequence = db.transaction((tx) =>
      appendStoredThreadEventInTransaction(tx, {
        threadId: thread.id,
        turnId: "turn_1",
        providerThreadId: "provider_thr_1",
        type: "turn/started",
        data: {
          providerThreadId: "provider_thr_1",
          turnId: "turn_1",
        },
      }), { behavior: "immediate" });

    expect(firstSequence).toBe(1);
    expect(secondSequence).toBe(2);
    expect(getLastStoredTurnId(db, thread.id)).toBe("turn_1");
    expect(getLastStoredProviderThreadId(db, thread.id)).toBe("provider_thr_1");
    expect(getLastStoredTurnRequestEvent(db, thread.id)).toMatchObject({
      threadId: thread.id,
      sequence: 1,
      type: "client/thread/start",
    });
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
        turnId: "turn_a",
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
        turnId: "turn_b",
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

  it("returns high-water marks per thread", () => {
    const { db, project, thread } = setup();
    const thread2 = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      { threadId: thread.id, sequence: 1, type: "system/error", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 5, type: "system/error", ...emptyItemFields, data: "{}" },
      { threadId: thread2.id, sequence: 3, type: "system/error", ...emptyItemFields, data: "{}" },
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
      { threadId: thread.id, sequence: 10, type: "system/error", ...emptyItemFields, data: "{}" },
      { threadId: thread2.id, sequence: 3, type: "system/error", ...emptyItemFields, data: "{}" },
    ]);

    const hwm = getHighWaterMarks(db, [thread.id]);
    expect(hwm[thread.id]).toBe(10);
    expect(hwm[thread2.id]).toBeUndefined();
  });

  it("lists events after a given sequence", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      { threadId: thread.id, sequence: 1, type: "system/error", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 2, type: "system/error", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 3, type: "system/error", ...emptyItemFields, data: "{}" },
    ]);

    const after1 = listEvents(db, { threadId: thread.id, afterSequence: 1 });
    expect(after1).toHaveLength(2);
    expect(after1[0]!.sequence).toBe(2);
  });

  it("returns the latest sequence for a thread", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      { threadId: thread.id, sequence: 2, type: "system/error", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 5, type: "system/error", ...emptyItemFields, data: "{}" },
    ]);

    expect(getLatestThreadSequence(db, { threadId: thread.id })).toBe(5);
  });

  it("prunes event types before a sequence cutoff and keeps recent rows", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      { threadId: thread.id, sequence: 1, type: "thread/tokenUsage/updated", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 2, type: "thread/tokenUsage/updated", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 3, type: "thread/tokenUsage/updated", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 4, type: "thread/tokenUsage/updated", ...emptyItemFields, data: "{}" },
      { threadId: thread.id, sequence: 5, type: "thread/tokenUsage/updated", ...emptyItemFields, data: "{}" },
    ]);

    const latestSequence = getLatestThreadSequence(db, { threadId: thread.id });
    const removed = pruneThreadEventsBeforeSequence(db, {
      threadId: thread.id,
      sequenceCutoff: latestSequence - 2,
      types: ["thread/tokenUsage/updated"],
    });

    expect(removed).toBe(3);
    expect(listEvents(db, { threadId: thread.id }).map((event) => event.sequence)).toEqual([4, 5]);
  });

  it("prunes token-usage rows before a sequence cutoff but keeps the latest totals row and latest context row", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: createTokenUsageData({
          totalTokens: 10,
          modelContextWindow: 200_000,
        }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: createTokenUsageData({
          totalTokens: 20,
          modelContextWindow: null,
        }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: createTokenUsageData({
          totalTokens: 30,
          modelContextWindow: null,
        }),
      },
      {
        threadId: thread.id,
        sequence: 4,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
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
    expect(listEvents(db, { threadId: thread.id }).map((event) => event.sequence)).toEqual([1, 4]);
  });

  it("prunes resolved assistant deltas but preserves the first delta row", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "lo" }),
      },
      {
        threadId: thread.id,
        sequence: 3,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "!" }),
      },
      {
        threadId: thread.id,
        sequence: 4,
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

    const removed = pruneResolvedAgentMessageDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(2);
    expect(listEvents(db, { threadId: thread.id }).map((event) => event.sequence)).toEqual([1, 4]);
  });

  it("keeps unresolved assistant deltas", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "Hel" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        itemKind: null,
        data: JSON.stringify({ itemId: "msg-1", delta: "lo" }),
      },
    ]);

    const removed = pruneResolvedAgentMessageDeltas(db, {
      threadId: thread.id,
    });

    expect(removed).toBe(0);
    expect(listEvents(db, { threadId: thread.id }).map((event) => event.sequence)).toEqual([1, 2]);
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
        ...emptyItemFields,
        data: "{}",
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: "{}",
      },
      {
        threadId: thread2.id,
        sequence: 1,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: "{}",
      },
      {
        threadId: thread2.id,
        sequence: 2,
        type: "thread/tokenUsage/updated",
        ...emptyItemFields,
        data: "{}",
      },
    ]);

    const removed = pruneThreadEventsBeforeSequence(db, {
      threadId: thread.id,
      sequenceCutoff: 1,
      types: ["thread/tokenUsage/updated"],
    });

    expect(removed).toBe(1);
    expect(listEvents(db, { threadId: thread.id }).map((event) => event.sequence)).toEqual([2]);
    expect(listEvents(db, { threadId: thread2.id }).map((event) => event.sequence)).toEqual([1, 2]);
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
      { threadId: thread.id, sequence: 1, type: "system/error", ...emptyItemFields, data: "{}" },
      { threadId: thread2.id, sequence: 1, type: "system/error", ...emptyItemFields, data: "{}" },
    ]);

    expect(spy.notifyThread).toHaveBeenCalledWith(thread.id, [
      "events-appended",
    ]);
    expect(spy.notifyThread).toHaveBeenCalledWith(thread2.id, [
      "events-appended",
    ]);
    expect(spy.notifyThread).toHaveBeenCalledTimes(2);
  });
});
