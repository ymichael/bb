import { describe, expect, it } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineFileChangeWorkRow,
  TimelineRowBase,
  TimelineSystemRow,
  TimelineToolWorkRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import {
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  type BuildTimelineRowTitleOptions,
  type TimelineViewDelegationWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
  type TimelineWorkSummaryKind,
  type TimelineWorkSummaryRow,
} from "../src/index.js";

const DEFAULT_OPTIONS: BuildTimelineRowTitleOptions = {
  summaryStyle: "bundle",
  workStyle: "default",
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
    completedAt: 2_101,
    approvalStatus: null,
    activityIntents: [],
  };
}

function toolRow(): TimelineToolWorkRow {
  return {
    ...baseRow("tool-1"),
    kind: "work",
    workKind: "tool",
    status: "completed",
    callId: "tool-call-1",
    toolName: "Read",
    toolArgs: {
      file_path: "/repo/src/app.ts",
    },
    label: "Read /repo/src/app.ts",
    output: "",
    completedAt: 2_101,
    approvalStatus: null,
    activityIntents: [readIntent("/repo/src/app.ts")],
  };
}

function readIntent(path: string): TimelineActivityIntent {
  return {
    type: "read",
    command: `cat ${path}`,
    name: path.split("/").pop() ?? path,
    path,
  };
}

