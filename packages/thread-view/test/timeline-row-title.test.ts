import { describe, expect, it } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineApprovalWorkRow,
  TimelineCommandWorkRow,
  TimelineFileChangeWorkRow,
  TimelineManagerAssignment,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSystemRow,
  TimelineToolWorkRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import {
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  formatTimelineDecorationText,
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

type PermissionGrantApprovalLifecycle = Extract<
  TimelineApprovalWorkRow,
  { approvalKind: "permission-grant" }
>["lifecycle"];
type TimelinePermissionGrantApprovalWorkRow = Extract<
  TimelineApprovalWorkRow,
  { approvalKind: "permission-grant" }
>;
type FileEditApprovalLifecycle = Extract<
  TimelineApprovalWorkRow,
  { approvalKind: "file-edit" }
>["lifecycle"];
interface PermissionGrantApprovalRowArgs {
  grantScope?: TimelinePermissionGrantApprovalWorkRow["grantScope"];
  lifecycle: PermissionGrantApprovalLifecycle;
  statusReason?: string | null;
  toolName?: string | null;
}

interface ManagerAssignmentSystemRowArgs {
  managerAssignment: TimelineManagerAssignment;
  status?: TimelineRowStatus;
}

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

function permissionGrantApprovalRow({
  grantScope = null,
  lifecycle,
  statusReason = null,
  toolName = "Bash",
}: PermissionGrantApprovalRowArgs): TimelineApprovalWorkRow {
  const status = (() => {
    switch (lifecycle) {
      case "pending":
      case "resolving":
        return "pending";
      case "granted":
      case "denied":
        return "completed";
      case "interrupted":
        return "interrupted";
      case "expired":
        return "error";
    }
  })();
  return {
    ...baseRow(`permission-grant-${lifecycle}`),
    kind: "work",
    workKind: "approval",
    status,
    interactionId: "pi-permission-grant",
    approvalKind: "permission-grant",
    lifecycle,
    grantScope,
    statusReason,
    target: {
      itemId: "item-permission-grant",
      toolName,
    },
  };
}

function fileEditApprovalRow(
  lifecycle: FileEditApprovalLifecycle,
): TimelineApprovalWorkRow {
  return {
    ...baseRow(`file-edit-approval-${lifecycle}`),
    kind: "work",
    workKind: "approval",
    status: lifecycle === "waiting" ? "pending" : "interrupted",
    interactionId: "file-edit-call",
    approvalKind: "file-edit",
    lifecycle,
    target: {
      itemId: "file-edit-call",
      toolName: null,
    },
  };
}

function systemOperationRow(): TimelineSystemRow {
  return {
    ...baseRow("system-1"),
    kind: "system",
    systemKind: "operation",
    operationKind: "generic",
    title: "Thread release failed",
    detail: null,
    status: "error",
    completedAt: 1,
  };
}

function managerAssignmentSystemRow({
  managerAssignment,
  status = "completed",
}: ManagerAssignmentSystemRowArgs): TimelineSystemRow {
  return {
    ...baseRow(`system-manager-${managerAssignment.action}`),
    kind: "system",
    systemKind: "operation",
    operationKind: "manager-assignment",
    managerAssignment,
    title: "Thread assigned to manager",
    detail: null,
    status,
    completedAt: 1,
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
        status: "interrupted",
        toolArgs: { query: "select:TodoWrite" },
        toolName: "LookupTool",
        completedAt: 3_001,
      },
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe(
      "Ran tool: LookupTool { query: select:TodoWrite } (3s, interrupted)",
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

  it.each([
    {
      decorationTexts: [],
      expectedPlain: "Waiting for permission to use Bash",
      lifecycle: "pending",
      shimmer: true,
      expectedSegments: ["Waiting for permission", "to use", "Bash"],
    },
    {
      decorationTexts: [],
      expectedPlain: "Delivering permission to use Bash",
      lifecycle: "resolving",
      shimmer: true,
      expectedSegments: ["Delivering permission", "to use", "Bash"],
    },
    {
      decorationTexts: [],
      expectedPlain: "Permission granted for this turn: Bash",
      grantScope: "turn",
      lifecycle: "granted",
      shimmer: false,
      expectedSegments: ["Permission granted for this turn:", "Bash"],
    },
    {
      decorationTexts: [],
      expectedPlain: "Permission granted for this session: Bash",
      grantScope: "session",
      lifecycle: "granted",
      shimmer: false,
      expectedSegments: ["Permission granted for this session:", "Bash"],
    },
    {
      decorationTexts: [],
      expectedPlain: "Permission denied: Bash",
      lifecycle: "denied",
      shimmer: false,
      expectedSegments: ["Permission denied:", "Bash"],
    },
    {
      decorationTexts: [],
      expectedPlain: "Permission grant interrupted: Bash",
      lifecycle: "interrupted",
      shimmer: false,
      expectedSegments: ["Permission grant interrupted:", "Bash"],
    },
    {
      decorationTexts: [],
      expectedPlain: "Permission grant expired: Bash",
      lifecycle: "expired",
      shimmer: false,
      expectedSegments: ["Permission grant expired:", "Bash"],
    },
  ] satisfies Array<{
    decorationTexts: string[];
    expectedPlain: string;
    expectedSegments: string[];
    grantScope?: TimelinePermissionGrantApprovalWorkRow["grantScope"];
    lifecycle: PermissionGrantApprovalLifecycle;
    shimmer: boolean;
  }>)(
    "renders typed permission grant approval lifecycle $lifecycle",
    ({
      decorationTexts,
      expectedPlain,
      expectedSegments,
      grantScope,
      lifecycle,
      shimmer,
    }) => {
      const title = buildTimelineRowTitle(
        permissionGrantApprovalRow({ grantScope, lifecycle }),
        DEFAULT_OPTIONS,
      );

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments.map((s) => s.text)).toEqual(expectedSegments);
      expect(title.segments[0]?.shimmer).toBe(shimmer);
      expect(title.segments.some((s) => s.em)).toBe(true);
      expect(title.decorations.map(formatTimelineDecorationText)).toEqual(
        decorationTexts,
      );
    },
  );

  it.each([
    {
      expectedPlain:
        "Permission grant interrupted: Bash (Thread stopped by user request)",
      lifecycle: "interrupted",
    },
    {
      expectedPlain:
        "Permission grant expired: Bash (Pending interaction expired)",
      lifecycle: "expired",
    },
  ] satisfies Array<{
    expectedPlain: string;
    lifecycle: Extract<
      PermissionGrantApprovalLifecycle,
      "expired" | "interrupted"
    >;
  }>)(
    "renders permission grant $lifecycle status reason",
    ({ expectedPlain, lifecycle }) => {
      const statusReason =
        lifecycle === "interrupted"
          ? "Thread stopped by user request"
          : "Pending interaction expired";
      const title = buildTimelineRowTitle(
        permissionGrantApprovalRow({ lifecycle, statusReason }),
        DEFAULT_OPTIONS,
      );

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments.map((s) => s.text)).toContain(`(${statusReason})`);
    },
  );

  it("uses a permissions fallback for grant requests without a tool name", () => {
    const title = buildTimelineRowTitle(
      permissionGrantApprovalRow({ lifecycle: "pending", toolName: null }),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe("Waiting for permissions");
  });

  it.each([
    {
      expectedPlain: "Waiting for approval to edit files",
      lifecycle: "waiting",
      shimmer: true,
      verb: "Waiting for approval to edit",
    },
    {
      expectedPlain: "Permission denied: file changes",
      lifecycle: "denied",
      shimmer: false,
      verb: "Permission denied:",
    },
  ] satisfies Array<{
    expectedPlain: string;
    lifecycle: FileEditApprovalLifecycle;
    shimmer: boolean;
    verb: string;
  }>)(
    "renders typed file edit approval lifecycle $lifecycle",
    ({ expectedPlain, lifecycle, shimmer, verb }) => {
      const title = buildTimelineRowTitle(
        fileEditApprovalRow(lifecycle),
        DEFAULT_OPTIONS,
      );

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments.map((s) => s.text)).toEqual([
        verb,
        lifecycle === "waiting" ? "files" : "file changes",
      ]);
      expect(title.segments[0]?.shimmer).toBe(shimmer);
      expect(title.segments[1]?.em).toBe(true);
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

  it.each([
    {
      action: "assign",
      managerAssignment: {
        action: "assign" as const,
        previousManagerThreadId: null,
        previousManagerThreadTitle: null,
        nextManagerThreadId: "thr_next",
        nextManagerThreadTitle: "Frontend Manager",
      },
      expectedPlain: "Thread assigned to Frontend Manager",
      expectedSegments: ["Thread assigned to", "Frontend Manager"],
      expectedLinkIndex: 1,
      expectedLinkThreadId: "thr_next",
    },
    {
      action: "release",
      managerAssignment: {
        action: "release" as const,
        previousManagerThreadId: "thr_prev",
        previousManagerThreadTitle: "Frontend Manager",
        nextManagerThreadId: null,
        nextManagerThreadTitle: null,
      },
      expectedPlain: "Thread unassigned from Frontend Manager",
      expectedSegments: ["Thread unassigned from", "Frontend Manager"],
      expectedLinkIndex: 1,
      expectedLinkThreadId: "thr_prev",
    },
    {
      action: "transfer",
      managerAssignment: {
        action: "transfer" as const,
        previousManagerThreadId: "thr_prev",
        previousManagerThreadTitle: "Frontend Manager",
        nextManagerThreadId: "thr_next",
        nextManagerThreadTitle: "Backend Manager",
      },
      expectedPlain: "Thread reassigned from Frontend Manager to Backend Manager",
      expectedSegments: [
        "Thread reassigned from",
        "Frontend Manager",
        "to",
        "Backend Manager",
      ],
      expectedLinkIndex: 1,
      expectedLinkThreadId: "thr_prev",
    },
  ] satisfies Array<{
    action: TimelineManagerAssignment["action"];
    managerAssignment: TimelineManagerAssignment;
    expectedPlain: string;
    expectedSegments: string[];
    expectedLinkIndex: number;
    expectedLinkThreadId: string;
  }>)(
    "renders typed manager assignment system action $action",
    ({
      managerAssignment,
      expectedPlain,
      expectedSegments,
      expectedLinkIndex,
      expectedLinkThreadId,
    }) => {
      const title = buildTimelineRowTitle(
        managerAssignmentSystemRow({ managerAssignment }),
        DEFAULT_OPTIONS,
      );

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments.map((s) => s.text)).toEqual(expectedSegments);
      const linkSegment = title.segments[expectedLinkIndex];
      expect(linkSegment?.em).toBe(true);
      expect(linkSegment?.link).toEqual({
        kind: "thread",
        threadId: expectedLinkThreadId,
      });
    },
  );

  it("falls back to the manager thread id when title is null", () => {
    const title = buildTimelineRowTitle(
      managerAssignmentSystemRow({
        managerAssignment: {
          action: "assign",
          previousManagerThreadId: null,
          previousManagerThreadTitle: null,
          nextManagerThreadId: "thr_xyz",
          nextManagerThreadTitle: null,
        },
      }),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe("Thread assigned to thr_xyz");
    expect(title.segments[1]?.text).toBe("thr_xyz");
    expect(title.segments[1]?.link).toEqual({
      kind: "thread",
      threadId: "thr_xyz",
    });
  });

  it.each([
    {
      expectedPlain: "Assigning thread to Frontend Manager",
      expectedShimmer: true,
      expectedDecorationText: "",
      status: "pending",
    },
    {
      expectedPlain: "Thread assigned to Frontend Manager (error)",
      expectedShimmer: false,
      expectedDecorationText: "(error)",
      expectedTone: "destructive",
      status: "error",
    },
    {
      expectedPlain: "Thread assigned to Frontend Manager (interrupted)",
      expectedShimmer: false,
      expectedDecorationText: "(interrupted)",
      status: "interrupted",
    },
  ] satisfies Array<{
    expectedPlain: string;
    expectedShimmer: boolean;
    expectedDecorationText: string;
    expectedTone?: "destructive";
    status: Exclude<TimelineSystemRow["status"], "completed" | null>;
  }>)(
    "renders manager assignment $status status with typed wording",
    ({
      expectedPlain,
      expectedShimmer,
      expectedDecorationText,
      expectedTone,
      status,
    }) => {
      const title = buildTimelineRowTitle(
        managerAssignmentSystemRow({
          managerAssignment: {
            action: "assign",
            previousManagerThreadId: null,
            previousManagerThreadTitle: null,
            nextManagerThreadId: "thr_next",
            nextManagerThreadTitle: "Frontend Manager",
          },
          status,
        }),
        DEFAULT_OPTIONS,
      );

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments[0]?.shimmer).toBe(expectedShimmer);
      expect(title.tone).toBe(expectedTone ?? "default");
      if (expectedDecorationText.length > 0) {
        expect(title.decorations.map(formatTimelineDecorationText)).toContain(
          expectedDecorationText,
        );
      } else {
        expect(title.decorations).toEqual([]);
      }
    },
  );

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

  it("renders elapsed duration on completed compaction rows", () => {
    const row: TimelineSystemRow = {
      ...baseRow("compaction-completed"),
      startedAt: 1,
      createdAt: 7_001,
      kind: "system",
      systemKind: "operation",
      operationKind: "compaction",
      title: "Context compacted",
      detail: null,
      status: "completed",
      completedAt: 7_001,
    };

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Context compacted (7s)");
    expect(title.decorations).toEqual([
      { kind: "duration", startedAt: 1, completedAt: 7_001, em: false },
    ]);
  });

  it("emits a live-tick duration decoration and ellipsis on pending compaction rows", () => {
    const row: TimelineSystemRow = {
      ...baseRow("compaction-pending"),
      startedAt: 1,
      createdAt: 1,
      kind: "system",
      systemKind: "operation",
      operationKind: "compaction",
      title: "Compacting context",
      detail: null,
      status: "pending",
      completedAt: null,
    };

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.segments[0]?.text).toBe("Compacting context…");
    expect(title.segments[0]?.shimmer).toBe(true);
    expect(title.decorations).toEqual([
      { kind: "duration", startedAt: 1, completedAt: null, em: false },
    ]);
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

    expect(bundleTitle.plain).toBe(
      "Researched 1 search query, 1 web page",
    );
    expect(bundleTitle.segments[0]?.text).toBe("Researched");
    expect(bundleTitle.segments[1]?.text).toBe("1 search query, 1 web page");
    expect(backgroundTitle.plain).toBe(
      "Researched 1 search query, 1 web page",
    );
    expect(backgroundTitle.segments).toEqual([
      {
        text: "Researched 1 search query, 1 web page",
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

    expect(title.plain).toBe("Edited 3 files");
  });

  it("does not relabel completed summaries as active", () => {
    const title = buildTimelineRowTitle(workSummaryRow([webSearchRow()]), {
      summaryStyle: "bundle",
      workStyle: "default",
    });

    expect(title.plain).toBe("Researched 1 search query");
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

    expect(title.plain).toBe("Researching 1 search query");
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
            toolName: "UnknownTool",
            toolArgs: null,
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
