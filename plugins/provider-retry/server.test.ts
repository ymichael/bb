import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeTurnFailedEvent,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import plugin from "./server.js";
import {
  MAX_RETRY_ATTEMPTS,
  OVERLOAD_RETRY_BASE_MS,
  RESET_BUFFER_MS,
  RESET_JITTER_MS,
  decideRetry,
} from "./src/retry-policy.js";

type QueueEntry = ReturnType<typeof makeQueueEntry>;

const NOW_MS = Date.parse("2026-08-05T12:00:00.000Z");
const RESET_AT_MS = NOW_MS + 5 * 60 * 60 * 1_000;
const HOST_ID = "host-one";
const THREAD_ID = "thread-limited";
const REQUEST_ID = "creq_aaaaaaaaaa";
const PLUGIN_ID = "provider-retry";

type RateLimits = NonNullable<PluginTurnFailedEvent["rateLimits"]>;

function rateLimits(overrides: Partial<RateLimits> = {}): RateLimits {
  return {
    providerId: "codex",
    status: "blocked",
    kind: "subscription-window",
    windows: [
      {
        providerKey: "primary",
        label: "Current session",
        status: "blocked",
        resetsAtMs: RESET_AT_MS,
      },
    ],
    reachedReason: "rate_limit_reached",
    overageStatus: null,
    overageReason: null,
    ...overrides,
  };
}

function failure(
  overrides: Partial<PluginTurnFailedEvent> = {},
): PluginTurnFailedEvent {
  return makeTurnFailedEvent({
    threadId: THREAD_ID,
    requestId: REQUEST_ID,
    errorInfo: {
      category: "rate-limit",
      providerCode: "usage_limit_reached",
      httpStatusCode: 429,
    },
    rateLimits: rateLimits(),
    ...overrides,
  });
}

function overloadedFailure(
  overrides: Partial<PluginTurnFailedEvent> = {},
): PluginTurnFailedEvent {
  return failure({
    errorInfo: {
      category: "overloaded",
      providerCode: "serverOverloaded",
      httpStatusCode: 529,
    },
    rateLimits: null,
    ...overrides,
  });
}

/**
 * A queued retry as the server would return it: a retry payload and a `sendAt`
 * for core's due sweep.
 */
function queuedRetry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return makeQueueEntry({
    id: "queued_1",
    threadId: THREAD_ID,
    sendAt: RESET_AT_MS + RESET_BUFFER_MS,
    waitingOn: { kind: "time" },
    payload: {
      kind: "retry",
      retryOfTurnRequestId: REQUEST_ID,
      attempt: 2,
      reason: "Rate limited",
    },
    ...overrides,
  });
}

interface QueuedMessageTarget {
  threadId: string;
  queuedMessageId: string;
}
interface QueuedMessageSend extends QueuedMessageTarget {
  mode: string;
}

interface RetryRequest {
  threadId: string;
  turnRequestId?: string;
  sendAt?: number;
  reason?: string;
}

function createHost(queued: QueueEntry[] = []) {
  const deleted: QueuedMessageTarget[] = [];
  const sent: QueuedMessageSend[] = [];
  const retries: RetryRequest[] = [];
  const sdk: CreateFakePluginHostOptions["sdk"] = {
    threads: {
      queue: { list: async () => queued },
      retry: async (args: RetryRequest) => {
        retries.push(args);
        return {
          ok: true,
          delivery: "queued",
          turnRequestId: args.turnRequestId ?? REQUEST_ID,
          attempt: 2,
          queuedMessageId: "queued_1",
          waitingOn: { kind: "time" },
          sendAt: args.sendAt ?? null,
        };
      },
      queuedMessages: {
        delete: async (args: QueuedMessageTarget) => {
          deleted.push(args);
          return { ok: true };
        },
        send: async (args: QueuedMessageSend) => {
          sent.push(args);
          return { ok: true };
        },
      },
    },
  };
  return {
    ...createFakePluginHost({ pluginId: PLUGIN_ID, sdk }),
    deleted,
    retries,
    sent,
  };
}

