import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBuffer } from "./event-buffer.js";

function createLogger() {
  return {
    warn: vi.fn(),
  };
}

function createEvent(threadId: string) {
  return {
    type: "thread/identity" as const,
    threadId,
    providerThreadId: `provider-${threadId}`,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("event buffer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes pushed events through the poster callback", async () => {
    vi.useFakeTimers();
    const postEvents = vi.fn(async () => ({ threadA: 1 }));
    const buffer = createEventBuffer({ logger: createLogger(), postEvents });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(event.sequence).toBe(1);
    expect(postEvents).toHaveBeenCalledWith([event]);
    expect(buffer.depth()).toBe(0);
  });

  it("discards acked events at or below the thread high-water mark", async () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => undefined,
      flushAtCount: 1_000,
    });

    const first = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    const other = buffer.push({
      environmentId: "env-2",
      threadId: "threadB",
      event: createEvent("threadB"),
    });

    buffer.ack({ threadA: first.sequence });

    expect(buffer.snapshot()).toEqual([second, other]);
    buffer.dispose();
  });

  it("retries failed flushes and keeps events until they are acknowledged", async () => {
    vi.useFakeTimers();
    const postEvents = vi
      .fn<(_: unknown) => Promise<Record<string, number>>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ threadA: 1 });
    const logger = createLogger();
    const buffer = createEventBuffer({ logger, postEvents });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(buffer.depth()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(buffer.depth()).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent flushes into a single in-flight post", async () => {
    const firstFlush = createDeferred<Record<string, number> | void>();
    const postEvents = vi
      .fn<(_: unknown) => Promise<Record<string, number> | void>>()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce({ threadA: 2 });
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents,
      flushAtCount: 1,
      debounceMs: 1_000,
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledTimes(1);
    });

    const secondFlush = buffer.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);

    firstFlush.resolve({ threadA: 1 });
    await secondFlush;

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledTimes(2);
    });
    expect(buffer.depth()).toBe(0);
  });

  it("drains events buffered during an in-flight flush before resolving an explicit flush", async () => {
    vi.useFakeTimers();
    const firstFlush = createDeferred<Record<string, number> | void>();
    const postEvents = vi
      .fn<(_: unknown) => Promise<Record<string, number> | void>>()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce({ threadA: 2 });
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents,
      flushAtCount: 5,
      debounceMs: 1_000,
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    const flushPromise = buffer.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);

    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    firstFlush.resolve({ threadA: 1 });
    await flushPromise;

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents.mock.calls[1]?.[0]).toEqual([second]);
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("drops the oldest events when the buffer exceeds the max size", async () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => undefined,
      flushAtCount: 2_000,
      maxBufferedEvents: 3,
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    const third = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    const fourth = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    expect(buffer.snapshot()).toEqual([second, third, fourth]);
    buffer.dispose();
  });

  it("assigns monotonic per-thread sequence numbers", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => undefined,
      flushAtCount: 1_000,
    });

    const first = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    const other = buffer.push({
      environmentId: "env-1",
      threadId: "threadB",
      event: createEvent("threadB"),
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(other.sequence).toBe(1);
    buffer.dispose();
  });

  it("starts sequences from the provided high-water marks", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => undefined,
      flushAtCount: 1_000,
      initialHighWaterMarks: {
        threadA: 41,
      },
    });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    expect(event.sequence).toBe(42);
    buffer.dispose();
  });

  it("seeds later high-water marks and prunes acknowledged events", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => undefined,
      flushAtCount: 1_000,
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    buffer.seed({ threadA: 5 });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    expect(buffer.snapshot()).toEqual([event]);
    expect(event.sequence).toBe(6);
    buffer.dispose();
  });

  it("bumps the next sequence after an explicit ack", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => undefined,
      flushAtCount: 1_000,
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });
    buffer.ack({ threadA: 5 });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createEvent("threadA"),
    });

    expect(event.sequence).toBe(6);
    buffer.dispose();
  });
});
