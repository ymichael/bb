import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  insertEvents,
  getHighWaterMarks,
  listEvents,
} from "../../src/data/events.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const project = createProject(db, noopNotifier, { name: "test-project" });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, thread };
}

describe("events", () => {
  it("inserts events and returns count", () => {
    const { db, thread } = setup();

    const count = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        data: JSON.stringify({ message: "test" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        data: JSON.stringify({ message: "test2" }),
      },
    ]);

    expect(count).toBe(2);
    const all = listEvents(db, { threadId: thread.id });
    expect(all).toHaveLength(2);
  });

  it("deduplicates on (threadId, sequence)", () => {
    const { db, thread } = setup();

    const count1 = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        data: JSON.stringify({ message: "first" }),
      },
    ]);
    expect(count1).toBe(1);

    // Same threadId + sequence should be ignored
    const count2 = insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        data: JSON.stringify({ message: "duplicate" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "system/error",
        data: JSON.stringify({ message: "new" }),
      },
    ]);
    expect(count2).toBe(1); // only sequence 2 inserted

    const all = listEvents(db, { threadId: thread.id });
    expect(all).toHaveLength(2);
    // Original data preserved for sequence 1
    expect(JSON.parse(all[0]!.data)).toMatchObject({ message: "first" });
  });

  it("returns high-water marks per thread", () => {
    const { db, project, thread } = setup();
    const thread2 = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    insertEvents(db, noopNotifier, [
      { threadId: thread.id, sequence: 1, type: "system/error", data: "{}" },
      { threadId: thread.id, sequence: 5, type: "system/error", data: "{}" },
      { threadId: thread2.id, sequence: 3, type: "system/error", data: "{}" },
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
      { threadId: thread.id, sequence: 10, type: "system/error", data: "{}" },
      { threadId: thread2.id, sequence: 3, type: "system/error", data: "{}" },
    ]);

    const hwm = getHighWaterMarks(db, [thread.id]);
    expect(hwm[thread.id]).toBe(10);
    expect(hwm[thread2.id]).toBeUndefined();
  });

  it("lists events after a given sequence", () => {
    const { db, thread } = setup();

    insertEvents(db, noopNotifier, [
      { threadId: thread.id, sequence: 1, type: "system/error", data: "{}" },
      { threadId: thread.id, sequence: 2, type: "system/error", data: "{}" },
      { threadId: thread.id, sequence: 3, type: "system/error", data: "{}" },
    ]);

    const after1 = listEvents(db, { threadId: thread.id, afterSequence: 1 });
    expect(after1).toHaveLength(2);
    expect(after1[0]!.sequence).toBe(2);
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
      { threadId: thread.id, sequence: 1, type: "system/error", data: "{}" },
      { threadId: thread2.id, sequence: 1, type: "system/error", data: "{}" },
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
