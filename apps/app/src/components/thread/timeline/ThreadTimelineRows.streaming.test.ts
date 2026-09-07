import { buildTimelineViewRows } from "@bb/thread-view";
import { describe, expect, it } from "vitest";
import {
  commandRow,
  conversationRow,
  delegationRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { findStreamingAssistantMessageId } from "./ThreadTimelineRows";

describe("findStreamingAssistantMessageId", () => {
  it("returns the trailing top-level assistant message", () => {
    const rows = buildTimelineViewRows([
      conversationRow({ id: "user_1", role: "user", text: "Hi", seq: 1 }),
      conversationRow({
        id: "assistant_1",
        role: "assistant",
        text: "Working on it",
        seq: 2,
      }),
    ]);
    expect(findStreamingAssistantMessageId(rows)).toBe("assistant_1");
  });

  it("returns null when later work follows the assistant message or the last row is not assistant text", () => {
    const rows = buildTimelineViewRows([
      conversationRow({
        id: "assistant_1",
        role: "assistant",
        text: "Let me check",
        seq: 1,
      }),
      commandRow({ id: "cmd_1", command: "ls", seq: 2, status: "pending" }),
    ]);
    expect(findStreamingAssistantMessageId(rows)).toBeNull();
    expect(
      findStreamingAssistantMessageId(
        buildTimelineViewRows([
          conversationRow({ id: "user_1", role: "user", text: "Hi", seq: 1 }),
        ]),
      ),
    ).toBeNull();
    expect(findStreamingAssistantMessageId([])).toBeNull();
  });

  it("descends into the pending turn and pending delegation that own the frontier", () => {
    const pendingTurn = buildTimelineViewRows([
      turnRow({
        id: "turn_pending",
        status: "pending",
        children: [
          commandRow({ id: "cmd_1", command: "ls", seq: 2 }),
          conversationRow({
            id: "assistant_nested",
            role: "assistant",
            text: "Streaming inside the turn",
            seq: 3,
          }),
        ],
      }),
    ]);
    expect(findStreamingAssistantMessageId(pendingTurn)).toBe(
      "assistant_nested",
    );

    const completedTurn = buildTimelineViewRows([
      turnRow({
        id: "turn_done",
        status: "completed",
        children: [
          conversationRow({
            id: "assistant_done",
            role: "assistant",
            text: "Finished",
            seq: 3,
          }),
        ],
      }),
    ]);
    expect(findStreamingAssistantMessageId(completedTurn)).toBeNull();

    const pendingDelegation = buildTimelineViewRows([
      delegationRow({
        id: "delegation_live",
        status: "pending",
        seq: 5,
        childRows: [
          conversationRow({
            id: "assistant_child",
            role: "assistant",
            text: "Child agent text",
            seq: 6,
          }),
        ],
      }),
    ]);
    expect(findStreamingAssistantMessageId(pendingDelegation)).toBe(
      "assistant_child",
    );
  });
});
