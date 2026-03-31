import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  getHighWaterMarks,
  getLatestThreadSequence,
  insertEvents,
  listEvents,
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
