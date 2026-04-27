import { createDebouncedCallbackScheduler, type ThreadEvent } from "@bb/domain";
import type { HostDaemonLogger } from "./logger.js";

export interface BufferedEventInput {
  environmentId: string;
  threadId: string;
  event: ThreadEvent;
  createdAt?: number;
}

export interface BufferedEvent extends BufferedEventInput {
  sequence: number;
  createdAt: number;
}

export interface CreateEventBufferOptions {
  logger: Pick<HostDaemonLogger, "warn">;
  postEvents: (events: BufferedEvent[]) => Promise<Record<string, number>>;
  initialHighWaterMarks?: Record<string, number>;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

export interface EventBuffer {
  /**
   * Buffered events are retained until the server acknowledges them. This
   * buffer is intentionally uncapped: during outages we prefer memory pressure
   * and retry backoff over silently dropping daemon events.
   */
  push(event: BufferedEventInput): BufferedEvent;
  ack(threadHighWaterMarks: Record<string, number>): void;
  seed(threadHighWaterMarks: Record<string, number>): void;
  /**
   * Move still-buffered events above server-originated sequence advances after
   * a command-result RPC. Command seed values establish the floor before events
   * are emitted; rebase handles only later server appends that race with events
   * still waiting in this buffer.
   */
  rebase(threadHighWaterMarks: Record<string, number>): void;
  flush(): Promise<void>;
  depth(): number;
  snapshot(): BufferedEvent[];
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_MAX_WAIT_MS = 500;

function isWaitingForApprovalItemEvent(event: ThreadEvent): boolean {
  if (event.type !== "item/started" && event.type !== "item/completed") {
    return false;
  }

  if (
    event.item.type !== "commandExecution" &&
    event.item.type !== "fileChange"
  ) {
    return false;
  }

  return event.item.approvalStatus === "waiting_for_approval";
}

export function shouldFlushThreadEventImmediately(event: ThreadEvent): boolean {
  if (event.type === "item/completed") {
    return true;
  }

  if (
    event.type === "turn/completed" ||
    event.type === "system/error" ||
    event.type === "system/thread/interrupted"
  ) {
    return true;
  }

  if (event.type === "provider/error") {
    return event.willRetry !== true;
  }

  return isWaitingForApprovalItemEvent(event);
}

export function createEventBuffer(
  options: CreateEventBufferOptions,
): EventBuffer {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const now = options.now ?? Date.now;

  const nextSequenceByThread = new Map<string, number>();
  for (const [threadId, highWaterMark] of Object.entries(
    options.initialHighWaterMarks ?? {},
  )) {
    nextSequenceByThread.set(threadId, highWaterMark + 1);
  }

  let buffer: BufferedEvent[] = [];
  let disposed = false;
  let flushPromise: Promise<{
    acknowledgedBatchCount: number;
    succeeded: boolean;
  }> | null = null;
  const flushScheduler = createDebouncedCallbackScheduler({
    debounceMs,
    maxWaitMs,
    onFlush: () => {
      void flush();
    },
  });

  function scheduleFlush(): void {
    if (disposed) {
      return;
    }
    flushScheduler.schedule();
  }

  function flushImmediately(): void {
    if (disposed) {
      return;
    }
    flushScheduler.flush();
  }

  function nextSequence(threadId: string): number {
    const nextValue = nextSequenceByThread.get(threadId) ?? 1;
    nextSequenceByThread.set(threadId, nextValue + 1);
    return nextValue;
  }

  function push(event: BufferedEventInput): BufferedEvent {
    const sequence = nextSequence(event.threadId);
    const bufferedEvent: BufferedEvent = {
      ...event,
      sequence,
      createdAt: event.createdAt ?? now(),
    };

    buffer.push(bufferedEvent);

    if (shouldFlushThreadEventImmediately(event.event)) {
      flushImmediately();
    } else {
      scheduleFlush();
    }

    return bufferedEvent;
  }

  function ack(threadHighWaterMarks: Record<string, number>): void {
    if (Object.keys(threadHighWaterMarks).length === 0) {
      return;
    }

    for (const [threadId, highWaterMark] of Object.entries(
      threadHighWaterMarks,
    )) {
      const nextValue = nextSequenceByThread.get(threadId) ?? 1;
      nextSequenceByThread.set(
        threadId,
        Math.max(nextValue, highWaterMark + 1),
      );
    }

    buffer = buffer.filter((event) => {
      const highWaterMark = threadHighWaterMarks[event.threadId];
      return highWaterMark === undefined || event.sequence > highWaterMark;
    });
  }

  function seed(threadHighWaterMarks: Record<string, number>): void {
    ack(threadHighWaterMarks);
  }

  function rebase(threadHighWaterMarks: Record<string, number>): void {
    if (Object.keys(threadHighWaterMarks).length === 0) {
      return;
    }

    for (const [threadId, highWaterMark] of Object.entries(
      threadHighWaterMarks,
    )) {
      const shouldReassign = buffer.some(
        (event) =>
          event.threadId === threadId && event.sequence <= highWaterMark,
      );
      if (!shouldReassign) {
        const nextValue = nextSequenceByThread.get(threadId) ?? 1;
        nextSequenceByThread.set(
          threadId,
          Math.max(nextValue, highWaterMark + 1),
        );
        continue;
      }

      let nextValue = highWaterMark + 1;
      buffer = buffer.map((event) => {
        if (event.threadId !== threadId) {
          return event;
        }
        const nextEvent = {
          ...event,
          sequence: nextValue,
        };
        nextValue++;
        return nextEvent;
      });
      nextSequenceByThread.set(threadId, nextValue);
    }
  }

  async function flush(): Promise<void> {
    while (true) {
      if (disposed) {
        return;
      }

      if (flushPromise) {
        const result = await flushPromise;
        if (disposed) {
          return;
        }
        if (!result.succeeded || result.acknowledgedBatchCount === 0) {
          if (buffer.length > 0) {
            scheduleFlush();
          }
          return;
        }
        if (buffer.length === 0) {
          return;
        }
        continue;
      }

      if (buffer.length === 0) {
        return;
      }

      const batch = buffer.slice();

      flushPromise = (async (): Promise<{
        acknowledgedBatchCount: number;
        succeeded: boolean;
      }> => {
        let acknowledgedBatchCount = 0;
        let succeeded = false;
        try {
          const threadHighWaterMarks = await options.postEvents(batch);
          const bufferDepthBeforeAck = buffer.length;
          ack(threadHighWaterMarks);
          acknowledgedBatchCount = Math.min(
            batch.length,
            Math.max(0, bufferDepthBeforeAck - buffer.length),
          );
          if (acknowledgedBatchCount === 0) {
            options.logger.warn(
              {
                bufferDepth: batch.length,
                threadHighWaterMarks,
              },
              "event flush made no progress, will retry",
            );
          }
          succeeded = true;
        } catch (error) {
          options.logger.warn(
            {
              err: error,
              bufferDepth: batch.length,
            },
            "event flush failed, will retry",
          );
        } finally {
          flushPromise = null;
        }
        return {
          acknowledgedBatchCount,
          succeeded,
        };
      })();

      const result = await flushPromise;
      if (disposed) {
        return;
      }
      if (!result.succeeded || result.acknowledgedBatchCount === 0) {
        if (buffer.length > 0) {
          scheduleFlush();
        }
        return;
      }

      if (buffer.length === 0) {
        return;
      }
    }
  }

  function dispose(): void {
    disposed = true;
    flushScheduler.dispose();
  }

  return {
    push,
    ack,
    seed,
    rebase,
    flush,
    depth(): number {
      return buffer.length;
    },
    snapshot(): BufferedEvent[] {
      return buffer.slice();
    },
    dispose,
  };
}
