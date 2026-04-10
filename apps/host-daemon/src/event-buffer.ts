import pDebounce from "p-debounce";
import type { ThreadEvent } from "@bb/domain";
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
  postEvents: (events: BufferedEvent[]) => Promise<Record<string, number> | void>;
  initialHighWaterMarks?: Record<string, number>;
  debounceMs?: number;
  flushAtCount?: number;
  maxBufferedEvents?: number;
  now?: () => number;
}

export interface EventBuffer {
  push(event: BufferedEventInput): BufferedEvent;
  ack(threadHighWaterMarks: Record<string, number>): void;
  seed(threadHighWaterMarks: Record<string, number>): void;
  flush(): Promise<void>;
  depth(): number;
  snapshot(): BufferedEvent[];
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_FLUSH_AT_COUNT = 50;
const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

export function createEventBuffer(
  options: CreateEventBufferOptions,
): EventBuffer {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const flushAtCount = options.flushAtCount ?? DEFAULT_FLUSH_AT_COUNT;
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  const now = options.now ?? Date.now;

  const nextSequenceByThread = new Map<string, number>();
  for (const [threadId, highWaterMark] of Object.entries(
    options.initialHighWaterMarks ?? {},
  )) {
    nextSequenceByThread.set(threadId, highWaterMark + 1);
  }

  let buffer: BufferedEvent[] = [];
  let flushPromise: Promise<boolean> | null = null;
  const flushAbortController = new AbortController();
  const debouncedFlush = pDebounce(
    async () => {
      await flush();
    },
    debounceMs,
    { signal: flushAbortController.signal },
  );

  function queueDebouncedFlush(): void {
    void debouncedFlush().catch((error: unknown) => {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        return;
      }
      throw error;
    });
  }

  function nextSequence(threadId: string): number {
    const nextValue = nextSequenceByThread.get(threadId) ?? 1;
    nextSequenceByThread.set(threadId, nextValue + 1);
    return nextValue;
  }

  function trimOverflow(): void {
    const overflow = buffer.length - maxBufferedEvents;
    if (overflow > 0) {
      buffer = buffer.slice(overflow);
    }
  }

  function push(event: BufferedEventInput): BufferedEvent {
    const sequence = nextSequence(event.threadId);
    const bufferedEvent: BufferedEvent = {
      ...event,
      sequence,
      createdAt: event.createdAt ?? now(),
    };

    buffer = [...buffer, bufferedEvent];
    trimOverflow();

    if (buffer.length >= flushAtCount) {
      void flush();
    } else {
      queueDebouncedFlush();
    }

    return bufferedEvent;
  }

  function ack(threadHighWaterMarks: Record<string, number>): void {
    if (Object.keys(threadHighWaterMarks).length === 0) {
      return;
    }

    for (const [threadId, highWaterMark] of Object.entries(threadHighWaterMarks)) {
      const nextValue = nextSequenceByThread.get(threadId) ?? 1;
      nextSequenceByThread.set(threadId, Math.max(nextValue, highWaterMark + 1));
    }

    buffer = buffer.filter((event) => {
      const highWaterMark = threadHighWaterMarks[event.threadId];
      return highWaterMark === undefined || event.sequence > highWaterMark;
    });
  }

  function seed(threadHighWaterMarks: Record<string, number>): void {
    ack(threadHighWaterMarks);
  }

  async function flush(): Promise<void> {
    while (true) {
      if (flushPromise) {
        const succeeded = await flushPromise;
        if (!succeeded || buffer.length === 0) {
          return;
        }
        continue;
      }

      if (buffer.length === 0) {
        return;
      }

      const batch = buffer.slice();
      flushPromise = (async (): Promise<boolean> => {
        let succeeded = false;
        try {
          const threadHighWaterMarks = await options.postEvents(batch);
          if (threadHighWaterMarks) {
            ack(threadHighWaterMarks);
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
        return succeeded;
      })();

      const succeeded = await flushPromise;
      if (!succeeded) {
        if (buffer.length > 0) {
          queueDebouncedFlush();
        }
        return;
      }

      if (buffer.length === 0) {
        return;
      }
    }
  }

  function dispose(): void {
    flushAbortController.abort();
  }

  return {
    push,
    ack,
    seed,
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
