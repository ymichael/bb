import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviderEventEnvelope } from "@bb/core";
import type { DbConnection } from "../src/connection.js";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import {
  EventRepository,
  ProjectRepository,
  ThreadRepository,
} from "../src/repositories.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

describe("event repository provider envelope indexing", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let threads: ThreadRepository;
  let events: EventRepository;
  let threadId: string;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    threads = new ThreadRepository(db);
    events = new EventRepository(db);

    const project = projects.create({
      name: "test-project",
      rootPath: "/tmp/test-project",
    });
    const thread = threads.create({ projectId: project.id });
    threadId = thread.id;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("extracts provider thread ids and turn lifecycle from envelope payloads", () => {
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: createProviderEventEnvelope({
        providerId: "codex",
        method: "thread/started",
        payload: {
          thread: {
            id: "provider-thread-1",
          },
        },
        observedAt: 1,
      }),
    });
    events.create({
      threadId,
      seq: 2,
      type: "turn/started",
      data: createProviderEventEnvelope({
        providerId: "codex",
        method: "turn/started",
        payload: {
          turnId: "turn-1",
        },
        observedAt: 2,
      }),
    });
    events.create({
      threadId,
      seq: 3,
      type: "turn/completed",
      data: createProviderEventEnvelope({
        providerId: "codex",
        method: "turn/completed",
        payload: {
          turn: {
            id: "turn-1",
          },
        },
        observedAt: 3,
      }),
    });

    expect(events.getLatestProviderThreadId(threadId)).toBe("provider-thread-1");
    expect(events.getLatestTurnLifecycle(threadId)).toEqual({
      normType: "turn/completed",
      turnId: "turn-1",
    });
  });

  it("keeps compatibility for legacy raw provider payload rows", () => {
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {
        thread: {
          id: "legacy-provider-thread",
        },
      },
    });

    expect(events.getLatestProviderThreadId(threadId)).toBe(
      "legacy-provider-thread",
    );
  });

  it("prunes historical high-frequency noise while preserving recent and non-noise events", () => {
    events.create({
      threadId,
      seq: 1,
      type: "item/agentMessage/delta",
      data: { delta: "old chunk" },
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/tokenUsage/updated",
      data: { totalTokens: 123 },
    });
    events.create({
      threadId,
      seq: 3,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          text: "final response",
        },
      },
    });
    events.create({
      threadId,
      seq: 4,
      type: "item/agentMessage/delta",
      data: { delta: "recent chunk" },
    });

    const removed = events.pruneHistoricalNoiseByThread(threadId, 2);
    expect(removed).toBe(2);

    const remaining = events.listByThread(threadId);
    expect(remaining.map((event) => event.seq)).toEqual([3, 4]);
    expect(remaining.map((event) => event.type)).toEqual([
      "item/completed",
      "item/agentMessage/delta",
    ]);
  });

  it("prunes legacy codex rows when they age out of the supported history window", () => {
    events.create({
      threadId,
      seq: 1,
      type: "codex/event/turn_diff",
      data: { diff: "old diff payload" },
    });
    events.create({
      threadId,
      seq: 2,
      type: "codex/event/agent_reasoning",
      data: { text: "old reasoning chunk" },
    });
    events.create({
      threadId,
      seq: 3,
      type: "codex/event/user_message",
      data: { message: "keep user message for legacy rendering" },
    });
    events.create({
      threadId,
      seq: 4,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          text: "final response",
        },
      },
    });

    const removed = events.pruneHistoricalNoiseByThread(threadId, 2);
    expect(removed).toBe(2);

    const remaining = events.listByThread(threadId);
    expect(remaining.map((event) => event.seq)).toEqual([3, 4]);
    expect(remaining.map((event) => event.type)).toEqual([
      "codex/event/user_message",
      "item/completed",
    ]);
  });

  it("prunes resolved item deltas regardless of recency cutoff", () => {
    events.create({
      threadId,
      seq: 1,
      type: "item/agentMessage/delta",
      data: {
        itemId: "msg-1",
        delta: "chunk",
      },
    });
    events.create({
      threadId,
      seq: 2,
      type: "item/completed",
      data: {
        item: {
          id: "msg-1",
          type: "agentMessage",
          text: "final response",
        },
      },
    });
    const removed = events.pruneHistoricalNoiseByThread(threadId, 10_000);
    expect(removed).toBe(1);

    const remaining = events.listByThread(threadId);
    expect(remaining.map((event) => event.type)).toEqual([
      "item/completed",
    ]);
  });
});
