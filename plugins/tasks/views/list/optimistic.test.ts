import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/contract.js";
import {
  applyEdit,
  beginEdit,
  editedTasks,
  matchesFilters,
  pendingIds,
  reconcileEntries,
  settleFailure,
  settleSuccess,
  type TaskEntries,
} from "./optimistic.js";
import { makeTask } from "../../test-fixtures.js";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return makeTask({
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

const empty: TaskEntries = new Map();

describe("applyEdit / editedTasks", () => {
  it("overlays only the edited fields, including dueDate:null and position", () => {
    const base = task({ id: "T1", status: "todo", dueDate: "2026-07-20" });
    expect(applyEdit(base, undefined)).toBe(base);
    expect(applyEdit(base, {})).toBe(base);
    expect(applyEdit(base, { status: "done" }).status).toBe("done");
    expect(applyEdit(base, { dueDate: null }).dueDate).toBeNull();
    expect(applyEdit(base, { position: 42 }).position).toBe(42);
    expect(applyEdit(base, { status: "done" }).dueDate).toBe("2026-07-20");
  });

  it("returns a copy when there are no entries, overlays otherwise", () => {
    const tasks = [task({ id: "T1", status: "todo" }), task({ id: "T2" })];
    expect(editedTasks(tasks, empty)).not.toBe(tasks);
    const entries = beginEdit(empty, "T1", { status: "done" }, 1);
    const result = editedTasks(tasks, entries);
    expect(result[0]?.status).toBe("done");
    expect(result[1]).toBe(tasks[1]);
  });
});

describe("matchesFilters", () => {
  const t = task({
    id: "T1",
    status: "in_progress",
    priority: "high",
    labelIds: ["A"],
  });

  it("passes with no filters", () => {
    expect(matchesFilters(t, [], [], [])).toBe(true);
  });

  it("filters by status, priority, and label any-of", () => {
    expect(matchesFilters(t, ["in_progress"], [], [])).toBe(true);
    expect(matchesFilters(t, ["todo"], [], [])).toBe(false);
    expect(matchesFilters(t, [], ["low"], [])).toBe(false);
    expect(matchesFilters(t, [], [], ["A"])).toBe(true);
    expect(matchesFilters(t, [], [], ["B"])).toBe(false);
    expect(matchesFilters(t, [], [], ["B", "A"])).toBe(true);
  });
});

describe("begin / settle lifecycle", () => {
  it("reverts a solo failed edit and drops the now-empty entry", () => {
    let e = beginEdit(empty, "T1", { status: "done" }, 1);
    expect(e.get("T1")?.inFlight).toBe(1);
    expect([...pendingIds(e)]).toEqual(["T1"]);
    e = settleFailure(e, "T1", { status: "done" }, 1);
    expect(e.has("T1")).toBe(false);
  });

  it("keeps the optimistic value on success and clears pending", () => {
    let e = beginEdit(empty, "T1", { priority: "high" }, 1);
    e = settleSuccess(
      e,
      "T1",
      { priority: "high" },
      1,
      task({ id: "T1", priority: "high" }),
    );
    expect(e.get("T1")?.edit.priority).toBe("high");
    expect(pendingIds(e).size).toBe(0);
  });

  it("captures the server position on a successful status change only", () => {
    let statusEdit = beginEdit(empty, "T1", { status: "todo" }, 1);
    statusEdit = settleSuccess(
      statusEdit,
      "T1",
      { status: "todo" },
      1,
      task({ id: "T1", status: "todo", position: 4096 }),
    );
    expect(statusEdit.get("T1")?.edit.position).toBe(4096);

    let priorityEdit = beginEdit(empty, "T2", { priority: "high" }, 1);
    priorityEdit = settleSuccess(
      priorityEdit,
      "T2",
      { priority: "high" },
      1,
      task({ id: "T2", position: 4096 }),
    );
    expect(priorityEdit.get("T2")?.edit.position).toBeUndefined();
  });
});

describe("concurrent / out-of-order edits to one task", () => {
  it("a stale failure never reverts a newer edit, and pending survives it", () => {
    let e = beginEdit(empty, "T1", { status: "done" }, 1);
    e = beginEdit(e, "T1", { status: "canceled" }, 2);
    expect(e.get("T1")?.edit.status).toBe("canceled");
    expect(e.get("T1")?.inFlight).toBe(2);

    e = settleFailure(e, "T1", { status: "done" }, 1);
    expect(e.get("T1")?.edit.status).toBe("canceled");
    expect(e.get("T1")?.inFlight).toBe(1);
    expect(pendingIds(e).has("T1")).toBe(true);

    e = settleSuccess(
      e,
      "T1",
      { status: "canceled" },
      2,
      task({ id: "T1", status: "canceled", position: 900 }),
    );
    expect(e.get("T1")?.edit.status).toBe("canceled");
    expect(e.get("T1")?.edit.position).toBe(900);
    expect(pendingIds(e).size).toBe(0);
  });

  it("a stale success does not clobber a newer pending field", () => {
    let e = beginEdit(empty, "T1", { labelIds: ["A"] }, 1);
    e = beginEdit(e, "T1", { labelIds: ["A", "B"] }, 2);
    e = settleSuccess(
      e,
      "T1",
      { labelIds: ["A"] },
      1,
      task({ id: "T1", labelIds: ["A"] }),
    );
    expect(e.get("T1")?.edit.labelIds).toEqual(["A", "B"]);
    expect(e.get("T1")?.inFlight).toBe(1);
  });
});

describe("reconcileEntries", () => {
  it("drops confirmed fields, keeps unsettled, and drops orphans", () => {
    let e = beginEdit(empty, "T1", { status: "done", priority: "high" }, 1);
    e = settleSuccess(
      e,
      "T1",
      { status: "done", priority: "high" },
      1,
      task({ id: "T1", status: "done", position: 50 }),
    );
    const server = [
      task({ id: "T1", status: "done", priority: "low", position: 50 }),
    ];
    expect(reconcileEntries(e, server).get("T1")?.edit).toEqual({
      priority: "high",
    });
    expect(reconcileEntries(e, [task({ id: "T2" })]).size).toBe(0);
  });

  it("returns the same reference when nothing settles and keeps in-flight entries", () => {
    const e = beginEdit(empty, "T1", { status: "done" }, 1);
    expect(reconcileEntries(e, [task({ id: "T1", status: "todo" })])).toBe(e);
  });
});
