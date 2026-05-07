import { describe, expect, it } from "vitest";
import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";
import {
  formatTimelineRowKindsForDiagnostics,
  timelineHasAssistantConversation,
} from "../../helpers/timeline-response.js";

const ASSISTANT_ROW = {
  kind: "conversation",
  id: "row_assistant",
  threadId: "thr_test",
  turnId: "turn_test",
  sourceSeqStart: 1,
  sourceSeqEnd: 1,
  startedAt: 1,
  createdAt: 1,
  role: "assistant",
  text: "Done",
  attachments: null,
  userRequest: null,
} satisfies TimelineRow;

const USER_ROW = {
  kind: "conversation",
  id: "row_user",
  threadId: "thr_test",
  turnId: "turn_test",
  sourceSeqStart: 2,
  sourceSeqEnd: 2,
  startedAt: 2,
  createdAt: 2,
  role: "user",
  text: "Hello",
  attachments: null,
  userRequest: { kind: "message", status: "accepted" },
} satisfies TimelineRow;

function makeTimelineResponse(
  rows: ThreadTimelineResponse["rows"],
): ThreadTimelineResponse {
  return {
    rows,
    activeThinking: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: rows.length > 0 ? 1 : 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

describe("timeline response helpers", () => {
  it("finds assistant conversation rows nested inside turn rows", () => {
    const timeline = makeTimelineResponse([
      {
        kind: "turn",
        id: "row_turn",
        threadId: "thr_test",
        turnId: "turn_test",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        startedAt: 1,
        createdAt: 1,
        status: "completed",
        summaryCount: 1,
        completedAt: null,
        children: [ASSISTANT_ROW],
      },
    ]);

    expect(timelineHasAssistantConversation(timeline)).toBe(true);
    expect(formatTimelineRowKindsForDiagnostics(timeline)).toBe(
      "turn, conversation:assistant",
    );
  });

  it("finds assistant conversation rows nested inside delegations", () => {
    const timeline = makeTimelineResponse([
      {
        kind: "work",
        id: "row_delegation",
        threadId: "thr_test",
        turnId: "turn_test",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        startedAt: 1,
        createdAt: 1,
        status: "completed",
        workKind: "delegation",
        callId: "call_test",
        toolName: "spawnAgent",
        subagentType: null,
        description: null,
        output: "",
        completedAt: null,
        childRows: [ASSISTANT_ROW],
      },
    ]);

    expect(timelineHasAssistantConversation(timeline)).toBe(true);
    expect(formatTimelineRowKindsForDiagnostics(timeline)).toBe(
      "work:delegation, conversation:assistant",
    );
  });

  it("does not treat user conversation rows as assistant output", () => {
    const timeline = makeTimelineResponse([USER_ROW]);

    expect(timelineHasAssistantConversation(timeline)).toBe(false);
    expect(formatTimelineRowKindsForDiagnostics(timeline)).toBe(
      "conversation:user",
    );
  });
});
