/**
 * THREAD LIFECYCLE — the designed two-axis model.
 *
 * This is no longer the behavior-neutral inventory of the original migration:
 * stop intent is now the `stopping` *status*, not a `stopRequestedAt`
 * side-field. The two axes are:
 *
 * - Execution status (one column): pending → starting → active → stopping →
 *   idle | error. Both the "working" intent (`active`) and the "stopping"
 *   intent (`stopping`) are real states here. `pending` sits before all of
 *   them: a thread that exists but has never cleared a dispatch attempt.
 * - Record fields (orthogonal): deletedAt, archivedAt — surfaced as the only
 *   supersession predicates (`notDeleted`, `notArchived`).
 *
 * `stop.requested` replaces the old `markThreadStopRequested` field write. A
 * `stopping` row has NO run.started cell: dispatching new work into it is
 * structurally impossible, which is the table form of the old
 * `notStopRequested` guard. A settled stop lands on `idle` (`stop.settled` or
 * `run.succeeded`) or `error` (`run.failed`). THREAD_LIFECYCLE and
 * THREAD_LIFECYCLE_EVENT_PREDICATES in src/thread-lifecycle.ts are the source
 * of truth; these assertions pin them.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateThreadLifecycleEvent,
  THREAD_LIFECYCLE,
  THREAD_LIFECYCLE_EVENT_PREDICATES,
  type ThreadLifecycleEventType,
  type ThreadLifecycleRowState,
} from "../src/thread-lifecycle.js";
import { threadStatusValues, type ThreadStatus } from "../src/thread-status.js";

const allEventTypes: readonly ThreadLifecycleEventType[] = [
  "run.preparing",
  "run.started",
  "run.succeeded",
  "run.failed",
  "stop.requested",
  "stop.settled",
];

function rowState(
  status: ThreadStatus,
  overrides?: Partial<Omit<ThreadLifecycleRowState, "status">>,
): ThreadLifecycleRowState {
  return {
    archivedAt: null,
    deletedAt: null,
    status,
    ...overrides,
  };
}

function statusWithCell(eventType: ThreadLifecycleEventType): ThreadStatus {
  const status = threadStatusValues.find(
    (candidate) => THREAD_LIFECYCLE[candidate][eventType] !== undefined,
  );
  if (!status) {
    throw new Error(`No table cell found for event ${eventType}`);
  }
  return status;
}

describe("THREAD_LIFECYCLE table", () => {
  it("covers every thread status", () => {
    expect(Object.keys(THREAD_LIFECYCLE).sort()).toEqual(
      [...threadStatusValues].sort(),
    );
  });

  it("declares predicates for every event type", () => {
    expect([...allEventTypes].sort()).toEqual(
      Object.keys(THREAD_LIFECYCLE_EVENT_PREDICATES).sort(),
    );
  });

  it("matches the designed two-axis transitions exactly", () => {
    expect(THREAD_LIFECYCLE).toEqual({
      pending: {
        "run.preparing": "starting",
      },
      idle: {
        "run.preparing": "starting",
        "run.started": "active",
      },
      starting: {
        "run.started": "active",
        "run.succeeded": "idle",
        "run.failed": "error",
        "stop.requested": "stopping",
      },
      active: {
        "run.succeeded": "idle",
        "run.failed": "error",
        "stop.requested": "stopping",
      },
      stopping: {
        "run.succeeded": "idle",
        "run.failed": "error",
        "stop.settled": "idle",
      },
      error: {
        "run.preparing": "starting",
        "run.started": "active",
      },
    });
  });

  it("matches the designed predicates exactly", () => {
    expect(THREAD_LIFECYCLE_EVENT_PREDICATES).toEqual({
      "run.preparing": { notArchived: true, notDeleted: true },
      "run.started": { notArchived: true, notDeleted: true },
      "run.succeeded": {},
      "run.failed": { notDeleted: true },
      "stop.requested": {},
      "stop.settled": {},
    });
  });

  it("never maps a status onto itself", () => {
    for (const status of threadStatusValues) {
      for (const eventType of allEventTypes) {
        expect(THREAD_LIFECYCLE[status][eventType]).not.toBe(status);
      }
    }
  });
});

describe("evaluateThreadLifecycleEvent", () => {
  it("applies every table cell on a clean row", () => {
    for (const status of threadStatusValues) {
      for (const eventType of allEventTypes) {
        const to = THREAD_LIFECYCLE[status][eventType];
        if (to === undefined) {
          continue;
        }
        expect(
          evaluateThreadLifecycleEvent({
            event: { type: eventType },
            thread: rowState(status),
          }),
        ).toEqual({ to });
      }
    }
  });

  it("no-ops as illegal-transition for every absent cell on a clean row", () => {
    for (const status of threadStatusValues) {
      for (const eventType of allEventTypes) {
        if (THREAD_LIFECYCLE[status][eventType] !== undefined) {
          continue;
        }
        expect(
          evaluateThreadLifecycleEvent({
            event: { type: eventType },
            thread: rowState(status),
          }),
        ).toEqual({
          noop: "illegal-transition",
          detail: `no transition for ${eventType} from status ${status}`,
        });
      }
    }
  });

  it("supersedes or ignores each staleness signal exactly as declared", () => {
    const signals = [
      {
        detail: "deletedAt set",
        flag: "notDeleted",
        overrides: { deletedAt: 1_000 },
      },
      {
        detail: "archivedAt set",
        flag: "notArchived",
        overrides: { archivedAt: 1_000 },
      },
    ] as const;

    for (const eventType of allEventTypes) {
      const predicates = THREAD_LIFECYCLE_EVENT_PREDICATES[eventType];
      const status = statusWithCell(eventType);
      for (const signal of signals) {
        const evaluation = evaluateThreadLifecycleEvent({
          event: { type: eventType },
          thread: rowState(status, signal.overrides),
        });
        if (predicates[signal.flag]) {
          expect(evaluation).toEqual({
            noop: "superseded",
            detail: signal.detail,
          });
        } else {
          expect(evaluation).toEqual({
            to: THREAD_LIFECYCLE[status][eventType],
          });
        }
      }
    }
  });

  it("settles a stopping thread to idle when its work completes on its own", () => {
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.succeeded" },
        thread: rowState("stopping"),
      }),
    ).toEqual({ to: "idle" });
  });

  it("does not reactivate a stopping thread on dispatched/started work", () => {
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.started" },
        thread: rowState("stopping"),
      }),
    ).toEqual({
      noop: "illegal-transition",
      detail: "no transition for run.started from status stopping",
    });
  });

  it("reports superseded before illegal-transition", () => {
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.started" },
        thread: rowState("active", { deletedAt: 1_000 }),
      }),
    ).toEqual({ noop: "superseded", detail: "deletedAt set" });
  });

  it("checks deleted, then archived", () => {
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.started" },
        thread: rowState("starting", {
          archivedAt: 1_000,
          deletedAt: 1_000,
        }),
      }),
    ).toEqual({ noop: "superseded", detail: "deletedAt set" });
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.started" },
        thread: rowState("starting", {
          archivedAt: 1_000,
        }),
      }),
    ).toEqual({ noop: "superseded", detail: "archivedAt set" });
  });
});

/**
 * `pending` — a thread created but never dispatched. The queue rework makes
 * this a real status rather than a display-only decoration, so the table's
 * one entry and, more importantly, its three DELIBERATE omissions are pinned
 * here: each absent cell is a guarantee some other layer relies on.
 */