describe("provider retry policy", () => {
  it("waits for the reported reset plus a buffer, jittered within its bound", () => {
    // The jitter is what keeps every thread on one exhausted account from
    // retrying in the same instant, so its bounds are the contract: never
    // before the buffer, never a full jitter window past it.
    const earliest = decideRetry({
      failure: failure(),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0,
    });
    const latest = decideRetry({
      failure: failure(),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0.999_999,
    });
    expect(earliest).toEqual({
      kind: "retry",
      sendAt: RESET_AT_MS + RESET_BUFFER_MS,
      reason: "Rate limited",
    });
    expect(latest.kind).toBe("retry");
    if (latest.kind !== "retry") return;
    expect(latest.sendAt).toBeGreaterThan(RESET_AT_MS + RESET_BUFFER_MS);
    expect(latest.sendAt).toBeLessThan(
      RESET_AT_MS + RESET_BUFFER_MS + RESET_JITTER_MS,
    );
  });

  it("never schedules a retry in the past when the reset has already passed", () => {
    const decision = decideRetry({
      failure: failure({
        rateLimits: rateLimits({
          windows: [
            {
              providerKey: "primary",
              label: "Current session",
              status: "blocked",
              resetsAtMs: NOW_MS - 60_000,
            },
          ],
        }),
      }),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0,
    });
    expect(decision).toEqual({
      kind: "retry",
      sendAt: NOW_MS + RESET_BUFFER_MS,
      reason: "Rate limited",
    });
  });

  it("waits for the latest blocked window, not the first to open", () => {
    const weekly = RESET_AT_MS + 48 * 60 * 60 * 1_000;
    const decision = decideRetry({
      failure: failure({
        rateLimits: rateLimits({
          windows: [
            {
              providerKey: "session",
              label: "Session",
              status: "blocked",
              resetsAtMs: RESET_AT_MS,
            },
            {
              providerKey: "weekly",
              label: "Weekly",
              status: "blocked",
              resetsAtMs: weekly,
            },
          ],
        }),
      }),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0,
    });
    expect(decision).toEqual({
      kind: "retry",
      sendAt: weekly + RESET_BUFFER_MS,
      reason: "Rate limited",
    });
  });

  it("declines a reset beyond the configured maximum wait", () => {
    expect(
      decideRetry({
        failure: failure(),
        maximumWaitMs: 60 * 60 * 1_000,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "beyond-maximum-wait" });
    // The same window is fine once the limit is raised past it.
    expect(
      decideRetry({
        failure: failure(),
        maximumWaitMs: 24 * 60 * 60 * 1_000,
        now: NOW_MS,
        random: 0,
      }).kind,
    ).toBe("retry");
  });

  it("retries overloads with exponential backoff and bounded jitter", () => {
    const overloaded = overloadedFailure();
    expect(
      decideRetry({
        failure: overloaded,
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({
      kind: "retry",
      sendAt: NOW_MS + OVERLOAD_RETRY_BASE_MS,
      reason: "Provider overloaded",
    });
    const fourthAttempt = decideRetry({
      failure: { ...overloaded, attemptNumber: 4 },
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0.999_999,
    });
    expect(fourthAttempt.kind).toBe("retry");
    if (fourthAttempt.kind !== "retry") return;
    const fourthDelay = OVERLOAD_RETRY_BASE_MS * 2 ** 3;
    expect(fourthAttempt.sendAt).toBeGreaterThan(NOW_MS + fourthDelay);
    expect(fourthAttempt.sendAt).toBeLessThan(NOW_MS + fourthDelay * 2);
  });

  it("declines failures that are not retryable, and limits that do not reset", () => {
    expect(
      decideRetry({
        failure: failure({
          errorInfo: {
            category: "internal",
            providerCode: null,
            httpStatusCode: 500,
          },
        }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "not-retryable" });
    expect(
      decideRetry({
        failure: failure({ rateLimits: null }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "no-rate-limit-state" });
    // Credits do not come back on a clock, so waiting is not a fix.
    expect(
      decideRetry({
        failure: failure({ rateLimits: rateLimits({ kind: "credits" }) }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "not-resettable" });
  });

  it("gives up once a turn has been retried its maximum number of times", () => {
    expect(
      decideRetry({
        failure: failure({ attemptNumber: MAX_RETRY_ATTEMPTS }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "attempts-exhausted" });
    expect(
      decideRetry({
        failure: failure({ attemptNumber: MAX_RETRY_ATTEMPTS - 1 }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }).kind,
    ).toBe("retry");
    expect(
      decideRetry({
        failure: overloadedFailure({ attemptNumber: MAX_RETRY_ATTEMPTS }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "attempts-exhausted" });
  });
});

describe("provider retry plugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens for one event and answers no hook", async () => {
    // The load-bearing half is the empty hook slot. This plugin must never
    // intercept a send: a remembered rate limit is a stale cache of provider
    // state, and refusing an attempt on it strands a user who fixed the limit
    // out of band.
    const host = createHost();
    await plugin(host.bb);

    expect(host.harness.registrations.settingsDescriptors).toEqual({
      maximumWait: {
        type: "select",
        label: "Maximum automatic wait",
        description:
          "Do not schedule a subscription-limit retry when its reset is farther away than this.",
        options: ["6 hours", "24 hours", "No limit"],
        default: "6 hours",
      },
    });
    expect(host.harness.registrations.threadEventHandlers["turn.failed"]).toBe(
      1,
    );
    expect(host.harness.registrations.hooks["message.dispatch"]).toBeNull();
    expect(
      host.harness.registrations.cli?.commands.map((command) => command.name),
    ).toEqual(["status", "cancel", "retry"]);
    await host.harness.dispose();
  });

  it("asks core to retry the failed turn at the reset window", async () => {
    const host = createHost();
    await plugin(host.bb);

    const { errors } = await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );

    expect(errors).toEqual([]);
    expect(host.retries).toHaveLength(1);
    const retry = host.retries[0];
    expect(retry?.threadId).toBe(THREAD_ID);
    // By reference: core re-submits the turn itself, so the id is the whole of
    // what this plugin has to say about WHAT to retry.
    expect(retry?.turnRequestId).toBe(REQUEST_ID);
    expect(retry?.sendAt).toBeGreaterThanOrEqual(RESET_AT_MS + RESET_BUFFER_MS);
    // Just the cause, no time: every surface renders the row's `sendAt`
    // itself, so a time here shows up twice on the card and in the queue list.
    expect(retry?.reason).toBe("Rate limited");
    await host.harness.dispose();
  });

  it("asks core to retry an overloaded turn after backoff", async () => {
    const host = createHost();
    await plugin(host.bb);

    const { errors } = await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      overloadedFailure(),
    );

    expect(errors).toEqual([]);
    expect(host.retries).toHaveLength(1);
    expect(host.retries[0]).toMatchObject({
      threadId: THREAD_ID,
      turnRequestId: REQUEST_ID,
      reason: "Provider overloaded",
    });
    expect(host.retries[0]?.sendAt).toBeGreaterThanOrEqual(
      NOW_MS + OVERLOAD_RETRY_BASE_MS,
    );
    expect(host.retries[0]?.sendAt).toBeLessThan(
      NOW_MS + OVERLOAD_RETRY_BASE_MS * 2,
    );
    await host.harness.dispose();
  });

  it("leaves ordinary failures alone", async () => {
    const host = createHost();
    await plugin(host.bb);

    await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({
        errorInfo: {
          category: "internal",
          providerCode: null,
          httpStatusCode: 500,
        },
      }),
    );

    expect(host.retries).toEqual([]);
    await host.harness.dispose();
  });

  it("re-reads the maximum wait when the setting changes", async () => {
    // The listener closes over a cached number, so the `onChange` wiring is the
    // only thing that stops a raised limit from being ignored until restart.
    const host = createHost();
    await plugin(host.bb);
    const beyondSixHours = failure({
      rateLimits: rateLimits({
        windows: [
          {
            providerKey: "primary",
            label: "Weekly",
            status: "blocked",
            resetsAtMs: NOW_MS + 7 * 60 * 60 * 1_000,
          },
        ],
      }),
    });

    await host.harness.behavior.emitThreadEvent("turn.failed", beyondSixHours);
    expect(host.retries).toEqual([]);

    await host.harness.setSettings({ maximumWait: "No limit" });
    await host.harness.behavior.emitThreadEvent("turn.failed", beyondSixHours);
    expect(host.retries).toHaveLength(1);
    await host.harness.dispose();
  });

  it("reports pending retries from the queue rather than private state", async () => {
    const host = createHost([queuedRetry()]);
    await plugin(host.bb);

    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout ?? "")).toEqual({
      retries: [
        {
          id: "queued_1",
          threadId: THREAD_ID,
          sendAt: RESET_AT_MS + RESET_BUFFER_MS,
        },
      ],
    });
    // Scoped to the thread the user asked about; a retry is identified by its
    // payload, not by a wait this plugin owns.
    expect(
      host.harness.inspection.sdk.callsTo("threads.queue.list")[0]?.[0],
    ).toEqual({ threadId: THREAD_ID });
    await host.harness.dispose();
  });

  it("cancels by deleting the queued row and retries by sending it now", async () => {
    // Both are the affordances the user already has on the queued card, rather
    // than a second mechanism this plugin owns.
    const host = createHost([queuedRetry()]);
    await plugin(host.bb);

    const cancelled = await host.harness.runCli(["cancel", THREAD_ID]);
    expect(cancelled.exitCode).toBe(0);
    expect(host.deleted).toEqual([
      { threadId: THREAD_ID, queuedMessageId: "queued_1" },
    ]);

    const retried = await host.harness.runCli(["retry", THREAD_ID]);
    expect(retried.exitCode).toBe(0);
    expect(host.sent).toEqual([
      { threadId: THREAD_ID, queuedMessageId: "queued_1", mode: "auto" },
    ]);
    await host.harness.dispose();
  });

  it("reports no pending retry when no row is queued", async () => {
    const host = createHost();
    await plugin(host.bb);

    const status = await host.harness.runCli(["status"]);
    expect(status.stdout).toBe("No provider retries are pending.\n");
    const cancelled = await host.harness.runCli(["cancel", THREAD_ID]);
    expect(cancelled.exitCode).toBe(1);
    expect(host.deleted).toEqual([]);
    await host.harness.dispose();
  });
});
