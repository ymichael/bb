import { jsonObjectSchema, turnScope } from "@bb/domain";
import type { Thread, ThreadEventPlanStep } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { extractThreadTimelinePendingTodos } from "../src/todo-snapshot-extraction.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";

const ACTIVE: Thread["status"] = "active";

function planStepsEvent({
  steps,
  seq,
  type = "item/completed",
  explanation,
}: {
  steps: ThreadEventPlanStep[];
  seq: number;
  type?: "item/started" | "item/completed";
  explanation?: string;
}): ThreadEventWithMeta {
  return {
    event: {
      type,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "planSteps",
        id: `plan-${seq}`,
        steps,
        ...(explanation === undefined ? {} : { explanation }),
        status: type === "item/completed" ? "completed" : "pending",
      },
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq },
  };
}

function legacyTodoWriteToolCallEvent(seq: number): ThreadEventWithMeta {
  return {
    event: {
      type: "item/completed",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "toolCall",
        id: `todo-write-${seq}`,
        tool: "TodoWrite",
        arguments: jsonObjectSchema.parse({
          todos: [{ content: "Legacy todo", status: "pending" }],
        }),
        status: "completed",
      },
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq },
  };
}

describe("extractThreadTimelinePendingTodos", () => {
  it("reads the latest planSteps snapshot, mapping step statuses to banner statuses", () => {
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 1,
        steps: [{ step: "Older snapshot", status: "active" }],
      }),
      planStepsEvent({
        seq: 2,
        steps: [
          { step: "Read the spec", status: "completed" },
          { step: "Writing the code", status: "active" },
          { step: "Run the tests", status: "pending" },
          { step: "Flaky step", status: "failed" },
          { step: "   ", status: "pending" },
          { step: "No status" },
        ],
      }),
    ]);
    expect(result).toEqual({
      sourceSeq: 2,
      updatedAt: 2,
      items: [
        { id: "seq:2:0", text: "Read the spec", status: "completed" },
        { id: "seq:2:1", text: "Writing the code", status: "in_progress" },
        { id: "seq:2:2", text: "Run the tests", status: "pending" },
        { id: "seq:2:3", text: "Flaky step", status: "completed" },
        { id: "seq:2:5", text: "No status", status: "pending" },
      ],
    });
  });

  it("picks the newest snapshot by sequence even when the input is unordered", () => {
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({ seq: 30, steps: [{ step: "third", status: "active" }] }),
      planStepsEvent({ seq: 10, steps: [{ step: "first", status: "active" }] }),
      planStepsEvent({
        seq: 20,
        steps: [{ step: "second", status: "active" }],
      }),
    ]);
    expect(result?.sourceSeq).toBe(30);
    expect(result?.items.map((item) => item.text)).toEqual(["third"]);
  });

  it("ignores an opened (pending) snapshot and an empty one clears the banner", () => {
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        planStepsEvent({
          seq: 5,
          type: "item/started",
          steps: [{ step: "not settled", status: "active" }],
        }),
      ]),
    ).toBeNull();
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        planStepsEvent({ seq: 6, steps: [{ step: "old", status: "active" }] }),
        planStepsEvent({ seq: 7, steps: [] }),
      ]),
    ).toEqual({ sourceSeq: 7, updatedAt: 7, items: [] });
  });

  it("does not read a tool call by its name, whatever its arguments carry", () => {
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        legacyTodoWriteToolCallEvent(41),
      ]),
    ).toBeNull();
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 42,
        steps: [{ step: "planned", status: "active" }],
      }),
      legacyTodoWriteToolCallEvent(43),
    ]);
    expect(result?.sourceSeq).toBe(42);
  });

  it("returns null unless the thread is active", () => {
    const events = [
      planStepsEvent({ seq: 1, steps: [{ step: "x", status: "active" }] }),
    ];
    expect(extractThreadTimelinePendingTodos("idle", events)).toBeNull();
    expect(extractThreadTimelinePendingTodos("error", events)).toBeNull();
    expect(extractThreadTimelinePendingTodos(ACTIVE, events)).not.toBeNull();
  });
});
