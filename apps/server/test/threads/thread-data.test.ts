import { describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  listStoredEventRows,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { parseStoredEvent } from "../../src/services/threads/thread-data.js";

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
  return { db, thread };
}

describe("thread data stored event parsing", () => {
  it("rejects malformed stored scope kinds", () => {
    const { db, thread } = setup();

    try {
      db.$client.pragma("ignore_check_constraints = ON");
      db.$client
        .prepare(
          `INSERT INTO events (
            id,
            thread_id,
            scope_kind,
            turn_id,
            sequence,
            type,
            data,
            created_at
          )
          VALUES (
            'evt_malformed_scope_kind',
            ?,
            'bogus',
            'turn-1',
            1,
            'system/error',
            '{"message":"boom"}',
            1
          )`,
        )
        .run(thread.id);
      db.$client.pragma("ignore_check_constraints = OFF");

      const [row] = listStoredEventRows(db, { threadId: thread.id });
      if (!row) {
        throw new Error("Expected stored event row");
      }

      expect(() => parseStoredEvent(row)).toThrow(/invalid scope_kind/);
    } finally {
      db.$client.pragma("ignore_check_constraints = OFF");
      db.$client.close();
    }
  });

  it("rejects stored event rows with malformed JSON payloads", () => {
    const { db, thread } = setup();

    try {
      db.$client
        .prepare(
          `INSERT INTO events (
            id,
            thread_id,
            scope_kind,
            turn_id,
            sequence,
            type,
            data,
            created_at
          )
          VALUES (
            'evt_malformed_json',
            ?,
            'thread',
            NULL,
            1,
            'system/error',
            '{"message":',
            1
          )`,
        )
        .run(thread.id);

      const [row] = listStoredEventRows(db, { threadId: thread.id });
      if (!row) {
        throw new Error("Expected stored event row");
      }

      expect(() => parseStoredEvent(row)).toThrow(/not valid JSON/);
    } finally {
      db.$client.close();
    }
  });
});
