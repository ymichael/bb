import { describe, expect, it } from "vitest";
import type {
  TimelineAssistantStepSummaryChildRow,
  TimelineToolBundleRow,
  ViewFileEditMessage,
  ViewToolCallMessage,
  ViewToolExploringMessage,
} from "@bb/domain";
import {
  buildTimelineAssistantStepSummary,
  buildTimelineAssistantStepSummaryLabel,
} from "../src/timeline-assistant-step-summary.js";

function buildCommandBundleRow({
  callId,
  createdAt,
  sourceSeq,
  status,
}: {
  callId: string;
  createdAt: number;
  sourceSeq: number;
  status: TimelineToolBundleRow["status"];
}): TimelineToolBundleRow {
  const message: ViewToolCallMessage = {
    kind: "tool-call",
    id: `${callId}-message`,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt,
    toolName: "exec_command",
    callId,
    command: "ls",
    approvalStatus: null,
    status,
  };

  return {
    kind: "tool-bundle",
    id: `${callId}:tool-bundle:${sourceSeq}:commands`,
    bundleKind: "commands",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    startedAt: createdAt,
    createdAt,
    status,
    summary: {
      kind: "commands",
      commands: 1,
    },
    rows: [
      {
        kind: "message",
        id: `${callId}-row`,
        message,
      },
    ],
  };
}

function buildExplorationBundleRow(
  status: TimelineToolBundleRow["status"],
): TimelineToolBundleRow {
  const message: ViewToolExploringMessage = {
    kind: "tool-exploring",
    id: "explore-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    status: status === "pending" ? "pending" : "completed",
    calls: [
      {
        callId: "search-1",
        command: "Grep button src",
        parsedCmd: [
          {
            type: "search",
            cmd: "Grep button src",
            query: "button",
            path: "src",
          },
        ],
        approvalStatus: null,
        status,
      },
    ],
  };

  return {
    kind: "tool-bundle",
    id: "explore-1:tool-bundle:1:exploration",
    bundleKind: "exploration",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    status,
    summary: {
      kind: "exploration",
      filesRead: 0,
      searches: 1,
      lists: 0,
    },
    rows: [
      {
        kind: "message",
        id: "explore-1-row",
        message,
      },
    ],
  };
}

function buildFileEditBundleRow({
  callId,
  createdAt,
  path,
  sourceSeq,
}: {
  callId: string;
  createdAt: number;
  path: string;
  sourceSeq: number;
}): TimelineToolBundleRow {
  const message: ViewFileEditMessage = {
    kind: "file-edit",
    id: `${callId}-message`,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt,
    callId,
    changes: [
      {
        path,
        kind: "update",
      },
    ],
    approvalStatus: null,
    status: "completed",
  };

  return {
    kind: "tool-bundle",
    id: `${callId}:tool-bundle:${sourceSeq}:file-edits`,
    bundleKind: "file-edits",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    startedAt: createdAt,
    createdAt,
    status: "completed",
    summary: {
      kind: "file-edits",
      filesEdited: 1,
    },
    rows: [
      {
        kind: "message",
        id: `${callId}-row`,
        message,
      },
    ],
  };
}

function getBundlePartStatus(
  rows: readonly TimelineAssistantStepSummaryChildRow[],
  kind: TimelineToolBundleRow["bundleKind"],
): TimelineToolBundleRow["status"] {
  const part = buildTimelineAssistantStepSummary(rows).parts.find(
    (entry) => "row" in entry && entry.row.bundleKind === kind,
  );

  if (!part || !("row" in part)) {
    throw new Error(`Missing ${kind} part`);
  }

  return part.row.status;
}

describe("timeline assistant step summary", () => {
  it("keeps recap labels in past tense even when a bundle is pending", () => {
    const label = buildTimelineAssistantStepSummaryLabel([
      buildExplorationBundleRow("pending"),
    ]);

    expect(label).toBe("Explored 1 search");
  });

  it("merges same-kind bundle status independently of order", () => {
    const pendingThenCompletedStatus = getBundlePartStatus(
      [
        buildCommandBundleRow({
          callId: "command-pending",
          createdAt: 1,
          sourceSeq: 1,
          status: "pending",
        }),
        buildCommandBundleRow({
          callId: "command-completed",
          createdAt: 2,
          sourceSeq: 2,
          status: "completed",
        }),
      ],
      "commands",
    );
    const completedThenPendingStatus = getBundlePartStatus(
      [
        buildCommandBundleRow({
          callId: "command-completed",
          createdAt: 1,
          sourceSeq: 1,
          status: "completed",
        }),
        buildCommandBundleRow({
          callId: "command-pending",
          createdAt: 2,
          sourceSeq: 2,
          status: "pending",
        }),
      ],
      "commands",
    );

    expect(pendingThenCompletedStatus).toBe("pending");
    expect(completedThenPendingStatus).toBe("pending");
  });

  it("dedupes files across merged file-edit bundles", () => {
    const rows = [
      buildFileEditBundleRow({
        callId: "file-edit-1",
        createdAt: 1,
        path: "/repo/src/app.ts",
        sourceSeq: 1,
      }),
      buildFileEditBundleRow({
        callId: "file-edit-2",
        createdAt: 2,
        path: "/repo/src/app.ts",
        sourceSeq: 2,
      }),
    ] satisfies TimelineAssistantStepSummaryChildRow[];
    const summary = buildTimelineAssistantStepSummary(rows);
    const part = summary.parts.find(
      (entry) =>
        "row" in entry && entry.row.bundleKind === "file-edits",
    );

    expect(part).toBeDefined();
    if (!part || !("row" in part)) {
      throw new Error("Missing file-edits part");
    }

    expect(part.row.summary).toEqual({
      kind: "file-edits",
      filesEdited: 1,
    });
    expect(buildTimelineAssistantStepSummaryLabel(rows)).toBe(
      "Edited 1 file",
    );
  });
});
