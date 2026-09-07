import {
  claimQueuedThreadMessageGroup,
  getLatestThreadSequence,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  setThreadExecutionOverride,
} from "@bb/db";
import type { ThreadQueuedMessage } from "@bb/domain";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { buildTurnFailedEvent } from "../../src/services/threads/turn-failed.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/turn-failed-project";

type MessageDispatchRegistration = PluginHookRegistration<"message.dispatch">;

/**
 * The hook registry. Reading a mapped type through a generic key is sound,
 * which is what lets the fake provider satisfy `listHooks<K>` with no cast.
 */
type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function installHooks(
  handlers: Partial<{ "message.dispatch": MessageDispatchRegistration[] }>,
): void {
  const registry: HookRegistry = {
    "message.dispatch": handlers["message.dispatch"] ?? [],
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: async (_pluginId, _label, run) => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    decisionTimeoutMs: 10_000,
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
  setPluginThreadEventEmitter(undefined);
});

/**
 * Records which lifecycle seams announced a `turn.failed`, through the very
 * bridge createApp registers the plugin service through.
 */
function recordTurnFailedAnnouncements(): string[] {
  const announced: string[] = [];
  setPluginThreadEventEmitter({
    emitThreadCreated: () => {},
    emitThreadActive: () => {},
    emitThreadIdle: () => {},
    emitThreadFailed: () => {},
    emitThreadArchived: () => {},
    emitThreadDeleted: () => {},
    emitInteractionPending: () => {},
    emitMessageQueued: () => {},
    emitMessageDispatched: () => {},
    emitTurnFailed: (threadId) => announced.push(threadId),
  });
  return announced;
}

/**
 * A thread whose most recent turn is the user's original request.
 *
 * `seedThreadRuntimeState` writes that request itself, so this deliberately
 * does not add another: the retry tests are about how many `client/turn/
 * requested` events exist, and a second seeded one would hide a duplicate.
 */
function seedFailableThread(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "active",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    inputText: "Do the thing",
    providerThreadId: `provider-${hostId}`,
    threadId: thread.id,
  });
  return {
    environment,
    host,
    project,
    thread,
    requestId: lastTurnRequest(harness, thread.id).requestId,
  };
}

interface StoredTurnRequest {
  execution: { model: string };
  initiator: string;
  input: { text: string; visibility?: string }[];
  requestId: string;
  retryAttempt?: number;
  retryOfRequestId?: string;
}

function turnRequestData(event: { data: string }): StoredTurnRequest {
  return JSON.parse(event.data) as StoredTurnRequest;
}

function lastTurnRequest(
  harness: TestAppHarness,
  threadId: string,
): StoredTurnRequest {
  const events = turnRequests(harness, threadId);
  const last = events[events.length - 1];
  if (last === undefined) throw new Error("expected a turn request");
  return turnRequestData(last);
}

function seedRateLimitFailure(
  harness: TestAppHarness,
  args: {
    environmentId: string;
    threadId: string;
    resetsAtMs: number;
    category?: string;
  },
) {
  const providerThreadId = "provider-session";
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "provider/rateLimits/updated",
    scope: { kind: "thread" },
    data: {
      providerThreadId,
      rateLimits: {
        providerId: "codex",
        status: "blocked",
        kind: "subscription-window",
        windows: [
          {
            providerKey: "primary",
            label: "Current session",
            status: "blocked",
            resetsAtMs: args.resetsAtMs,
          },
        ],
        reachedReason: "rate_limit_reached",
        overageStatus: null,
        overageReason: null,
      },
    },
  });
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "provider/error",
    scope: { kind: "thread" },
    data: {
      providerThreadId,
      message: "Usage limit reached",
      errorInfo: {
        category: args.category ?? "rate-limit",
        providerCode: "usage_limit_reached",
        httpStatusCode: 429,
      },
    },
  });
}

/**
 * The provider's acceptance record for a request, as the assembler stores it.
 * Its presence is what makes a later failure "accepted-then-failed".
 */
function seedInputAccepted(
  harness: TestAppHarness,
  args: { environmentId: string; threadId: string; requestId: string },
) {
  const providerThreadId = "provider-session";
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "turn/input/accepted",
    scope: { kind: "turn", turnId: "turn-1" },
    data: {
      providerThreadId,
      clientRequestId: args.requestId,
    },
  });
}

/**
 * The rejection row the command-failure settlement writes when a dispatch dies
 * at the door: `reason` carries the daemon's error code verbatim, which for a
 * runtime-typed rejection is `rate_limited` or `auth_required`.
 */
function seedDoorRejection(
  harness: TestAppHarness,
  args: {
    environmentId: string;
    threadId: string;
    requestId: string;
    reason: string;
  },
) {
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "client/turn/rejected",
    scope: { kind: "thread" },
    data: {
      requestId: args.requestId,
      reason: args.reason,
      message: "Command turn.submit failed",
    },
  });
}

