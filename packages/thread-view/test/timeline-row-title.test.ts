import { describe, expect, it } from "vitest";
import type {
  TimelineCommandWorkRow,
  TimelineFileChangeWorkRow,
  TimelineRowBase,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import {
  buildTimelineRowTitle,
  type BuildTimelineRowTitleOptions,
  type TimelineActivitySummaryRow,
  type TimelineViewDelegationWorkRow,
  type TimelineViewWorkRow,
} from "../src/index.js";

const DEFAULT_OPTIONS: BuildTimelineRowTitleOptions = {
  preferOngoingLabel: false,
  summaryStyle: "bundle",
};

function baseRow(id: string): TimelineRowBase {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
  };
}

function commandRow(): TimelineCommandWorkRow {
  return {
    ...baseRow("command-1"),
    kind: "work",
    workKind: "command",
    status: "completed",
    callId: "call-1",
    command: "pnpm exec turbo run test --filter=@bb/app",
    cwd: null,
    source: null,
    output: "",
    exitCode: 0,
    durationMs: 2_100,
    approvalStatus: null,
    activityIntents: [],
  };
}

function deletedFileRow(): TimelineFileChangeWorkRow {
  return {
    ...baseRow("file-1"),
    kind: "work",
    workKind: "file-change",
    status: "completed",
    callId: "file-call-1",
    change: {
      path: "docs/react-perf-audit.md",
      kind: "delete",
      movePath: null,
      diff: "-line 1\n-line 2",
      diffStats: {
        added: 0,
        removed: 2,
      },
    },
    stdout: null,
    stderr: null,
    approvalStatus: null,
  };
}

function webSearchRow(): TimelineWebSearchWorkRow {
  return {
    ...baseRow("web-search-1"),
    kind: "work",
    workKind: "web-search",
    status: "completed",
    callId: "web-search-call-1",
    queries: ["timeline renderer"],
    resultText: null,
  };
}

function webFetchRow(): TimelineWebFetchWorkRow {
  return {
    ...baseRow("web-fetch-1"),
    kind: "work",
    workKind: "web-fetch",
    status: "completed",
    callId: "web-fetch-call-1",
    url: "https://example.com/thread-view",
    prompt: null,
    pattern: null,
    resultText: null,
  };
}

function delegationRow(): TimelineViewDelegationWorkRow {
  return {
    ...baseRow("delegation-1"),
    kind: "work",
    workKind: "delegation",
    status: "completed",
    callId: "delegation-call-1",
    toolName: "spawnAgent",
    subagentType: "general-purpose-review-agent-with-a-long-name",
    description: "Review correctness + plan adherence",
    output: "",
    durationMs: 45_000,
    childRows: [],
  };
}

function activitySummaryRow(
  children: TimelineViewWorkRow[],
): TimelineActivitySummaryRow {
  return {
    ...baseRow("summary-1"),
    kind: "activity-summary",
    status: "completed",
    children,
  };
}

describe("buildTimelineRowTitle", () => {
  it("keeps command content separate from fixed prefix and duration suffix", () => {
    const title = buildTimelineRowTitle(commandRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe(
      "Ran pnpm exec turbo run test --filter=@bb/app 2s",
    );
    expect(title.prefix).toBe("Ran");
    expect(title.content).toBe("pnpm exec turbo run test --filter=@bb/app");
    expect(title.suffix).toEqual({
      kind: "text",
      text: "2s",
      truncate: false,
    });
  });

  it("keeps error commands as command rows with status metadata", () => {
    const row = {
      ...commandRow(),
      status: "error",
      exitCode: 1,
      durationMs: 2_000,
    } satisfies TimelineCommandWorkRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe(
      "Ran pnpm exec turbo run test --filter=@bb/app (error, 2s)",
    );
    expect(title.tone).toBe("destructive");
  });

  it("omits zero-sided diff stats from file change suffixes", () => {
    const title = buildTimelineRowTitle(deletedFileRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe("Deleted react-perf-audit.md -2");
    expect(title.suffix).toEqual({
      kind: "diff-stats",
      added: 0,
      removed: 2,
    });
  });

  it("marks long delegation metadata as a truncating suffix", () => {
    const title = buildTimelineRowTitle(delegationRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe(
      "Ran subagent: Review correctness + plan adherence (general-purpose-review-agent-with-a-long-name) 45s",
    );
    expect(title.suffix).toEqual({
      kind: "text",
      text: "(general-purpose-review-agent-with-a-long-name) 45s",
      truncate: true,
    });
  });

  it("can render activity summaries as bundle titles or muted background summaries", () => {
    const row = activitySummaryRow([webSearchRow(), webFetchRow()]);

    const bundleTitle = buildTimelineRowTitle(row, DEFAULT_OPTIONS);
    const backgroundTitle = buildTimelineRowTitle(row, {
      preferOngoingLabel: false,
      summaryStyle: "background",
    });

    expect(bundleTitle.plain).toBe("Ran 1 web search, fetched 1 web page");
    expect(bundleTitle.prefix).toBe("Ran");
    expect(bundleTitle.content).toBe("1 web search, fetched 1 web page");
    expect(bundleTitle.contentTone).toBe("emphasis");
    expect(backgroundTitle.plain).toBe("Ran 1 web search, fetched 1 web page");
    expect(backgroundTitle.prefix).toBeNull();
    expect(backgroundTitle.contentTone).toBe("muted");
    expect(backgroundTitle.tone).toBe("summary");
  });

  it("uses active wording for tail summaries only when requested", () => {
    const row = activitySummaryRow([webSearchRow()]);
    const title = buildTimelineRowTitle(row, {
      preferOngoingLabel: true,
      summaryStyle: "bundle",
    });

    expect(title.plain).toBe("Running 1 web search");
    expect(title.shimmerPrefix).toBe(true);
  });
});
