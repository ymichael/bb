import { describe, expect, it } from "vitest";
import type {
  TimelineMessageRow,
  TimelineRow,
  TimelineToolBundleRow,
  TimelineTurnSummaryRow,
  ViewDelegationMessage,
  ViewProjection,
} from "@bb/domain";
import { threadScope } from "@bb/domain";
import {
  getThreadTimelineRowTitle,
  type ThreadTimelineRichTitle,
  type ThreadTimelineTitleContext,
} from "../src/thread-timeline-row-title.js";

type DelegationStatus = ViewDelegationMessage["status"];

const titleContext: ThreadTimelineTitleContext = {
  preferOngoingLabels: false,
};

function title(row: TimelineRow): string {
  return getThreadTimelineRowTitle(row, titleContext).plain;
}

function richTitle(row: TimelineRow): ThreadTimelineRichTitle {
  return getThreadTimelineRowTitle(row, titleContext).rich;
}

function titleWithOngoingPreference(row: TimelineRow): string {
  return getThreadTimelineRowTitle(row, {
    preferOngoingLabels: true,
  }).plain;
}

function emptyProjection(): ViewProjection {
  return {
    entries: [],
    state: {
      activeThinking: null,
    },
  };
}

function delegationRow(status: DelegationStatus): TimelineMessageRow {
  const message: ViewDelegationMessage = {
    kind: "delegation",
    id: "delegation-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    scope: threadScope(),
    toolName: "Agent",
    callId: "agent-1",
    status,
    subagentType: "Explore",
    description: "Inspect the docs tree",
    output: "",
    durationMs: null,
    childProjection: emptyProjection(),
  };
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

describe("getThreadTimelineRowTitle", () => {
  it("formats command bundle titles and active-label preference", () => {
    const row: TimelineToolBundleRow = {
      kind: "tool-bundle",
      bundleKind: "commands",
      id: "bundle-1",
      presentation: "default",
      turnId: "turn-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
      startedAt: 10,
      createdAt: 20,
      status: "completed",
      summary: {
        kind: "commands",
        commands: 2,
      },
      rows: [],
    };

    expect(title(row)).toBe("Ran 2 commands");
    expect(richTitle(row)).toEqual({
      prefix: "Ran",
      content: "2 commands",
      metadata: null,
    });
    expect(titleWithOngoingPreference(row)).toBe("Running 2 commands");
  });

  it("formats turn summary titles with duration", () => {
    const row: TimelineTurnSummaryRow = {
      kind: "turn-summary",
      id: "turn-summary-1",
      turnId: "turn-1",
      summaryCount: 22,
      sourceSeqStart: 1,
      sourceSeqEnd: 22,
      startedAt: 1,
      createdAt: 128_001,
      durationMs: 128_000,
      status: "completed",
      rows: null,
    };

    expect(title(row)).toBe("Worked for 2m 8s");
    expect(titleWithOngoingPreference(row)).toBe("Working for 2m 8s");
  });

  it("formats delegation row titles from structured metadata", () => {
    const row = delegationRow("completed");

    expect(title(row)).toBe("Ran subagent: Inspect the docs tree (Explore)");
    expect(richTitle(row)).toEqual({
      prefix: "Ran subagent:",
      content: "Inspect the docs tree",
      metadata: "Explore",
    });
  });

  it("uses the row status for standalone delegation titles", () => {
    const row = delegationRow("completed");

    expect(titleWithOngoingPreference(row)).toBe(
      "Ran subagent: Inspect the docs tree (Explore)",
    );
  });
});
