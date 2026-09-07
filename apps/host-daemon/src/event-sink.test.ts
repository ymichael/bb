import { threadScope } from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { createEventSink, type CreateEventSinkOptions } from "./event-sink.js";
import { ServerResponseError } from "./server-client.js";

function permanentRejection(bodyMessage: string): ServerResponseError {
  return new ServerResponseError({
    action: "post events",
    bodyMessage,
    code: "invalid_request",
    retryable: false,
    status: 409,
    statusText: "Conflict",
  });
}

function createLogger(): CreateEventSinkOptions["logger"] {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function acceptingPostEvents() {
  return vi.fn<CreateEventSinkOptions["postEvents"]>(async (events) => ({
    acceptedEvents: events.map((event, eventIndex) => ({
      eventIndex,
      sequence: eventIndex + 1,
      threadId: event.threadId,
    })),
    rejectedEvents: [],
  }));
}

function systemErrorEvent(threadId: string) {
  return {
    type: "system/error",
    threadId,
    scope: threadScope(),
    message: "boom",
  } as const;
}

describe("event sink", () => {
  it("posts emitted events", async () => {
    const postEvents = acceptingPostEvents();
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("holds events while the session is closed and delivers them once it reopens", async () => {
    let sessionOpen = false;
    const postEvents = acceptingPostEvents();
    const sink = createEventSink({
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();

    sessionOpen = true;
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(postEvents).toHaveBeenCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("keeps events queued after a post failure and redelivers them on the next flush", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("drops rejected events with a warning without throwing", async () => {
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async () => ({
        acceptedEvents: [],
        rejectedEvents: [
          {
            eventIndex: 0,
            reason: "thread_not_owned_by_host",
            threadId: "thr_1",
          },
        ],
      }),
    );
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);

    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);
  });

  it("warns once when a large queue remains undelivered", () => {
    const logger = createLogger();
    let now = 0;
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    for (let index = 0; index < 511; index += 1) {
      sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    }
    expect(logger.warn).not.toHaveBeenCalled();

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).not.toHaveBeenCalled();

    now = 5_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueAgeMs: 5_000, queueDepth: 513 }),
      expect.any(String),
    );
  });

  it("warns when even a small queue is stalled for thirty seconds", () => {
    const logger = createLogger();
    let now = 0;
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    now = 30_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueAgeMs: 30_000, queueDepth: 2 }),
      expect.any(String),
    );
  });

  it("drops a permanently rejected event instead of retrying it forever", async () => {
    const logger = createLogger();
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async (events) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }
        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    await sink.flush();

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("delivers events queued behind a permanently rejected event", async () => {
    const delivered: string[] = [];
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async (events) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }
        delivered.push(...events.map((event) => event.threadId));
        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );
    let sessionOpen = false;
    const sink = createEventSink({
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });
    sink.emit({ threadId: "thr_b", event: systemErrorEvent("thr_b") });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });

    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();

    sessionOpen = true;
    await sink.flush();

    expect(delivered).toEqual(["thr_a", "thr_b", "thr_a"]);

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
  });

  it("keeps retrying a batch that fails for a retryable reason", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "database is locked",
          code: "internal_error",
          retryable: true,
          status: 500,
          statusText: "Internal Server Error",
        }),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
    ]);
  });

  it("keeps events queued when the session, not the batch, is rejected", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "Session is not active",
          code: "inactive_session",
          retryable: false,
          status: 401,
          statusText: "Unauthorized",
        }),
      )
      .mockImplementation(async (events) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));
    const sink = createEventSink({
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);

    await sink.flush();
    expect(postEvents).toHaveBeenLastCalledWith([
      { threadId: "thr_1", event: systemErrorEvent("thr_1") },
      { threadId: "thr_2", event: systemErrorEvent("thr_2") },
    ]);
  });

  it("never throws from emit regardless of how many events queue up", () => {
    const sink = createEventSink({
      isSessionOpen: () => false,
      logger: createLogger(),
      postEvents: acceptingPostEvents(),
    });

    expect(() => {
      for (let index = 0; index < 1000; index += 1) {
        sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
      }
    }).not.toThrow();
  });
});
