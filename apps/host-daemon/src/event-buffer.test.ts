import type { ThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventBuffer,
  shouldFlushThreadEventImmediately,
  type BufferedEvent,
} from "./event-buffer.js";

function createLogger() {
  return {
    warn: vi.fn(),
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

function createWaitingForApprovalFileChangeEvent(
  threadId: string,
): ThreadEvent {
  return {
    type: "item/completed",
    threadId,
    providerThreadId: `provider-${threadId}`,
    scope: turnScope(`turn-${threadId}`),
    item: {
      type: "fileChange",
      id: `change-${threadId}`,
      status: "completed",
      approvalStatus: "waiting_for_approval",
      changes: [],
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

function createSystemThreadInterruptedEvent(threadId: string): ThreadEvent {
  return {
    type: "system/thread/interrupted",
    threadId,
    scope: threadScope(),
    reason: "user",
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
      event: createThreadIdentityEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(event.sequence).toBe(1);
    expect(postEvents).toHaveBeenCalledWith([event]);
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("flushes normal-path events at max wait while pushes continue within the debounce window", async () => {
    vi.useFakeTimers();
    const postEvents = vi.fn(async () => ({ threadA: 3 }));
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents,
      debounceMs: 200,
      maxWaitMs: 500,
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(150);

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(150);
    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(postEvents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("flushes immediate-path events without waiting for the debounce window", async () => {
    const postEvents = vi.fn(async () => ({ threadA: 1 }));
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents,
      debounceMs: 1_000,
      maxWaitMs: 5_000,
    });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createCompletedAssistantEvent("threadA"),
    });

    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledWith([event]);
    });
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("classifies terminal and waiting-for-approval events for immediate flushes", () => {
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
      shouldFlushThreadEventImmediately(
        createWaitingForApprovalFileChangeEvent("threadA"),
      ),
    ).toBe(true);
    expect(
      shouldFlushThreadEventImmediately(createTerminalErrorEvent("threadA")),
    ).toBe(true);
    expect(
      shouldFlushThreadEventImmediately(createSystemErrorEvent("threadA")),
    ).toBe(true);
    expect(
      shouldFlushThreadEventImmediately(
        createSystemThreadInterruptedEvent("threadA"),
      ),
    ).toBe(true);
    expect(
      shouldFlushThreadEventImmediately(createRetriableErrorEvent("threadA")),
    ).toBe(false);
    expect(
      shouldFlushThreadEventImmediately(createThreadIdentityEvent("threadA")),
    ).toBe(false);
  });

  it("discards acked events at or below the thread high-water mark", async () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => ({}),
    });

    const first = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    const other = buffer.push({
      environmentId: "env-2",
      threadId: "threadB",
      event: createThreadIdentityEvent("threadB"),
    });

    buffer.ack({ threadA: first.sequence });

    expect(buffer.snapshot()).toEqual([second, other]);
    buffer.dispose();
  });

  it("rebases buffered events above a server-originated high-water mark", async () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => ({}),
    });

    const first = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    const other = buffer.push({
      environmentId: "env-2",
      threadId: "threadB",
      event: createThreadIdentityEvent("threadB"),
    });

    buffer.rebase({ threadA: first.sequence });

    expect(buffer.snapshot()).toEqual([
      { ...first, sequence: 2 },
      { ...second, sequence: 3 },
      other,
    ]);

    const next = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    expect(next.sequence).toBe(4);
    buffer.dispose();
  });

  it("retries failed flushes and keeps events until they are acknowledged", async () => {
    vi.useFakeTimers();
    const postEvents = vi
      .fn<(events: BufferedEvent[]) => Promise<Record<string, number>>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ threadA: 1 });
    const logger = createLogger();
    const buffer = createEventBuffer({ logger, postEvents });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(buffer.depth()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(buffer.depth()).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    buffer.dispose();
  });

  it("retries later when a successful flush does not acknowledge buffered events", async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const postEvents = vi
      .fn<(events: BufferedEvent[]) => Promise<Record<string, number>>>()
      .mockResolvedValueOnce({ threadA: 0 })
      .mockResolvedValueOnce({ threadA: 1 });
    const buffer = createEventBuffer({ logger, postEvents });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(buffer.depth()).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        bufferDepth: 1,
        threadHighWaterMarks: { threadA: 0 },
      },
      "event flush made no progress, will retry",
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("coalesces concurrent flushes into a single in-flight post", async () => {
    const firstFlush = createDeferred<Record<string, number>>();
    const postEvents = vi
      .fn<(events: BufferedEvent[]) => Promise<Record<string, number>>>()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce({ threadA: 2 });
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents,
      debounceMs: 1_000,
      maxWaitMs: 5_000,
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createCompletedAssistantEvent("threadA"),
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
      event: createCompletedAssistantEvent("threadA"),
    });

    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledTimes(2);
    });
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("drains events buffered during an in-flight flush before resolving an explicit flush", async () => {
    vi.useFakeTimers();
    const firstFlush = createDeferred<Record<string, number>>();
    const postEvents = vi
      .fn<(events: BufferedEvent[]) => Promise<Record<string, number>>>()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce({ threadA: 2 });
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents,
      debounceMs: 1_000,
      maxWaitMs: 5_000,
    });

    const first = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    const flushPromise = buffer.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);

    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    expect(postEvents.mock.calls[0]?.[0]).toEqual([first]);

    firstFlush.resolve({ threadA: 1 });
    await flushPromise;

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents.mock.calls[1]?.[0]).toEqual([second]);
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("treats in-flight rebases as no progress until the server actually acknowledges the batch", async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const firstFlush = createDeferred<Record<string, number>>();
    const postEvents = vi
      .fn<(events: BufferedEvent[]) => Promise<Record<string, number>>>()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValueOnce({ threadA: 2 });
    const buffer = createEventBuffer({ logger, postEvents });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createCompletedAssistantEvent("threadA"),
    });

    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledWith([event]);
    });

    buffer.rebase({ threadA: event.sequence });
    firstFlush.resolve({ threadA: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        bufferDepth: 1,
        threadHighWaterMarks: { threadA: 0 },
      },
      "event flush made no progress, will retry",
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(buffer.depth()).toBe(0);
    buffer.dispose();
  });

  it("does not reschedule retries after disposal while a flush is in flight", async () => {
    vi.useFakeTimers();
    const firstFlush = createDeferred<Record<string, number>>();
    const postEvents = vi
      .fn<(events: BufferedEvent[]) => Promise<Record<string, number>>>()
      .mockImplementationOnce(() => firstFlush.promise);
    const buffer = createEventBuffer({ logger: createLogger(), postEvents });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createCompletedAssistantEvent("threadA"),
    });

    await vi.waitFor(() => {
      expect(postEvents).toHaveBeenCalledTimes(1);
    });

    buffer.dispose();
    firstFlush.resolve({ threadA: 0 });
    await vi.advanceTimersByTimeAsync(200);

    expect(postEvents).toHaveBeenCalledTimes(1);
  });

  it("assigns monotonic per-thread sequence numbers", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => ({}),
    });

    const first = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    const second = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    const other = buffer.push({
      environmentId: "env-1",
      threadId: "threadB",
      event: createThreadIdentityEvent("threadB"),
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(other.sequence).toBe(1);
    buffer.dispose();
  });

  it("starts sequences from the provided high-water marks", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => ({}),
      initialHighWaterMarks: {
        threadA: 41,
      },
    });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    expect(event.sequence).toBe(42);
    buffer.dispose();
  });

  it("seeds later high-water marks and prunes acknowledged events", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => ({}),
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    buffer.seed({ threadA: 5 });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    expect(buffer.snapshot()).toEqual([event]);
    expect(event.sequence).toBe(6);
    buffer.dispose();
  });

  it("bumps the next sequence after an explicit ack", () => {
    const buffer = createEventBuffer({
      logger: createLogger(),
      postEvents: async () => ({}),
    });

    buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });
    buffer.ack({ threadA: 5 });

    const event = buffer.push({
      environmentId: "env-1",
      threadId: "threadA",
      event: createThreadIdentityEvent("threadA"),
    });

    expect(event.sequence).toBe(6);
    buffer.dispose();
  });
});