describe("pending threads", () => {
  it("leaves pending only when a first dispatch attempt clears", () => {
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.preparing" },
        thread: rowState("pending"),
      }),
    ).toEqual({ to: "starting" });
  });

  it("cannot be activated directly: a pending thread has no session", () => {
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.started" },
        thread: rowState("pending"),
      }),
    ).toEqual({
      noop: "illegal-transition",
      detail: "no transition for run.started from status pending",
    });
  });

  it("stays pending when an attempt fails, rather than erroring the thread", () => {
    // A gate that rejects the first attempt fails the SEND. The thread is
    // still unprovisioned and unstarted, so it must remain exactly where it
    // was — the sender can amend and try again.
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.failed" },
        thread: rowState("pending"),
      }),
    ).toEqual({
      noop: "illegal-transition",
      detail: "no transition for run.failed from status pending",
    });
  });

  it("is not startable once archived or deleted", () => {
    // A scheduled send whose thread the user threw away must not provision it.
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.preparing" },
        thread: rowState("pending", { deletedAt: 1_000 }),
      }),
    ).toEqual({ noop: "superseded", detail: "deletedAt set" });
    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "run.preparing" },
        thread: rowState("pending", { archivedAt: 1_000 }),
      }),
    ).toEqual({ noop: "superseded", detail: "archivedAt set" });
  });
});
