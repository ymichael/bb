import { describe, expect, it } from "vitest";
import type {
  TimelineAssistantStepSummaryRow,
  TimelineMessageRow,
  TimelineRow,
  TimelineToolBundleRow,
  ViewAssistantTextMessage,
  ViewToolCallMessage,
  ViewToolExploringMessage,
} from "@bb/domain";
import { shouldDeEmphasizeGroupedSummary } from "../src/thread-timeline/grouped-summary-presentation.js";

function buildAssistantMessageRow(
  id: string,
  sourceSeq: number,
): TimelineMessageRow {
  const message: ViewAssistantTextMessage = {
    kind: "assistant-text",
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
    status: "completed",
    text: "Working",
  };

  return {
    kind: "message",
    id: `row-${id}`,
    message,
  };
}

function buildExplorationBundleRow(
  id: string,
  sourceSeq: number,
): TimelineToolBundleRow {
  const message: ViewToolExploringMessage = {
    kind: "tool-exploring",
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
    status: "completed",
    calls: [
      {
        callId: `${id}-call`,
        command: "Grep button src",
        parsedCmd: [
          {
            type: "search",
            cmd: "Grep button src",
            query: "button",
            path: "src",
          },
        ],
        status: "completed",
      },
    ],
  };

  return {
    kind: "tool-bundle",
    id: `bundle-${id}`,
    bundleKind: "exploration",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    startedAt: sourceSeq,
    createdAt: sourceSeq,
    status: "completed",
    summary: {
      kind: "exploration",
      filesRead: 0,
      searches: 1,
      lists: 0,
    },
    rows: [
      {
        kind: "message",
        id: `message-${id}`,
        message,
      },
    ],
  };
}

function buildCommandBundleRow(
  id: string,
  sourceSeq: number,
): TimelineToolBundleRow {
  const message: ViewToolCallMessage = {
    kind: "tool-call",
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
    toolName: "exec_command",
    callId: `${id}-call`,
    command: "ls",
    status: "completed",
  };

  return {
    kind: "tool-bundle",
    id: `bundle-${id}`,
    bundleKind: "commands",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    startedAt: sourceSeq,
    createdAt: sourceSeq,
    status: "completed",
    summary: {
      kind: "commands",
      commands: 1,
    },
    rows: [
      {
        kind: "message",
        id: `message-${id}`,
        message,
      },
    ],
  };
}

function buildAssistantStepSummaryRow(): TimelineAssistantStepSummaryRow {
  return {
    kind: "assistant-step-summary",
    id: "assistant-step-1",
    turnId: "turn-1",
    sourceSeqStart: 2,
    sourceSeqEnd: 3,
    startedAt: 2,
    createdAt: 2,
    status: "completed",
    rows: [buildExplorationBundleRow("explore-1", 2), buildCommandBundleRow("command-1", 3)],
  };
}

describe("grouped summary presentation", () => {
  it("de-emphasizes assistant-step-summary rows", () => {
    expect(shouldDeEmphasizeGroupedSummary(buildAssistantStepSummaryRow())).toBe(
      true,
    );
  });

  it("de-emphasizes tool bundles that stand in for assistant-step summaries", () => {
    const row = {
      ...buildExplorationBundleRow("explore-1", 2),
      presentation: "assistant-step-summary-placeholder" as const,
    };

    expect(shouldDeEmphasizeGroupedSummary(row)).toBe(true);
  });

  it("keeps regular tool bundles emphasized", () => {
    expect(
      shouldDeEmphasizeGroupedSummary(buildExplorationBundleRow("explore-1", 2)),
    ).toBe(false);
  });

  it("keeps non-grouped rows emphasized by default", () => {
    expect(
      shouldDeEmphasizeGroupedSummary(buildAssistantMessageRow("assistant-1", 1)),
    ).toBe(false);
  });
});
