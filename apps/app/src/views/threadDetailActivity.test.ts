import { describe, expect, it } from "vitest";
import type { UIMessage } from "@beanbag/agent-core";
import type { ThreadDetailRow } from "./threadDetailRows";
import {
  findLatestActivityMessageId,
  findLatestActivityRowId,
  shouldHighlightLatestActivity,
} from "./threadDetailActivity";

function baseMessage(
  id: string,
  sourceSeq: number,
): Pick<UIMessage, "id" | "threadId" | "sourceSeqStart" | "sourceSeqEnd" | "createdAt"> {
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
    const rows: ThreadDetailRow[] = [
      {
        kind: "tool-group",
        id: "group-1",
        turnId: "turn-1",
        summaryCount: 2,
        messages: [],
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
    expect(shouldHighlightLatestActivity(rows, latestActivityRowId)).toBe(false);
  });

  it("highlights latest activity when it is the trailing row", () => {
    const rows: ThreadDetailRow[] = [
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
        kind: "tool-group",
        id: "group-1",
        turnId: "turn-1",
        summaryCount: 1,
        messages: [],
      },
    ];

    const latestActivityRowId = findLatestActivityRowId(rows);
    expect(latestActivityRowId).toBe("group-1");
    expect(shouldHighlightLatestActivity(rows, latestActivityRowId)).toBe(true);
  });

  it("returns only the latest activity message id within a group", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("exploring-1", 1),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [],
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
        callId: "call-1",
        command: "ls",
        status: "completed",
      },
    ];

    expect(findLatestActivityMessageId(messages)).toBe("tool-1");
  });

  it("treats error rows as activity and highlights when trailing", () => {
    const rows: ThreadDetailRow[] = [
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
    const messages: UIMessage[] = [
      {
        ...baseMessage("tool-1", 1),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "ls",
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
});
