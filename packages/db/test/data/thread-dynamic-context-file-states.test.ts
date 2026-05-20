import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  getThreadDynamicContextFileState,
  upsertThreadDynamicContextFileState,
  upsertThreadDynamicContextFileStateInTransaction,
} from "../../src/data/thread-dynamic-context-file-states.js";
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
    status: "idle",
    type: "manager",
  });
  return { db, thread };
}

describe("thread dynamic context file states", () => {
  it("upserts and reads a per-thread file state", () => {
    const { db, thread } = setup();
    const shownAt = Date.now();

    upsertThreadDynamicContextFileState(db, {
      threadId: thread.id,
      fileKey: "manager-preferences",
      contentStatus: "present",
      contentHash: "hash-1",
      shownAt,
    });
    upsertThreadDynamicContextFileState(db, {
      threadId: thread.id,
      fileKey: "manager-preferences",
      contentStatus: "too_large",
      contentHash: "hash-2",
      shownAt: shownAt + 1,
    });

    expect(
      getThreadDynamicContextFileState(db, {
        threadId: thread.id,
        fileKey: "manager-preferences",
      }),
    ).toMatchObject({
      threadId: thread.id,
      fileKey: "manager-preferences",
      contentStatus: "too_large",
      contentHash: "hash-2",
      shownAt: shownAt + 1,
    });
  });

  it("upserts within an existing transaction", () => {
    const { db, thread } = setup();
    const shownAt = Date.now();

    db.transaction((tx) => {
      upsertThreadDynamicContextFileStateInTransaction(tx, {
        threadId: thread.id,
        fileKey: "manager-preferences",
        contentStatus: "missing",
        contentHash: "missing-hash",
        shownAt,
      });
    });

    expect(
      getThreadDynamicContextFileState(db, {
        threadId: thread.id,
        fileKey: "manager-preferences",
      }),
    ).toMatchObject({
      contentStatus: "missing",
      contentHash: "missing-hash",
    });
  });
});