function failThread(harness: TestAppHarness, threadId: string): void {
  applyLoggedThreadLifecycleEvent(harness.deps, {
    event: { type: "run.failed" },
    threadId,
  });
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
}

/** The thread's queued rows: a live queued row with a wait on it. */
function queuedRows(
  harness: TestAppHarness,
  threadId: string,
): ThreadQueuedMessage[] {
  return listQueuedThreadMessages(harness.db, threadId)
    .map(toThreadQueuedMessage)
    .filter((entry) => entry.waitingOn !== null);
}

function onlyQueuedRow(
  harness: TestAppHarness,
  threadId: string,
): ThreadQueuedMessage {
  const rows = queuedRows(harness, threadId);
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(`expected exactly one queued row, found ${rows.length}`);
  }
  return rows[0];
}

/** The thread row as the retry service takes it. */
function requireThread(harness: TestAppHarness, threadId: string) {
  const thread = getThread(harness.db, threadId);
  if (thread === null) throw new Error("expected a thread");
  return thread;
}

/**
 * Fires the due sweep as the timer would once the retry's `sendAt` passed.
 * The sweep re-attempts the row through the same dispatch checkpoint an inline
 * send uses, which is what these tests are actually about.
 */
async function sweepPastResume(harness: TestAppHarness): Promise<void> {
  await runQueuedMessageDispatch(harness.deps, {
    kind: "time-reached",
    now: Date.now() + 120_000,
  });
}

describe("the turn.failed announcement", () => {
  it("carries the failed turn's ids and the provider's failure facts", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-ctx",
      );
      const resetsAtMs = Date.now() + 3_600_000;
      seedRateLimitFailure(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        resetsAtMs,
      });

      failThread(harness, thread.id);

      const event = buildTurnFailedEvent(harness.db, thread.id);
      if (event === null) throw new Error("expected a turn.failed payload");
      expect(event.threadId).toBe(thread.id);
      expect(event.requestId).toBe(requestId);
      // A first failure is attempt 1; the retry marker is what makes it 2.
      expect(event.attemptNumber).toBe(1);
      expect(event.errorInfo).toEqual({
        category: "rate-limit",
        providerCode: "usage_limit_reached",
        httpStatusCode: 429,
      });
      expect(event.rateLimits?.windows[0]?.resetsAtMs).toBe(resetsAtMs);
    });
  });

  it("labels a typed door rejection and reports the input as never accepted", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-door",
      );
      seedDoorRejection(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        requestId,
        reason: "rate_limited",
      });
      failThread(harness, thread.id);

      const event = buildTurnFailedEvent(harness.db, thread.id);
      // The rejection never reached a provider turn, so the typed code on the
      // rejection row is the failure's only classification — without this
      // mapping a door-rejected rate limit is invisible to a retry policy.
      expect(event?.errorInfo).toEqual({
        category: "rate-limit",
        providerCode: null,
        httpStatusCode: null,
      });
      expect(event?.turnId).toBeNull();
      expect(event?.inputAccepted).toBe(false);

      const unmapped = seedFailableThread(harness, "host-door-unmapped");
      seedDoorRejection(harness, {
        environmentId: unmapped.environment.id,
        threadId: unmapped.thread.id,
        requestId: unmapped.requestId,
        reason: "stale_turn",
      });
      failThread(harness, unmapped.thread.id);
      // A reason without a typed classification stays null rather than
      // guessing a category.
      expect(
        buildTurnFailedEvent(harness.db, unmapped.thread.id)?.errorInfo,
      ).toBeNull();
    });
  });

  it("reports acceptance when the provider took the input before failing", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-accepted",
      );
      seedInputAccepted(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        requestId,
      });
      seedRateLimitFailure(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        resetsAtMs: Date.now() + 3_600_000,
      });
      failThread(harness, thread.id);

      expect(buildTurnFailedEvent(harness.db, thread.id)?.inputAccepted).toBe(
        true,
      );
    });
  });

  it("is announced for a failure and for nothing else", async () => {
    await withTestHarness(async (harness) => {
      const announced = recordTurnFailedAnnouncements();
      const succeeding = seedFailableThread(harness, "host-ok").thread;
      const failing = seedFailableThread(harness, "host-not-ok").thread;

      // A turn that finished is not news to a retry policy, and neither is a
      // thread the user stopped: only `run.failed` announces.
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.succeeded" },
        threadId: succeeding.id,
      });
      expect(announced).toEqual([]);

      failThread(harness, failing.id);
      expect(announced).toEqual([failing.id]);
    });
  });
});

