import { describe, expect, it } from "vitest";
import type { UIMessage } from "@beanbag/agent-core";
import type { ThreadDetailRow } from "./threadDetailRows";
import {
  findLatestActivityMessageId,
  findLatestActivityRowId,
  isLastThreadRowShowingOngoingState,
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
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        startedAt: 1,
        createdAt: 1,
        status: "completed",
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
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        startedAt: 2,
        createdAt: 2,
        status: "completed",
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

  it("treats trailing provisioning rows as latest activity", () => {
    const rows: ThreadDetailRow[] = [
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
          opType: "provisioning",
          title: "Provisioning environment",
          detail: "Environment: Git Worktree Workspace",
        },
      },
    ];

    const latestActivityRowId = findLatestActivityRowId(rows);
    expect(latestActivityRowId).toBe("provisioning-1");
    expect(shouldHighlightLatestActivity(rows, latestActivityRowId)).toBe(true);
  });

  it("returns the latest provisioning operation message id within a group", () => {
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
        ...baseMessage("provisioning-1", 2),
        kind: "operation",
        turnId: "turn-1",
        opType: "provisioning",
        title: "Provisioning environment",
        detail: "Environment: Git Worktree Workspace",
      },
    ];

    expect(findLatestActivityMessageId(messages)).toBe("provisioning-1");
  });

  it("treats a trailing in-progress tool row as ongoing thread activity", () => {
    const rows: ThreadDetailRow[] = [
      {
        kind: "message",
        id: "tool-1",
        message: {
          ...baseMessage("tool-1", 1),
          kind: "tool-call",
          turnId: "turn-1",
          toolName: "exec_command",
          callId: "call-1",
          command: "ls",
          status: "pending",
        },
      },
    ];

    expect(isLastThreadRowShowingOngoingState(rows, "tool-1")).toBe(true);
  });

  it("treats a trailing latest completed tool row as ongoing thread activity", () => {
    const rows: ThreadDetailRow[] = [
      {
        kind: "message",
        id: "tool-1",
        message: {
          ...baseMessage("tool-1", 1),
          kind: "tool-call",
          turnId: "turn-1",
          toolName: "exec_command",
          callId: "call-1",
          command: "ls",
          status: "completed",
        },
      },
    ];

    expect(isLastThreadRowShowingOngoingState(rows, "tool-1")).toBe(true);
  });

  it("does not treat a trailing failed tool row as ongoing thread activity", () => {
    const rows: ThreadDetailRow[] = [
      {
        kind: "message",
        id: "tool-1",
        message: {
          ...baseMessage("tool-1", 1),
          kind: "tool-call",
          turnId: "turn-1",
          toolName: "exec_command",
          callId: "call-1",
          command: "ls",
          status: "error",
        },
      },
    ];

    expect(isLastThreadRowShowingOngoingState(rows, "tool-1")).toBe(false);
  });

  it("treats a trailing streaming reasoning row as ongoing thread activity", () => {
    const rows: ThreadDetailRow[] = [
      {
        kind: "message",
        id: "reasoning-1",
        message: {
          ...baseMessage("reasoning-1", 1),
          kind: "assistant-reasoning",
          text: "**Thinking**",
          status: "streaming",
        },
      },
    ];

    expect(isLastThreadRowShowingOngoingState(rows, null)).toBe(true);
  });

  it("treats a trailing latest tool group with ongoing labels as ongoing thread activity", () => {
    const rows: ThreadDetailRow[] = [
      {
        kind: "tool-group",
        id: "group-1",
        turnId: "turn-1",
        summaryCount: 1,
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        startedAt: 1,
        createdAt: 1,
        status: "completed",
        messages: [
          {
            ...baseMessage("exploring-1", 1),
            kind: "tool-exploring",
            turnId: "turn-1",
            status: "completed",
            calls: [],
          },
        ],
      },
    ];

    expect(isLastThreadRowShowingOngoingState(rows, "group-1")).toBe(true);
  });

  it("does not treat a trailing completed assistant summary as ongoing thread activity", () => {
    const rows: ThreadDetailRow[] = [
      {
        kind: "message",
        id: "assistant-1",
        message: {
          ...baseMessage("assistant-1", 1),
          kind: "assistant-text",
          turnId: "turn-1",
          text: "Explored src/views/ThreadDetailView.tsx",
          status: "completed",
        },
      },
    ];

    expect(isLastThreadRowShowingOngoingState(rows, null)).toBe(false);
  });
});
