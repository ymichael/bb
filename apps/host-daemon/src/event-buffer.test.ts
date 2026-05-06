import Database from "better-sqlite3";
import {
  hostDaemonProducerEventIdSchema,
  threadScope,
  turnScope,
  type HostDaemonProducerEventId,
  type ThreadEvent,
} from "@bb/domain";
import type { HostDaemonEventEnvelope } from "@bb/host-daemon-contract";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventBuffer,
  shouldFlushThreadEventImmediately,
  type CreateEventBufferOptions,
  type EventPostResult,
} from "./event-buffer.js";

interface OutboundCountRow {
  count: number;
}

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function createDataDir(): string {
  return mkdtempSync(join(tmpdir(), "bb-event-buffer-"));
}

function removeDataDir(dataDir: string): void {
  rmSync(dataDir, { force: true, recursive: true });
}

function createProducerEventId(value: string): HostDaemonProducerEventId {
  return hostDaemonProducerEventIdSchema.parse(value);
}

function createProducerEventIdGenerator(
  values: readonly string[],
): CreateEventBufferOptions["createProducerEventId"] {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("No producer event id left in test generator");
    }
    index++;
    return createProducerEventId(value);
  };
}

function openSpoolDatabase(dataDir: string): Database.Database {
  return new Database(join(dataDir, "event-spool.sqlite"));
}

