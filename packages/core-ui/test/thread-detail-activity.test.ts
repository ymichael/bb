import { describe, expect, it } from "vitest";
import type { TimelineRow, ViewMessage } from "@bb/domain";
import {
  findLatestActivityMessageId,
  findLatestActivityRowId,
  shouldHighlightLatestActivity,
} from "../src/thread-detail-activity.js";

function baseMessage(
  id: string,
  sourceSeq: number,
): Pick<
  ViewMessage,
  "id" | "threadId" | "sourceSeqStart" | "sourceSeqEnd" | "createdAt"
> {
  return {
    id,
    threadId: "thread-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
  };
}

describe("threadDetailActivity", () => {
  it("does not highlight latest activity when there is a trailing non-activity row", () => {
    const rows: TimelineRow[] = [
      {
        kind: "turn-summary",
        id: "group-1",
        turnId: "turn-1",
        summaryCount: 2,
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        startedAt: 1,
        createdAt: 1,
        status: "completed",
        rows: null,
      },
      {
        kind: "message",
        id: "assistant-1",
        message: {
          ...baseMessage("assistant-1", 2),
          kind: "assistant-text",
          turnId: "turn-1",
          text: "done",
          status: "completed",
        },
      },
    ];

    const latestActivityRowId = findLatestActivityRowId(rows);
    expect(latestActivityRowId).toBe("group-1");
    expect(shouldHighlightLatestActivity(rows, latestActivityRowId)).toBe(
      false,
    );
  });

  it("highlights latest activity when it is the trailing row", () => {
    const rows: TimelineRow[] = [
      {
        kind: "message",
        id: "assistant-1",
        message: {
          ...baseMessage("assistant-1", 1),
          kind: "assistant-text",
          turnId: "turn-1",
          text: "done",
          status: "completed",
        },
      },
      {
        kind: "turn-summary",
        id: "group-1",
        turnId: "turn-1",
        summaryCount: 1,
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        startedAt: 2,
        createdAt: 2,
        status: "completed",
        rows: null,
      },
    ];

    const latestActivityRowId = findLatestActivityRowId(rows);
    expect(latestActivityRowId).toBe("group-1");
    expect(shouldHighlightLatestActivity(rows, latestActivityRowId)).toBe(true);
  });

  it("returns only the latest activity message id within a group", () => {
    const messages: ViewMessage[] = [
      {
        ...baseMessage("exploring-1", 1),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "Read",
        toolArgs: { file_path: "/repo/a.ts" },
        callId: "read-1",
        parsedIntents: [
          {
            type: "read",
            cmd: "Read /repo/a.ts",
            name: "Read",
            path: "/repo/a.ts",
          },
        ],
        output: "",
        durationMs: null,
        approvalStatus: null,
        status: "completed",
      },
      {
        ...baseMessage("file-1", 2),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-1",
        changes: [{ path: "/repo/a.ts" }],
        status: "completed",
      },
      {
        ...baseMessage("tool-1", 3),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        toolArgs: { command: "ls" },
        callId: "call-1",
        parsedIntents: [],
        output: "",
        durationMs: null,
        approvalStatus: null,
        status: "completed",
      },
    ];

    expect(findLatestActivityMessageId(messages)).toBe("tool-1");
  });

  it("treats error rows as activity and highlights when trailing", () => {
    const rows: TimelineRow[] = [
      {
        kind: "message",
        id: "user-1",
        message: {
          ...baseMessage("user-1", 1),
          kind: "user",
          text: "hi",
        },
      },
      {
        kind: "message",
        id: "error-1",
        message: {
          ...baseMessage("error-1", 2),
          kind: "error",
          rawType: "system/error",
          message: "Project folder not found",
        },
      },
    ];

    const latestActivityRowId = findLatestActivityRowId(rows);
    expect(latestActivityRowId).toBe("error-1");
    expect(shouldHighlightLatestActivity(rows, latestActivityRowId)).toBe(true);
  });

  it("returns latest error message id when it is the final activity", () => {
    const messages: ViewMessage[] = [
      {
        ...baseMessage("tool-1", 1),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        toolArgs: { command: "ls" },
        callId: "call-1",
        parsedIntents: [],
        output: "",
        durationMs: null,
        approvalStatus: null,
        status: "completed",
      },
      {
        ...baseMessage("error-1", 2),
        kind: "error",
        rawType: "system/error",
        message: "Project folder not found",
      },
    ];

    expect(findLatestActivityMessageId(messages)).toBe("error-1");
  });

  it("treats trailing provisioning rows as latest activity", () => {
    const rows: TimelineRow[] = [
      {
        kind: "message",
        id: "assistant-1",
        message: {
          ...baseMessage("assistant-1", 1),
          kind: "assistant-text",
          turnId: "turn-1",
          text: "setting things up",
          status: "completed",
        },
      },
      {
        kind: "message",
        id: "provisioning-1",
        message: {
          ...baseMessage("provisioning-1", 2),
          kind: "operation",
          turnId: "turn-1",
          opType: "thread-provisioning",
          title: "Provisioning thread",
          detail: "Environment: Git Worktree Workspace",
        },
      },
    ];

    const latestActivityRowId = findLatestActivityRowId(rows);
    expect(latestActivityRowId).toBe("provisioning-1");
    expect(shouldHighlightLatestActivity(rows, latestActivityRowId)).toBe(true);
  });

  it("returns the latest provisioning operation message id within a group", () => {
    const messages: ViewMessage[] = [
      {
        ...baseMessage("tool-1", 1),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        toolArgs: { command: "ls" },
        callId: "call-1",
        parsedIntents: [],
        output: "",
        durationMs: null,
        approvalStatus: null,
        status: "completed",
      },
      {
        ...baseMessage("provisioning-1", 2),
        kind: "operation",
        turnId: "turn-1",
        opType: "thread-provisioning",
        title: "Provisioning thread",
        detail: "Environment: Git Worktree Workspace",
      },
    ];

    expect(findLatestActivityMessageId(messages)).toBe("provisioning-1");
  });
});
