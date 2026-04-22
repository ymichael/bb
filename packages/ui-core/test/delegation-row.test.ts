import { describe, expect, it } from "vitest";
import type { TimelineRow, ViewMessage } from "@bb/domain";
import { findLatestActivityRowId } from "@bb/core-ui";
import { shouldPreferNestedOngoingLabels } from "../src/thread-timeline/rows/DelegationRow.js";

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

describe("DelegationRow nested ongoing labels", () => {
  it("prefers ongoing labels only for the latest nested message row", () => {
    const toolRow: TimelineRow = {
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
    };
    const fileRow: TimelineRow = {
      kind: "message",
      id: "file-1",
      message: {
        ...baseMessage("file-1", 2),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-1",
        changes: [{ path: "/repo/a.ts" }],
        status: "completed",
      },
    };
    const rows = [toolRow, fileRow];
    const latestActivityRowId = findLatestActivityRowId(rows);

    expect(
      shouldPreferNestedOngoingLabels({
        latestActivityRowId,
        preferOngoingLabels: true,
        row: toolRow,
      }),
    ).toBe(false);
    expect(
      shouldPreferNestedOngoingLabels({
        latestActivityRowId,
        preferOngoingLabels: true,
        row: fileRow,
      }),
    ).toBe(true);
  });

  it("applies the ongoing-label hint to a nested tool group only when it is pending and the latest activity", () => {
    const earlierRow: TimelineRow = {
      kind: "message",
      id: "tool-1",
      message: {
        ...baseMessage("tool-1", 1),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "pwd",
        status: "completed",
      },
    };
    const toolGroupRow: TimelineRow = {
      kind: "tool-bundle",
      id: "group-1",
      bundleKind: "commands",
      presentation: "default",
      turnId: "turn-1",
      sourceSeqStart: 2,
      sourceSeqEnd: 3,
      startedAt: 2,
      createdAt: 3,
      status: "pending",
      summary: {
        kind: "commands",
        commands: 2,
      },
      rows: [
        {
          kind: "message",
          id: "search-1",
          message: {
            ...baseMessage("search-1", 2),
            kind: "tool-call",
            turnId: "turn-1",
            toolName: "exec_command",
            callId: "call-2",
            command: "rg TODO src",
            status: "completed",
          },
        },
        {
          kind: "message",
          id: "test-1",
          message: {
            ...baseMessage("test-1", 3),
            kind: "tool-call",
            turnId: "turn-1",
            toolName: "exec_command",
            callId: "call-3",
            command: "pnpm vitest",
            status: "pending",
          },
        },
      ],
    };
    const rows = [earlierRow, toolGroupRow];
    const latestActivityRowId = findLatestActivityRowId(rows);

    expect(
      shouldPreferNestedOngoingLabels({
        latestActivityRowId,
        preferOngoingLabels: true,
        row: earlierRow,
      }),
    ).toBe(false);
    expect(
      shouldPreferNestedOngoingLabels({
        latestActivityRowId,
        preferOngoingLabels: true,
        row: toolGroupRow,
      }),
    ).toBe(true);
  });
});
