import type { ThreadEvent } from "@bb/domain";
import type {
  HostDaemonEventBatchResponse,
  HostDaemonEventEnvelope,
  HostDaemonRejectedEvent,
} from "@bb/host-daemon-contract";
import { normalizeCaughtError, runtimeErrorLogFields } from "./error-utils.js";
import type { HostDaemonLogger } from "./logger.js";
import { ServerResponseError } from "./server-client.js";

const DEFAULT_DEBOUNCE_MS = 100;

const QUEUE_DEPTH_WARN_THRESHOLD = 512;
const QUEUE_DEPTH_WARN_MIN_AGE_MS = 5_000;
const QUEUE_AGE_WARN_THRESHOLD_MS = 30_000;

export interface EventSinkInput {
  event: ThreadEvent;
  threadId: string;
}

export interface EventPostResult {
  acceptedEvents: HostDaemonEventBatchResponse["acceptedEvents"];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

export interface CreateEventSinkOptions {
  isSessionOpen: () => boolean;
  logger: Pick<HostDaemonLogger, "debug" | "error" | "warn">;
  now?: () => number;
  postEvents: (events: HostDaemonEventEnvelope[]) => Promise<EventPostResult>;
}

export interface EventSink {
  emit(event: EventSinkInput): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

interface RejectedEventSummary {
  eventIndex: number;
  reason: HostDaemonRejectedEvent["reason"];
  threadId: string;
}

export class EventSinkDisposedError extends Error {
  constructor() {
    super("Cannot emit to disposed event sink");
    this.name = "EventSinkDisposedError";
  }
}

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

function shouldFlushThreadEventImmediately(event: ThreadEvent): boolean {
  if (event.type === "turn/started" || event.type === "item/completed") {
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

function isPermanentPostRejection(error: Error): boolean {
  return (
    error instanceof ServerResponseError &&
    !error.retryable &&
    error.code === "invalid_request"
  );
}

function summarizeRejectedEvents(
  events: readonly HostDaemonRejectedEvent[],
): RejectedEventSummary[] {
  return events.map((event) => ({
    eventIndex: event.eventIndex,
    reason: event.reason,
    threadId: event.threadId,
  }));
}

export function createEventSink(options: CreateEventSinkOptions): EventSink {
  const now = options.now ?? (() => Date.now());
  const queue: HostDaemonEventEnvelope[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushPromise: Promise<void> | null = null;
  let disposed = false;
  let backedUpSinceMs: number | null = null;
  let backpressureLogged = false;

  function maybeLogQueuePressure(): void {
    if (backpressureLogged || backedUpSinceMs === null) {
      return;
    }
    const queueDepth = queue.length;
    const queueAgeMs = now() - backedUpSinceMs;
    if (
      queueAgeMs < QUEUE_AGE_WARN_THRESHOLD_MS &&
      (queueDepth < QUEUE_DEPTH_WARN_THRESHOLD ||
        queueAgeMs < QUEUE_DEPTH_WARN_MIN_AGE_MS)
    ) {
      return;
    }
    backpressureLogged = true;
    options.logger.warn(
      { queueDepth, queueAgeMs },
      "Daemon event queue is backing up; delivery may be stalled",
    );
  }

  function clearScheduledFlush(): void {
    if (flushTimer === null) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(delayMs: number): void {
    if (disposed || flushPromise !== null) {
      return;
    }
    if (flushTimer !== null) {
      if (delayMs > 0) {
        return;
      }
      clearScheduledFlush();
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch((error) => {
        options.logger.error(
          runtimeErrorLogFields(normalizeCaughtError(error)),
          "Daemon event delivery failed",
        );
      });
    }, delayMs);
  }

  async function deliverBatch(
    batch: readonly HostDaemonEventEnvelope[],
  ): Promise<number> {
    let response: EventPostResult;
    try {
      response = await options.postEvents([...batch]);
    } catch (error) {
      const normalized = normalizeCaughtError(error);
      if (!isPermanentPostRejection(normalized)) {
        options.logger.error(
          runtimeErrorLogFields(normalized),
          "Failed to post daemon events; will retry on the next flush",
        );
        return 0;
      }

      const [offending] = batch;
      if (batch.length === 1 && offending !== undefined) {
        options.logger.error(
          {
            ...runtimeErrorLogFields(normalized),
            eventType: offending.event.type,
            threadId: offending.threadId,
          },
          "Dropped a daemon event the server will never accept",
        );
        return 1;
      }

      const midpoint = Math.floor(batch.length / 2);
      const deliveredFromFirstHalf = await deliverBatch(
        batch.slice(0, midpoint),
      );
      if (deliveredFromFirstHalf < midpoint) {
        return deliveredFromFirstHalf;
      }
      return midpoint + (await deliverBatch(batch.slice(midpoint)));
    }

    if (response.rejectedEvents.length > 0) {
      options.logger.warn(
        {
          rejectedEvents: summarizeRejectedEvents(response.rejectedEvents),
        },
        "Server rejected daemon events",
      );
    }
    return batch.length;
  }

  async function drainQueue(): Promise<void> {
    while (queue.length > 0 && !disposed && options.isSessionOpen()) {
      const batch = queue.slice();
      const delivered = await deliverBatch(batch);
      queue.splice(0, delivered);
      if (queue.length === 0) {
        backedUpSinceMs = null;
        backpressureLogged = false;
      }
      if (delivered < batch.length) {
        return;
      }
    }
  }

  async function flush(): Promise<void> {
    clearScheduledFlush();
    if (flushPromise !== null) {
      await flushPromise;
      return;
    }

    flushPromise = drainQueue();
    try {
      await flushPromise;
    } finally {
      flushPromise = null;
    }
  }

  return {
    emit(input): void {
      if (disposed) {
        throw new EventSinkDisposedError();
      }
      if (backedUpSinceMs === null) {
        backedUpSinceMs = now();
      }
      queue.push({
        threadId: input.threadId,
        event: input.event,
      });
      maybeLogQueuePressure();
      scheduleFlush(
        shouldFlushThreadEventImmediately(input.event)
          ? 0
          : DEFAULT_DEBOUNCE_MS,
      );
    },
    flush,
    async dispose(): Promise<void> {
      disposed = true;
      clearScheduledFlush();
      if (flushPromise !== null) {
        await flushPromise.catch(() => undefined);
      }
      queue.length = 0;
    },
  };
}