function countOutboundRows(dataDir: string): number {
  const db = openSpoolDatabase(dataDir);
  try {
    const row = db
      .prepare<
        [],
        OutboundCountRow
      >("SELECT COUNT(*) AS count FROM outbound_events")
      .get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

function acceptedPostResult(
  events: readonly HostDaemonEventEnvelope[],
): EventPostResult {
  return {
    acceptedEvents: events.map((event, index) => ({
      producerEventId: event.producerEventId,
      threadId: event.threadId,
      sequence: index + 1,
    })),
    kind: "accepted",
    rejectedEvents: [],
  };
}

function createThreadIdentityEvent(threadId: string): ThreadEvent {
  return {
    type: "thread/identity",
    threadId,
    providerThreadId: `provider-${threadId}`,
    scope: threadScope(),
  };
}

function createCompletedAssistantEvent(threadId: string): ThreadEvent {
  return {
    type: "item/completed",
    threadId,
    providerThreadId: `provider-${threadId}`,
    scope: turnScope(`turn-${threadId}`),
    item: {
      type: "agentMessage",
      id: `message-${threadId}`,
      text: "done",
    },
  };
}

function createWaitingForApprovalEvent(threadId: string): ThreadEvent {
  return {
    type: "item/started",
    threadId,
    providerThreadId: `provider-${threadId}`,
    scope: turnScope(`turn-${threadId}`),
    item: {
      type: "commandExecution",
      id: `command-${threadId}`,
      command: "ls",
      cwd: "/tmp",
      status: "pending",
      approvalStatus: "waiting_for_approval",
    },
  };
}

function createRetriableErrorEvent(threadId: string): ThreadEvent {
  return {
    type: "provider/error",
    threadId,
    providerThreadId: `provider-${threadId}`,
    scope: turnScope(`turn-${threadId}`),
    message: "retrying",
    willRetry: true,
  };
}

function createTerminalErrorEvent(threadId: string): ThreadEvent {
  return {
    type: "provider/error",
    threadId,
    providerThreadId: `provider-${threadId}`,
    scope: turnScope(`turn-${threadId}`),
    message: "failed",
  };
}

function createSystemErrorEvent(threadId: string): ThreadEvent {
  return {
    type: "system/error",
    threadId,
    scope: threadScope(),
    message: "system failed",
  };
}

describe("event buffer", () => {
  const dataDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dataDir of dataDirs.splice(0)) {
      removeDataDir(dataDir);
    }
  });

  function nextDataDir(): string {
    const dataDir = createDataDir();
    dataDirs.push(dataDir);
    return dataDir;
  }

  it("flushes pushed events through the poster callback", async () => {
    const dataDir = nextDataDir();
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => acceptedPostResult(events),
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents,
    });

    const event = buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await buffer.flush();

    expect(event).toMatchObject({
      localOrder: 1,
      producerEventId: "hdevt_23456789abcdefghijkm",
      threadId: "threadA",
    });
    expect(postEvents).toHaveBeenCalledWith([
      {
        producerEventId: "hdevt_23456789abcdefghijkm",
        threadId: "threadA",
        event: createThreadIdentityEvent("threadA"),
      },
    ]);
    expect(buffer.depth()).toBe(0);
    await buffer.dispose();
  });

  it("retries a lost response with identical producer ids and payloads", async () => {
    const dataDir = nextDataDir();
    let calls = 0;
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => {
        calls++;
        if (calls === 1) {
          throw new Error("lost response");
        }
        return acceptedPostResult(events);
      },
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents,
    });

    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await buffer.flush();
    expect(buffer.depth()).toBe(1);
    await buffer.flush();

    const firstBatch = postEvents.mock.calls[0]?.[0];
    const secondBatch = postEvents.mock.calls[1]?.[0];
    expect(firstBatch).toEqual(secondBatch);
    expect(secondBatch?.[0]?.producerEventId).toBe(
      "hdevt_23456789abcdefghijkm",
    );
    expect(buffer.depth()).toBe(0);
    await buffer.dispose();
  });

  it("resends unacknowledged records with identical ids and payloads after restart", async () => {
    const dataDir = nextDataDir();
    const firstBuffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents: async (events) => acceptedPostResult(events),
    });
    const event = firstBuffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await firstBuffer.dispose();

    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => acceptedPostResult(events),
    );
    const secondBuffer = createEventBuffer({
      dataDir,
      logger: createLogger(),
      postEvents,
    });
    await secondBuffer.flush();

    expect(postEvents).toHaveBeenCalledWith([
      {
        producerEventId: event.producerEventId,
        threadId: event.threadId,
        event: event.event,
      },
    ]);
    expect(secondBuffer.depth()).toBe(0);
    await secondBuffer.dispose();
  });

  it("preserves deterministic local order for same-process push submissions", async () => {
    const dataDir = nextDataDir();
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
        "hdevt_23456789abcdefghijkn",
        "hdevt_23456789abcdefghijkp",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents: async (events) => acceptedPostResult(events),
    });

    // push() persists synchronously through better-sqlite3, so same-process
    // calls cannot interleave inside the writer. This verifies that the
    // in-process boundary assigns localOrder by submission order.
    const pushedEvents = await Promise.all([
      Promise.resolve().then(() =>
        buffer.push({
          threadId: "threadA",
          event: createThreadIdentityEvent("threadA"),
        }),
      ),
      Promise.resolve().then(() =>
        buffer.push({
          threadId: "threadA",
          event: createThreadIdentityEvent("threadA"),
        }),
      ),
      Promise.resolve().then(() =>
        buffer.push({
          threadId: "threadB",
          event: createThreadIdentityEvent("threadB"),
        }),
      ),
    ]);

    expect(pushedEvents.map((event) => event.localOrder)).toEqual([1, 2, 3]);
    expect(
      buffer.snapshot().map((event) => ({
        localOrder: event.localOrder,
        producerEventId: event.producerEventId,
      })),
    ).toEqual([
      {
        localOrder: 1,
        producerEventId: "hdevt_23456789abcdefghijkm",
      },
      {
        localOrder: 2,
        producerEventId: "hdevt_23456789abcdefghijkn",
      },
      {
        localOrder: 3,
        producerEventId: "hdevt_23456789abcdefghijkp",
      },
    ]);
    await buffer.dispose();
  });

  it("deletes acknowledged rows by producerEventId", async () => {
    const dataDir = nextDataDir();
    let calls = 0;
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => {
        calls++;
        if (calls > 1) {
          throw new Error("stop after partial acknowledgement");
        }
        const acknowledged = events[1];
        if (acknowledged === undefined) {
          throw new Error("missing second event");
        }
        return {
          acceptedEvents: [
            {
              producerEventId: acknowledged.producerEventId,
              sequence: 2,
              threadId: acknowledged.threadId,
            },
          ],
          kind: "accepted",
          rejectedEvents: [],
        };
      },
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
        "hdevt_23456789abcdefghijkn",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents,
    });

    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await buffer.flush();

    expect(buffer.snapshot().map((event) => event.producerEventId)).toEqual([
      "hdevt_23456789abcdefghijkm",
    ]);
    await buffer.dispose();
  });

  it("deletes rejected rows so stale events do not block valid events", async () => {
    const dataDir = nextDataDir();
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => {
        const rejected = events[0];
        const accepted = events[1];
        if (rejected === undefined || accepted === undefined) {
          throw new Error("missing test events");
        }
        return {
          acceptedEvents: [
            {
              producerEventId: accepted.producerEventId,
              sequence: 1,
              threadId: accepted.threadId,
            },
          ],
          kind: "accepted",
          rejectedEvents: [
            {
              producerEventId: rejected.producerEventId,
              reason: "thread_not_owned_by_host",
              threadId: rejected.threadId,
            },
          ],
        };
      },
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
        "hdevt_23456789abcdefghijkn",
      ]),
      dataDir,
      debounceMs: 60_000,
      logger,
      maxWaitMs: 60_000,
      postEvents,
    });

    buffer.push({
      threadId: "stale-thread",
      event: createThreadIdentityEvent("stale-thread"),
    });
    buffer.push({
      threadId: "valid-thread",
      event: createThreadIdentityEvent("valid-thread"),
    });

    await buffer.flush();

    expect(buffer.depth()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        rejectedEvents: [
          {
            producerEventId: "hdevt_23456789abcdefghijkm",
            reason: "thread_not_owned_by_host",
            threadId: "stale-thread",
          },
        ],
      },
      "event flush discarded rejected events",
    );
    await buffer.dispose();
  });

  it("fails closed after repeated zero-ack flush responses", async () => {
    const dataDir = nextDataDir();
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async () => ({
        acceptedEvents: [],
        kind: "accepted",
        rejectedEvents: [],
      }),
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      debounceMs: 60_000,
      logger,
      maxWaitMs: 60_000,
      postEvents,
    });

    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    await buffer.flush();
    await buffer.flush();
    await expect(buffer.flush()).rejects.toThrow(
      /flush made no progress after 3 attempts/u,
    );

    expect(postEvents).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            localOrder: 1,
            producerEventId: "hdevt_23456789abcdefghijkm",
          }),
        ],
        noProgressCount: 3,
        noProgressLimit: 3,
      }),
      "event flush made no progress; failing closed",
    );
    expect(buffer.depth()).toBe(1);
    await buffer.dispose();
  });

  it("resets zero-ack budget after an acknowledged event", async () => {
    const dataDir = nextDataDir();
    let calls = 0;
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => {
        calls++;
        if (calls === 1) {
          return {
            acceptedEvents: [],
            kind: "accepted",
            rejectedEvents: [],
          };
        }
        return acceptedPostResult(events);
      },
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
        "hdevt_23456789abcdefghijkn",
      ]),
      dataDir,
      debounceMs: 60_000,
      logger: createLogger(),
      maxWaitMs: 60_000,
      postEvents,
    });

    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await buffer.flush();
    await buffer.flush();
    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await buffer.flush();

    expect(buffer.depth()).toBe(0);
    expect(postEvents).toHaveBeenCalledTimes(3);
    await buffer.dispose();
  });

  it("fails closed on spool schema mismatch", () => {
    const dataDir = nextDataDir();
    const db = openSpoolDatabase(dataDir);
    db.pragma("user_version = 2");
    db.close();

    expect(() =>
      createEventBuffer({
        dataDir,
        logger: createLogger(),
        postEvents: async (events) => acceptedPostResult(events),
      }),
    ).toThrow(/schema version mismatch/u);
  });

  it("fails closed when version zero already has an outbound table", () => {
    const dataDir = nextDataDir();
    const db = openSpoolDatabase(dataDir);
    db.exec(`
      CREATE TABLE outbound_events (
        localOrder INTEGER PRIMARY KEY AUTOINCREMENT
      );
    `);
    db.close();

    expect(() =>
      createEventBuffer({
        dataDir,
        logger: createLogger(),
        postEvents: async (events) => acceptedPostResult(events),
      }),
    ).toThrow(/outbound_events exists with schema version 0/u);
  });

  it("fails closed on spool column shape mismatch", () => {
    const dataDir = nextDataDir();
    const db = openSpoolDatabase(dataDir);
    db.exec(`
      CREATE TABLE outbound_events (
        localOrder INTEGER PRIMARY KEY AUTOINCREMENT,
        producerEventId TEXT NOT NULL UNIQUE
      );
    `);
    db.pragma("user_version = 1");
    db.close();

    expect(() =>
      createEventBuffer({
        dataDir,
        logger: createLogger(),
        postEvents: async (events) => acceptedPostResult(events),
      }),
    ).toThrow(/schema mismatch: outbound_events columns differ/u);
  });

  it("fails closed when a stored payload hash does not match", async () => {
    const dataDir = nextDataDir();
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents: async (events) => acceptedPostResult(events),
    });
    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await buffer.dispose();

    const db = openSpoolDatabase(dataDir);
    db.prepare("UPDATE outbound_events SET payloadHash = ?").run("bad-hash");
    db.close();

    const reopenedBuffer = createEventBuffer({
      dataDir,
      logger: createLogger(),
      postEvents: async (events) => acceptedPostResult(events),
    });
    expect(() => reopenedBuffer.snapshot()).toThrow(/payload hash mismatch/u);
    await reopenedBuffer.dispose();
  });

  it("fails closed when a stored payload thread id diverges from the row", async () => {
    const dataDir = nextDataDir();
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents: async (events) => acceptedPostResult(events),
    });
    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    await buffer.dispose();

    const db = openSpoolDatabase(dataDir);
    db.prepare("UPDATE outbound_events SET threadId = ?").run("threadB");
    db.close();

    const reopenedBuffer = createEventBuffer({
      dataDir,
      logger: createLogger(),
      postEvents: async (events) => acceptedPostResult(events),
    });
    expect(() => reopenedBuffer.snapshot()).toThrow(
      /payload threadId does not match row threadId/u,
    );
    await reopenedBuffer.dispose();
  });

  it("fails closed when an acknowledged row disappeared before deletion", async () => {
    const dataDir = nextDataDir();
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => {
        const acknowledged = events[0];
        if (acknowledged === undefined) {
          throw new Error("missing event");
        }
        const db = openSpoolDatabase(dataDir);
        try {
          db.prepare(
            "DELETE FROM outbound_events WHERE producerEventId = ?",
          ).run(acknowledged.producerEventId);
        } finally {
          db.close();
        }
        return acceptedPostResult(events);
      },
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents,
    });

    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    await expect(buffer.flush()).rejects.toThrow(/already-deleted event/u);
    await buffer.dispose();
  });

  it("awaits an in-flight flush before closing the spool database", async () => {
    const dataDir = nextDataDir();
    let resolvePost: (() => void) | undefined;
    const postEvents = vi.fn<CreateEventBufferOptions["postEvents"]>(
      async (events) => {
        await new Promise<void>((resolve) => {
          resolvePost = resolve;
        });
        return acceptedPostResult(events);
      },
    );
    const buffer = createEventBuffer({
      createProducerEventId: createProducerEventIdGenerator([
        "hdevt_23456789abcdefghijkm",
      ]),
      dataDir,
      logger: createLogger(),
      postEvents,
    });

    buffer.push({
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    const flushPromise = buffer.flush();
    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledTimes(1);
    });

    let disposed = false;
    const disposePromise = buffer.dispose().then(() => {
      disposed = true;
    });
    expect(() =>
      buffer.push({
        threadId: "threadA",
        event: createThreadIdentityEvent("threadA"),
      }),
    ).toThrow(/disposed event buffer/u);
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolvePost?.();
    await flushPromise;
    await disposePromise;

    expect(countOutboundRows(dataDir)).toBe(0);
  });

  it("fails closed on spool corruption", () => {
    const dataDir = nextDataDir();
    writeFileSync(join(dataDir, "event-spool.sqlite"), "not a sqlite database");

    expect(() =>
      createEventBuffer({
        dataDir,
        logger: createLogger(),
        postEvents: async (events) => acceptedPostResult(events),
      }),
    ).toThrow();
  });

  it("classifies immediate flush event types", () => {
    expect(
      shouldFlushThreadEventImmediately(createThreadIdentityEvent("threadA")),
    ).toBe(false);
    expect(
      shouldFlushThreadEventImmediately(
        createCompletedAssistantEvent("threadA"),
      ),
    ).toBe(true);
    expect(
      shouldFlushThreadEventImmediately(
        createWaitingForApprovalEvent("threadA"),
      ),
    ).toBe(true);
    expect(
      shouldFlushThreadEventImmediately(createRetriableErrorEvent("threadA")),
    ).toBe(false);
    expect(
      shouldFlushThreadEventImmediately(createTerminalErrorEvent("threadA")),
    ).toBe(true);
    expect(
      shouldFlushThreadEventImmediately(createSystemErrorEvent("threadA")),
    ).toBe(true);
  });
});