describe("retrying a failed turn", () => {
  it("queues a by-reference row on the clock and re-submits the original turn", async () => {
    await withTestHarness(async (harness) => {
      const sendAt = Date.now() + 60_000;
      const { requestId, thread } = seedFailableThread(harness, "host-retry");
      failThread(harness, thread.id);

      const result = await retryFailedTurn(harness.deps, {
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: requestId, sendAt, reason: "Rate limited" },
      });

      expect(result).toMatchObject({
        delivery: "queued",
        turnRequestId: requestId,
        attempt: 2,
      });
      const queued = onlyQueuedRow(harness, thread.id);
      // A by-reference row: it names the request it will re-submit and carries
      // the retrier's reason, and it is due at `sendAt` so the ordinary due
      // sweep — the same one a scheduled send uses — is what wakes it.
      expect(queued.payload).toEqual({
        kind: "retry",
        retryOfTurnRequestId: requestId,
        attempt: 2,
        reason: "Rate limited",
      });
      expect(queued.waitingOn).toEqual({ kind: "time" });
      expect(queued.sendAt).toBe(sendAt);

      await sweepPastResume(harness);

      const requests = turnRequests(harness, thread.id);
      expect(requests).toHaveLength(2);
      const retryRequest = requests[1];
      if (retryRequest === undefined) throw new Error("expected a retry turn");
      const data = turnRequestData(retryRequest);

      // The retry marker is on the new attempt, pointing back at the original.
      expect(data.retryOfRequestId).toBe(requestId);
      expect(data.retryAttempt).toBe(2);
      // The provider is asked the identical question...
      expect(data.input[0]?.text).toBe("Do the thing");
      expect(data.execution.model).toBe("gpt-5");
      // ...but nothing re-enters the conversation as the user: the retry is a
      // system dispatch whose blocks are agent-only, which is what keeps the
      // timeline from showing "Do the thing" twice.
      expect(data.initiator).toBe("system");
      expect(data.input[0]?.visibility).toBe("agent-only");
      const userRequests = turnRequests(harness, thread.id).filter(
        (event) => turnRequestData(event).initiator === "user",
      );
      expect(userRequests).toHaveLength(1);
      // The row was consumed by the dispatch rather than left on the queue.
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("continues an accepted turn instead of re-asking it", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-continue",
      );
      seedInputAccepted(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        requestId,
      });
      failThread(harness, thread.id);

      const result = await retryFailedTurn(harness.deps, {
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: requestId,
          sendAt: null,
          reason: "Rate limited",
        },
      });
      expect(result.delivery).toBe("sent");

      const requests = turnRequests(harness, thread.id);
      expect(requests).toHaveLength(2);
      const retryRequest = requests[1];
      if (retryRequest === undefined) throw new Error("expected a retry turn");
      const data = turnRequestData(retryRequest);
      // The provider accepted "Do the thing" into its conversation before the
      // failure, and nothing rolls that back — so re-sending it would ask the
      // same question twice in a row. The retry nudges the accepted turn
      // forward instead, still marked as the same attempt chain.
      expect(data.retryOfRequestId).toBe(requestId);
      expect(data.retryAttempt).toBe(2);
      expect(data.input).toHaveLength(1);
      expect(data.input[0]?.text).toBe("Please continue.");
      expect(data.input[0]?.visibility).toBe("agent-only");
    });
  });

  it("dispatches immediately when no instant is named", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFailableThread(harness, "host-retry-now");
      failThread(harness, thread.id);

      const result = await retryFailedTurn(harness.deps, {
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: null, sendAt: null, reason: "Retry" },
      });

      // No row ever exists for a retry nothing is holding: it takes the same
      // path an unblocked send takes.
      expect(result.delivery).toBe("sent");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(turnRequests(harness, thread.id)).toHaveLength(2);
    });
  });

  it("replays the failed attempt's execution instead of re-resolving today's", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(harness, "host-exec");
      failThread(harness, thread.id);
      // The user moved the thread's sticky model AFTER the failure. The retry
      // re-runs a turn that was already composed against gpt-5, so the new
      // override must not silently swap the model under it — and replaying the
      // tuple must not overwrite the override the user just set, either.
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "gpt-6-pro",
      });

      await retryFailedTurn(harness.deps, {
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: requestId, sendAt: null, reason: "Retry" },
      });

      const requests = turnRequests(harness, thread.id);
      const retryRequest = requests[1];
      if (retryRequest === undefined) throw new Error("expected a retry turn");
      expect(turnRequestData(retryRequest).execution.model).toBe("gpt-5");
      expect(requireThread(harness, thread.id).modelOverride).toBe("gpt-6-pro");
    });
  });

  it("refuses the second of two concurrent retries of one failure", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(harness, "host-race");
      failThread(harness, thread.id);
      const retry = () =>
        retryFailedTurn(harness.deps, {
          thread: requireThread(harness, thread.id),
          request: {
            turnRequestId: requestId,
            sendAt: Date.now() + 60_000,
            reason: "Rate limited",
          },
        });

      // Two clients click Retry together. The queued-row check alone cannot
      // see a concurrent call that has passed it but written nothing yet, so
      // without the in-flight guard both would queue the same turn.
      const outcomes = await Promise.allSettled([retry(), retry()]);

      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      );
      expect(
        (rejected as PromiseRejectedResult | undefined)?.reason,
      ).toMatchObject({ body: { code: "retry_already_queued" } });
      expect(queuedRows(harness, thread.id)).toHaveLength(1);
    });
  });

  it("counts a retry's own failure as a later attempt of the same original", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(
        harness,
        "host-attempts",
      );
      failThread(harness, thread.id);
      await retryFailedTurn(harness.deps, {
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: requestId,
          sendAt: Date.now() + 60_000,
          reason: "Rate limited",
        },
      });
      await sweepPastResume(harness);

      failThread(harness, thread.id);
      const failedAgain = buildTurnFailedEvent(harness.db, thread.id);
      // The second failure is the RETRY's, so the policy sees attempt 2 and
      // the id of the attempt that just failed — core walks the chain back to
      // the user's turn itself when it queues the next one.
      expect(failedAgain?.attemptNumber).toBe(2);
      expect(failedAgain?.requestId).not.toBe(requestId);

      await retryFailedTurn(harness.deps, {
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: failedAgain?.requestId ?? null,
          sendAt: Date.now() + 60_000,
          reason: "Rate limited",
        },
      });
      expect(onlyQueuedRow(harness, thread.id).payload).toEqual({
        kind: "retry",
        retryOfTurnRequestId: requestId,
        attempt: 3,
        reason: "Rate limited",
      });
    });
  });

  it("still passes the dispatch hook when the retry comes back", async () => {
    await withTestHarness(async (harness) => {
      let dispatchCalls = 0;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "concurrency-limit",
            handler: (context) => {
              dispatchCalls += 1;
              // The re-attempt must look like a re-decision about an existing
              // queued row, not a fresh send, or a limiter would double-count
              // it — and the row it names is the retry, not a user message.
              expect(context.queuedMessage?.payload.kind).toBe("retry");
              return { action: "wait", reason: "At capacity" };
            },
          },
        ],
      });
      const { thread } = seedFailableThread(harness, "host-limit");
      failThread(harness, thread.id);
      await retryFailedTurn(harness.deps, {
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: null,
          sendAt: Date.now() + 60_000,
          reason: "Rate limited",
        },
      });

      await sweepPastResume(harness);

      expect(dispatchCalls).toBe(1);
      // The turn did not dispatch; the same row is queued again, this time by
      // the limiter, and its schedule is cleared because the limiter named no
      // instant of its own.
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      const requeued = onlyQueuedRow(harness, thread.id);
      expect(requeued.waitingOn).toEqual({
        kind: "plugin",
        pluginId: "concurrency-limit",
        reason: "At capacity",
      });
      expect(requeued.sendAt).toBeNull();
      expect(requeued.payload.kind).toBe("retry");
    });
  });

  it("refuses a thread that has not failed, a turn that is not the failed one, and a second live retry", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(harness, "host-refuse");
      const retry = (turnRequestId: string | null) =>
        retryFailedTurn(harness.deps, {
          thread: requireThread(harness, thread.id),
          request: {
            turnRequestId,
            sendAt: Date.now() + 60_000,
            reason: "Retry",
          },
        });

      // Still running: there is no failed turn to re-submit.
      await expect(retry(null)).rejects.toMatchObject({
        body: { code: "no_failed_turn" },
      });

      failThread(harness, thread.id);
      // A turn the caller decided about that is not the one that failed: the
      // thread moved on, so the decision no longer applies.
      await expect(retry("creq_2222222222")).rejects.toMatchObject({
        body: { code: "no_failed_turn" },
      });

      await retry(requestId);
      // One failure earns one retry; a duplicate or replayed failure must not
      // queue the same turn twice.
      await expect(retry(requestId)).rejects.toMatchObject({
        body: { code: "retry_already_queued" },
      });
      expect(queuedRows(harness, thread.id)).toHaveLength(1);

      // The due sweep has claimed the retry and is deciding about it: it
      // vanishes from the live queue, but it is still the one live retry of
      // this turn.
      const claimed = claimQueuedThreadMessageGroup(
        harness.db,
        harness.deps.hub,
        onlyQueuedRow(harness, thread.id).id,
        { kind: "explicit-send" },
      );
      expect(claimed).toHaveLength(1);
      await expect(retry(requestId)).rejects.toMatchObject({
        body: { code: "retry_already_queued" },
      });
    });
  });
});