function searchIntent(query: string, path: string): TimelineActivityIntent {
  return {
    type: "search",
    command: `rg ${query} ${path}`,
    query,
    path,
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

function createdFileRow(): TimelineFileChangeWorkRow {
  return {
    ...baseRow("file-created-1"),
    kind: "work",
    workKind: "file-change",
    status: "completed",
    callId: "file-call-2",
    change: {
      path: "src/new-file.ts",
      kind: "add",
      movePath: null,
      diff: "first\nsecond\n",
      diffStats: {
        added: 2,
        removed: 0,
      },
    },
    stdout: null,
    stderr: null,
    approvalStatus: null,
  };
}

function editedFileRow(): TimelineFileChangeWorkRow {
  return {
    ...baseRow("file-edited-1"),
    kind: "work",
    workKind: "file-change",
    status: "completed",
    callId: "file-call-3",
    change: {
      path: "src/existing-file.ts",
      kind: "update",
      movePath: null,
      diff: "-before\n+after",
      diffStats: {
        added: 1,
        removed: 1,
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
    completedAt: null,
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
    completedAt: null,
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
    completedAt: 45_001,
    childRows: [],
  };
}

function systemOperationRow(): TimelineSystemRow {
  return {
    ...baseRow("system-1"),
    kind: "system",
    systemKind: "operation",
    title: "Thread release failed",
    detail: null,
    status: "error",
  };
}

function workSummaryRow(
  children: TimelineViewWorkRow[],
  kind: TimelineWorkSummaryKind = "step-summary",
): TimelineWorkSummaryRow {
  return {
    ...baseRow("summary-1"),
    kind,
    status: "completed",
    children,
  };
}

function turnRow(): TimelineViewTurnRow {
  return {
    ...baseRow("turn-1"),
    kind: "turn",
    turnId: "turn-1",
    status: "completed",
    summaryCount: 1,
    completedAt: 3_661_001,
    children: null,
  };
}

describe("buildTimelineRowTitle", () => {
  it("keeps command content separate from fixed prefix and duration suffix", () => {
    const title = buildTimelineRowTitle(commandRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe(
      "Ran pnpm exec turbo run test --filter=@bb/app (2s)",
    );
    expect(title.segments.map((s) => s.text)).toEqual([
      "Ran",
      "pnpm exec turbo run test --filter=@bb/app",
    ]);
    expect(title.segments[1]?.em).toBe(true);
    expect(title.decorations).toEqual([
      { kind: "duration", startedAt: 1, completedAt: 2_101, em: false },
    ]);
  });

  it("emits a live-tick duration decoration on pending command rows", () => {
    // Pending rows carry `completedAt: null`. The renderer emits a decoration
    // sourced from `startedAt`; the App ticks `now - startedAt` locally and
    // CLI prints nothing (no captured end yet).
    const title = buildTimelineRowTitle(
      {
        ...commandRow(),
        status: "pending",
        exitCode: null,
        completedAt: null,
      },
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe(
      "Running pnpm exec turbo run test --filter=@bb/app",
    );
    expect(title.segments[0]?.text).toBe("Running");
    expect(title.segments[0]?.shimmer).toBe(true);
    expect(title.decorations).toEqual([
      { kind: "duration", startedAt: 1, completedAt: null, em: false },
    ]);
  });

  it("keeps elapsed duration visible on interrupted command rows", () => {
    const title = buildTimelineRowTitle(
      {
        ...commandRow(),
        status: "interrupted",
        exitCode: null,
        completedAt: 3_001,
      },
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe(
      "Ran pnpm exec turbo run test --filter=@bb/app (3s, interrupted)",
    );
    expect(title.decorations).toEqual([
      { kind: "status", status: "interrupted", durationMs: 3_000 },
    ]);
  });

  it("keeps elapsed duration visible on interrupted tool rows", () => {
    const title = buildTimelineRowTitle(
      {
        ...toolRow(),
        activityIntents: [],
        label: "LookupTool select:TodoWrite",
        status: "interrupted",
        toolArgs: { query: "select:TodoWrite" },
        toolName: "LookupTool",
        completedAt: 3_001,
      },
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe(
      "Ran tool: LookupTool select:TodoWrite (3s, interrupted)",
    );
    expect(title.decorations).toEqual([
      { kind: "status", status: "interrupted", durationMs: 3_000 },
    ]);
  });

  it("can render completed work leaves with muted summary title treatment", () => {
    const title = buildTimelineRowTitle(commandRow(), {
      summaryStyle: "background",
      workStyle: "summary",
    });

    expect(title.plain).toBe(
      "Ran pnpm exec turbo run test --filter=@bb/app (2s)",
    );
    // Summary work-style mutes via tone; per-segment em is preserved so
    // content emphasis stays visible inside the muted wrapper.
    expect(title.tone).toBe("summary");
    expect(title.segments.find((s) => s.em)?.text).toBe(
      "pnpm exec turbo run test --filter=@bb/app",
    );
  });

  it.each([
    {
      expectedPlain:
        "Permission denied: pnpm exec turbo run test --filter=@bb/app (2s)",
      row: {
        ...commandRow(),
        approvalStatus: "denied",
      } satisfies TimelineCommandWorkRow,
    },
    {
      expectedPlain: "Permission denied: src/existing-file.ts +1 -1",
      row: {
        ...editedFileRow(),
        approvalStatus: "denied",
      } satisfies TimelineFileChangeWorkRow,
    },
    {
      expectedPlain: "Permission denied: Read /repo/src/app.ts",
      row: {
        ...toolRow(),
        approvalStatus: "denied",
      } satisfies TimelineToolWorkRow,
    },
  ])(
    "keeps denied $row.workKind titles muted (non-destructive) when summary work style is requested",
    ({ expectedPlain, row }) => {
      const title = buildTimelineRowTitle(row, {
        summaryStyle: "background",
        workStyle: "summary",
      });

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments[0]?.text).toBe("Permission denied:");
      expect(title.tone).not.toBe("destructive");
    },
  );

  it("keeps error commands as command rows with status metadata", () => {
    const row = {
      ...commandRow(),
      status: "error",
      exitCode: 1,
      completedAt: 2001,
    } satisfies TimelineCommandWorkRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe(
      "Ran pnpm exec turbo run test --filter=@bb/app (2s, error)",
    );
    expect(title.tone).toBe("default");
  });

  it("renders failed exploration intents using the intent verb", () => {
    const row = {
      ...toolRow(),
      status: "error",
    } satisfies TimelineToolWorkRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Read /repo/src/app.ts (error)");
    expect(title.tone).toBe("default");
    expect(title.decorations).toEqual([
      { kind: "status", status: "error", durationMs: null },
    ]);
  });

  it("omits zero-sided diff stats from file change suffixes", () => {
    const title = buildTimelineRowTitle(deletedFileRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe("Deleted docs/react-perf-audit.md -2");
    expect(title.segments.find((s) => s.em)?.text).toBe("react-perf-audit.md");
    expect(title.decorations).toEqual([
      { kind: "diff-stats", added: 0, removed: 2 },
    ]);
  });

  it("keeps created file diff stats in the title suffix", () => {
    const title = buildTimelineRowTitle(createdFileRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe("Created src/new-file.ts +2");
    expect(title.segments[0]?.text).toBe("Created");
    expect(title.segments.find((s) => s.em)?.text).toBe("new-file.ts");
    expect(title.decorations).toEqual([
      { kind: "diff-stats", added: 2, removed: 0 },
    ]);
  });

  it("declares an open-file-diff action on file-change titles using the canonical path", () => {
    const editTitle = buildTimelineRowTitle(editedFileRow(), DEFAULT_OPTIONS);
    expect(editTitle.action).toEqual({
      kind: "open-file-diff",
      path: "src/existing-file.ts",
    });

    const createTitle = buildTimelineRowTitle(
      createdFileRow(),
      DEFAULT_OPTIONS,
    );
    expect(createTitle.action).toEqual({
      kind: "open-file-diff",
      path: "src/new-file.ts",
    });
  });

  it("uses the rename destination as the open-file-diff path", () => {
    const renamedRow: TimelineFileChangeWorkRow = {
      ...editedFileRow(),
      change: {
        path: "src/old-name.ts",
        kind: "update",
        movePath: "src/new-name.ts",
        diff: "-before\n+after",
        diffStats: {
          added: 1,
          removed: 1,
        },
      },
    };

    const title = buildTimelineRowTitle(renamedRow, DEFAULT_OPTIONS);

    expect(title.action).toEqual({
      kind: "open-file-diff",
      path: "src/new-name.ts",
    });
  });

  it("does not declare an action on non-file-change titles", () => {
    const commandRow = {
      ...baseRow("cmd-1"),
      kind: "work" as const,
      workKind: "command" as const,
      status: "completed" as const,
      callId: "cmd-call-1",
      command: "ls",
      cwd: null,
      source: null,
      output: "",
      exitCode: 0,
      completedAt: 1,
      approvalStatus: null,
      activityIntents: [],
    } satisfies TimelineCommandWorkRow;

    const title = buildTimelineRowTitle(commandRow, DEFAULT_OPTIONS);

    expect(title.action).toBeNull();
  });

  it("emits the delegation type as its own truncating segment", () => {
    const title = buildTimelineRowTitle(delegationRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe(
      "Ran subagent: Review correctness + plan adherence (general-purpose-review-agent-with-a-long-name) (45s)",
    );
    const typeSegment = title.segments.find(
      (s) => s.text === "(general-purpose-review-agent-with-a-long-name)",
    );
    expect(typeSegment?.truncate).toBe(true);
    expect(typeSegment?.em).toBe(false);
    expect(title.decorations).toEqual([
      { kind: "duration", startedAt: 1, completedAt: 45_001, em: false },
    ]);
  });

  it.each([
    {
      status: "error" as const,
      expectedPlain:
        "Failed subagent: Review correctness + plan adherence (general-purpose-review-agent-with-a-long-name) (45s)",
      expectedTone: "default",
    },
    {
      status: "interrupted" as const,
      expectedPlain:
        "Interrupted subagent: Review correctness + plan adherence (general-purpose-review-agent-with-a-long-name) (45s)",
      expectedTone: "default",
    },
  ])(
    "uses lifecycle wording for $status delegation titles",
    ({ status, expectedPlain, expectedTone }) => {
      const row = {
        ...delegationRow(),
        status,
      } satisfies TimelineViewDelegationWorkRow;

      const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

      expect(title.plain).toBe(expectedPlain);
      expect(title.tone).toBe(expectedTone);
    },
  );

  it("uses destructive tone for failed system operation titles", () => {
    const title = buildTimelineRowTitle(systemOperationRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe("Thread release failed");
    expect(title.tone).toBe("destructive");
  });

  it("formats turn durations over 60 minutes as hours", () => {
    const title = buildTimelineRowTitle(turnRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe("Worked for (1h 1m 1s)");
  });

  it("hides subsecond turn durations", () => {
    const row = {
      ...turnRow(),
      completedAt: 251,
      summaryCount: 3,
    } satisfies TimelineViewTurnRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Worked");
  });

  it("hides one-second turn durations", () => {
    const row = {
      ...turnRow(),
      completedAt: 1001,
      status: "pending",
    } satisfies TimelineViewTurnRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Working");
    expect(title.segments[0]?.shimmer).toBe(true);
  });

  it("emits a live duration decoration for pending turns so the App ticks elapsed", () => {
    // Pending turns carry `completedAt: null`; the CLI prints just "Working"
    // (no captured duration to format), but the renderer still emits the
    // duration decoration so the App's `LiveDurationText` can tick `now -
    // startedAt` once the elapsed time crosses the visible threshold.
    const row = {
      ...turnRow(),
      completedAt: null,
      status: "pending",
    } satisfies TimelineViewTurnRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Working");
    expect(title.segments[0]?.shimmer).toBe(true);
    expect(title.decorations).toEqual([
      { kind: "duration", startedAt: 1, completedAt: null, em: true },
    ]);
  });

  it("does not use item-count fallback titles when turn duration is missing", () => {
    const row = {
      ...turnRow(),
      completedAt: null,
      summaryCount: 3,
    } satisfies TimelineViewTurnRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Worked");
  });

  it.each([
    {
      row: {
        ...webSearchRow(),
        status: "interrupted",
        completedAt: 3_001,
      } satisfies TimelineWebSearchWorkRow,
      expectedPlain: "Interrupted web search: timeline renderer (3s, interrupted)",
    },
    {
      row: {
        ...webFetchRow(),
        status: "interrupted",
        completedAt: 3_001,
      } satisfies TimelineWebFetchWorkRow,
      expectedPlain:
        "Interrupted fetch: https://example.com/thread-view (3s, interrupted)",
    },
  ])(
    "renders interrupted $row.workKind titles with elapsed duration",
    ({ row, expectedPlain }) => {
      const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

      expect(title.plain).toBe(expectedPlain);
      expect(title.decorations).toEqual([
        { kind: "status", status: "interrupted", durationMs: 3_000 },
      ]);
    },
  );

  it("can render step summaries as bundle titles or muted background summaries", () => {
    const row = workSummaryRow([webSearchRow(), webFetchRow()]);

    const bundleTitle = buildTimelineRowTitle(row, DEFAULT_OPTIONS);
    const backgroundTitle = buildTimelineRowTitle(row, {
      summaryStyle: "background",
      workStyle: "default",
    });

    expect(bundleTitle.plain).toBe("Ran 1 web search, fetched 1 web page");
    expect(bundleTitle.segments[0]?.text).toBe("Ran");
    expect(bundleTitle.segments[1]?.text).toBe(
      "1 web search, fetched 1 web page",
    );
    expect(backgroundTitle.plain).toBe("Ran 1 web search, fetched 1 web page");
    expect(backgroundTitle.segments).toEqual([
      {
        text: "Ran 1 web search, fetched 1 web page",
        em: false,
        shimmer: false,
        truncate: true,
      },
    ]);
    expect(backgroundTitle.tone).toBe("summary");
  });

  it("summarizes file changes by action", () => {
    const title = buildTimelineRowTitle(
      workSummaryRow([
        createdFileRow(),
        deletedFileRow(),
        editedFileRow(),
      ]),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe("Created 1 file, deleted 1 file, edited 1 file");
  });

  it("does not relabel completed summaries as active", () => {
    const title = buildTimelineRowTitle(workSummaryRow([webSearchRow()]), {
      summaryStyle: "bundle",
      workStyle: "default",
    });

    expect(title.plain).toBe("Ran 1 web search");
    expect(title.segments.every((s) => !s.shimmer)).toBe(true);
  });

  it("keeps non-success summary status visible without destructive tone", () => {
    const row = {
      ...workSummaryRow([
        {
          ...commandRow(),
          status: "error",
        },
      ]),
      status: "error",
    } satisfies TimelineWorkSummaryRow;

    const title = buildTimelineRowTitle(row, {
      summaryStyle: "background",
      workStyle: "default",
    });

    expect(title.plain).toBe("Ran 1 command (1 error)");
    expect(title.decorations).toEqual([
      { kind: "summary-status", errorCount: 1, interruptedCount: 0 },
    ]);
    expect(title.tone).toBe("summary");
  });

  it("keeps interrupted summary status visible", () => {
    const row = {
      ...workSummaryRow([
        {
          ...commandRow(),
          status: "interrupted",
        },
      ]),
      status: "interrupted",
    } satisfies TimelineWorkSummaryRow;

    const title = buildTimelineRowTitle(row, {
      summaryStyle: "background",
      workStyle: "default",
    });

    expect(title.plain).toBe("Ran 1 command (1 interrupted)");
    expect(title.tone).toBe("summary");
  });

  it("uses active wording for bundle summaries", () => {
    const row = {
      ...workSummaryRow(
        [
          {
            ...webSearchRow(),
            status: "pending",
          },
        ],
        "bundle-summary",
      ),
      status: "pending",
    } satisfies TimelineWorkSummaryRow;
    const title = buildTimelineRowTitle(row, {
      summaryStyle: "bundle",
      workStyle: "default",
      isActiveLatestBundle: true,
    });

    expect(title.plain).toBe("Running 1 web search");
    expect(title.segments.some((s) => s.shimmer)).toBe(true);
  });

  it("uses semantic active wording for mixed bundle summaries", () => {
    const row = {
      ...workSummaryRow(
        [
          {
            ...toolRow(),
            status: "pending",
          },
          {
            ...commandRow(),
            status: "pending",
          },
        ],
        "bundle-summary",
      ),
      status: "pending",
    } satisfies TimelineWorkSummaryRow;
    const title = buildTimelineRowTitle(row, {
      summaryStyle: "bundle",
      workStyle: "default",
      isActiveLatestBundle: true,
    });

    expect(title.plain).toBe("Exploring 1 file, running 1 command");
    expect(title.segments.some((s) => s.shimmer)).toBe(true);
  });

  it("uses active wording for tool-only bundle summaries", () => {
    const row = {
      ...workSummaryRow(
        [
          {
            ...toolRow(),
            activityIntents: [],
            label: "UnknownTool",
            toolName: "UnknownTool",
            status: "pending",
          },
        ],
        "bundle-summary",
      ),
      status: "pending",
    } satisfies TimelineWorkSummaryRow;
    const title = buildTimelineRowTitle(row, {
      summaryStyle: "bundle",
      workStyle: "default",
      isActiveLatestBundle: true,
    });

    expect(title.plain).toBe("Running 1 tool");
    expect(title.segments.some((s) => s.shimmer)).toBe(true);
  });

  it("builds compact exploration intent titles with read de-duping", () => {
    const row = {
      ...commandRow(),
      activityIntents: [
        readIntent("src/app.ts"),
        readIntent("src/app.ts"),
        searchIntent("TODO", "src"),
      ],
    } satisfies TimelineCommandWorkRow;

    const titles = buildTimelineActivityIntentTitles(row);

    expect(titles.map((entry) => entry.title.plain)).toEqual([
      "Read src/app.ts",
      "Searched for TODO in src",
    ]);
    expect(titles[0]?.title.segments[0]?.text).toBe("Read");
    expect(titles[0]?.title.segments[1]?.text).toBe("app.ts");
    expect(
      titles.every((entry) => entry.title.segments.every((s) => !s.em)),
    ).toBe(true);
  });

  it("uses active wording for pending compact exploration intent titles", () => {
    const row = {
      ...commandRow(),
      status: "pending",
      exitCode: null,
      activityIntents: [readIntent("src/app.ts"), searchIntent("TODO", "src")],
    } satisfies TimelineCommandWorkRow;

    const titles = buildTimelineActivityIntentTitles(row);

    expect(titles.map((entry) => entry.title.plain)).toEqual([
      "Reading src/app.ts",
      "Searching for TODO in src",
    ]);
    expect(titles[0]?.title.segments[0]?.text).toBe("Reading");
    expect(titles[0]?.title.segments[0]?.shimmer).toBe(true);
    expect(titles[0]?.title.segments[1]?.text).toBe("app.ts");
  });

  it("appends an (error) decoration to compact exploration intents on errored rows", () => {
    const row = {
      ...commandRow(),
      status: "error",
      exitCode: 1,
      activityIntents: [readIntent("src/app.ts")],
    } satisfies TimelineCommandWorkRow;

    const titles = buildTimelineActivityIntentTitles(row);

    expect(titles).toHaveLength(1);
    expect(titles[0]?.title.plain).toBe("Read src/app.ts (error)");
    expect(titles[0]?.title.decorations).toEqual([
      { kind: "status", status: "error", durationMs: null },
    ]);
  });

  it("appends an (interrupted) decoration to compact exploration intents on interrupted rows", () => {
    const row = {
      ...commandRow(),
      status: "interrupted",
      exitCode: null,
      activityIntents: [searchIntent("TODO", "src")],
    } satisfies TimelineCommandWorkRow;

    const titles = buildTimelineActivityIntentTitles(row);

    expect(titles).toHaveLength(1);
    expect(titles[0]?.title.plain).toBe(
      "Searched for TODO in src (interrupted)",
    );
    expect(titles[0]?.title.decorations).toEqual([
      { kind: "status", status: "interrupted", durationMs: null },
    ]);
  });
});
