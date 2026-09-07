import { describe, expect, it } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineApprovalWorkRow,
  TimelineCommandWorkRow,
  TimelineFileChangeWorkRow,
  TimelineFileReadWorkRow,
  TimelineImageViewWorkRow,
  TimelineParentChange,
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
  type BuildTimelineRowTitleOptions,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "../src/index.js";
import { formatTimelineDecorationText } from "../src/timeline-row-title.js";
import type {
  TimelineViewDelegationWorkRow,
  TimelineWorkSummaryKind,
  TimelineWorkSummaryRow,
} from "../src/timeline-view.js";

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

interface ParentChangeSystemRowArgs {
  parentChange: TimelineParentChange;
  status?: TimelineRowStatus;
  threadName?: string;
  threadId?: string;
}

const PARENT_CHANGE_VERB: Record<TimelineParentChange["action"], string> = {
  assign: "assigned to",
  release: "released from",
  transfer: "transferred to",
};

function parentChangeFlatTitle(
  parentChange: TimelineParentChange,
  threadName: string,
): string {
  const verb = PARENT_CHANGE_VERB[parentChange.action];
  const parentTitle =
    parentChange.action === "release"
      ? parentChange.previousParentThreadTitle
      : parentChange.nextParentThreadTitle;
  const parent =
    parentTitle !== null && parentTitle.trim().length > 0
      ? parentTitle.trim()
      : "parent";
  return `${threadName} ${verb} ${parent}`;
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
    toolName: "LookupTool",
    toolArgs: { query: "select:TodoWrite" },
    output: "",
    completedAt: 2_101,
    approvalStatus: null,
  };
}

function fileReadRow(path: string): TimelineFileReadWorkRow {
  return {
    ...baseRow("file-read-1"),
    kind: "work",
    workKind: "file-read",
    status: "completed",
    callId: "file-read-call-1",
    path,
    cmd: null,
    completedAt: 2_101,
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

function listFilesIntent(path: string): TimelineActivityIntent {
  return {
    type: "list_files",
    command: `ls ${path}`,
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

function imageViewRow(): TimelineImageViewWorkRow {
  return {
    ...baseRow("image-view-1"),
    kind: "work",
    workKind: "image-view",
    status: "completed",
    callId: "image-view-call-1",
    path: "/tmp/sightglass-quote-merge-check/dashboard-main.png",
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
    childRef: null,
    background: false,
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

function parentChangeSystemRow({
  parentChange,
  status = "completed",
  threadName = "Worker 3",
  threadId,
}: ParentChangeSystemRowArgs): TimelineSystemRow {
  const base = baseRow(`system-parent-${parentChange.action}`);
  return {
    ...base,
    ...(threadId !== undefined ? { threadId } : {}),
    kind: "system",
    systemKind: "operation",
    operationKind: "parent-change",
    parentChange,
    title: parentChangeFlatTitle(parentChange, threadName),
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

  it("collapses newlines in multi-line command content to single-line title segments", () => {
    const row = {
      ...commandRow(),
      command: "node <<'EOF'\nconst x = 1;\nconsole.log(x);\nEOF",
    } satisfies TimelineCommandWorkRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).not.toContain("\n");
    for (const segment of title.segments) {
      expect(segment.text).not.toContain("\n");
    }
  });

  it("emits a live-tick duration decoration on pending command rows", () => {
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
      {
        kind: "status",
        status: "interrupted",
        durationMs: 3_000,
        emphasis: false,
      },
    ]);
  });

  it("keeps elapsed duration visible on interrupted tool rows", () => {
    const title = buildTimelineRowTitle(
      {
        ...toolRow(),
        status: "interrupted",
        completedAt: 3_001,
      },
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe(
      "Ran tool LookupTool { query: select:TodoWrite } (3s, interrupted)",
    );
    expect(title.decorations).toEqual([
      {
        kind: "status",
        status: "interrupted",
        durationMs: 3_000,
        emphasis: false,
      },
    ]);
  });

  it("titles a generic tool row from its name and arguments, not from a label table", () => {
    expect(
      buildTimelineRowTitle(
        {
          ...toolRow(),
          toolName: "repository_context",
          toolArgs: null,
        },
        DEFAULT_OPTIONS,
      ).plain,
    ).toBe("Ran tool repository_context (2s)");
  });

  it("can render completed work leaves with muted summary title treatment", () => {
    const title = buildTimelineRowTitle(commandRow(), {
      summaryStyle: "background",
      workStyle: "summary",
    });

    expect(title.plain).toBe(
      "Ran pnpm exec turbo run test --filter=@bb/app (2s)",
    );
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
      expectedPlain: "Permission denied: Read /repo/src/app.ts",
      row: {
        ...commandRow(),
        command: "cat /repo/src/app.ts",
        activityIntents: [readIntent("/repo/src/app.ts")],
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
      expectedPlain:
        "Permission denied: LookupTool { query: select:TodoWrite } (2s)",
      row: {
        ...toolRow(),
        approvalStatus: "denied",
      } satisfies TimelineToolWorkRow,
    },
  ])(
    "keeps denied $row.workKind titles muted under summary tone when summary work style is requested",
    ({ expectedPlain, row }) => {
      const title = buildTimelineRowTitle(row, {
        summaryStyle: "background",
        workStyle: "summary",
      });

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments[0]?.text).toBe("Permission denied:");
      expect(title.tone).toBe("summary");
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
  ] satisfies Array<{
    expectedPlain: string;
    lifecycle: Extract<PermissionGrantApprovalLifecycle, "interrupted">;
  }>)(
    "renders permission grant $lifecycle status reason",
    ({ expectedPlain, lifecycle }) => {
      const statusReason = "Thread stopped by user request";
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
      parentChange: {
        action: "assign" as const,
        previousParentThreadId: null,
        previousParentThreadTitle: null,
        nextParentThreadId: "thr_next",
        nextParentThreadTitle: "Frontend Parent",
      },
      expectedPlain: "Worker 3 assigned to Frontend Parent",
      expectedSegments: ["Worker 3", "assigned to", "Frontend Parent"],
      expectedParentLinkThreadId: "thr_next",
    },
    {
      action: "release",
      parentChange: {
        action: "release" as const,
        previousParentThreadId: "thr_prev",
        previousParentThreadTitle: "Frontend Parent",
        nextParentThreadId: null,
        nextParentThreadTitle: null,
      },
      expectedPlain: "Worker 3 released from Frontend Parent",
      expectedSegments: ["Worker 3", "released from", "Frontend Parent"],
      expectedParentLinkThreadId: "thr_prev",
    },
    {
      action: "transfer",
      parentChange: {
        action: "transfer" as const,
        previousParentThreadId: "thr_prev",
        previousParentThreadTitle: "Frontend Parent",
        nextParentThreadId: "thr_next",
        nextParentThreadTitle: "Backend Parent",
      },
      expectedPlain: "Worker 3 transferred to Backend Parent",
      expectedSegments: ["Worker 3", "transferred to", "Backend Parent"],
      expectedParentLinkThreadId: "thr_next",
    },
  ] satisfies Array<{
    action: TimelineParentChange["action"];
    parentChange: TimelineParentChange;
    expectedPlain: string;
    expectedSegments: string[];
    expectedParentLinkThreadId: string;
  }>)(
    "renders parent change action $action as [thread] verb [parent]",
    ({
      parentChange,
      expectedPlain,
      expectedSegments,
      expectedParentLinkThreadId,
    }) => {
      const title = buildTimelineRowTitle(
        parentChangeSystemRow({ parentChange }),
        DEFAULT_OPTIONS,
      );

      expect(title.plain).toBe(expectedPlain);
      expect(title.segments.map((s) => s.text)).toEqual(expectedSegments);

      const threadSegment = title.segments[0];
      expect(threadSegment?.em).toBe(true);
      expect(threadSegment?.link).toEqual({
        kind: "thread",
        threadId: "thread-1",
      });

      expect(title.segments[1]?.link).toBeUndefined();
      expect(title.segments[1]?.accent).toBe("muted");

      const parentSegment = title.segments[2];
      expect(parentSegment?.em).toBe(true);
      expect(parentSegment?.link).toEqual({
        kind: "thread",
        threadId: expectedParentLinkThreadId,
      });
    },
  );

  it("renders the thread name unlinked when the row carries no thread id", () => {
    const title = buildTimelineRowTitle(
      parentChangeSystemRow({
        threadId: "",
        threadName: "Worker 3",
        parentChange: {
          action: "assign",
          previousParentThreadId: null,
          previousParentThreadTitle: null,
          nextParentThreadId: "thr_next",
          nextParentThreadTitle: "Frontend Parent",
        },
      }),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe("Worker 3 assigned to Frontend Parent");
    expect(title.segments[0]?.text).toBe("Worker 3");
    expect(title.segments[0]?.em).toBe(true);
    expect(title.segments[0]?.link).toBeUndefined();
  });

  it.each([
    {
      action: "assign",
      threadName: "Cleanup assigned to Sam",
      parentChange: {
        action: "assign" as const,
        previousParentThreadId: null,
        previousParentThreadTitle: null,
        nextParentThreadId: "thr_next",
        nextParentThreadTitle: "Frontend Parent",
      },
      expectedSegments: [
        "Cleanup assigned to Sam",
        "assigned to",
        "Frontend Parent",
      ],
    },
    {
      action: "release",
      threadName: "Cleanup released from Sam",
      parentChange: {
        action: "release" as const,
        previousParentThreadId: "thr_prev",
        previousParentThreadTitle: "Frontend Parent",
        nextParentThreadId: null,
        nextParentThreadTitle: null,
      },
      expectedSegments: [
        "Cleanup released from Sam",
        "released from",
        "Frontend Parent",
      ],
    },
    {
      action: "transfer",
      threadName: "Cleanup transferred to Sam",
      parentChange: {
        action: "transfer" as const,
        previousParentThreadId: "thr_prev",
        previousParentThreadTitle: "Frontend Parent",
        nextParentThreadId: "thr_next",
        nextParentThreadTitle: "Backend Parent",
      },
      expectedSegments: [
        "Cleanup transferred to Sam",
        "transferred to",
        "Backend Parent",
      ],
    },
  ] satisfies Array<{
    action: TimelineParentChange["action"];
    expectedSegments: string[];
    parentChange: TimelineParentChange;
    threadName: string;
  }>)(
    "preserves parent-change thread names containing the $action verb phrase",
    ({ expectedSegments, parentChange, threadName }) => {
      const title = buildTimelineRowTitle(
        parentChangeSystemRow({ parentChange, threadName }),
        DEFAULT_OPTIONS,
      );

      expect(title.segments.map((s) => s.text)).toEqual(expectedSegments);
      expect(title.segments[0]?.link).toEqual({
        kind: "thread",
        threadId: "thread-1",
      });
    },
  );

  it("falls back to an unlinked 'parent' segment when the parent title is null", () => {
    const title = buildTimelineRowTitle(
      parentChangeSystemRow({
        threadName: "Worker 3",
        parentChange: {
          action: "assign",
          previousParentThreadId: null,
          previousParentThreadTitle: null,
          nextParentThreadId: null,
          nextParentThreadTitle: null,
        },
      }),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe("Worker 3 assigned to parent");
    expect(title.segments.map((s) => s.text)).toEqual([
      "Worker 3",
      "assigned to",
      "parent",
    ]);
    expect(title.segments[2]?.link).toBeUndefined();
  });

  it("links the parent by id when the parent title is null but the id is present", () => {
    const title = buildTimelineRowTitle(
      parentChangeSystemRow({
        threadName: "Worker 3",
        parentChange: {
          action: "assign",
          previousParentThreadId: null,
          previousParentThreadTitle: null,
          nextParentThreadId: "thr_xyz",
          nextParentThreadTitle: null,
        },
      }),
      DEFAULT_OPTIONS,
    );

    expect(title.segments[2]?.text).toBe("thr_xyz");
    expect(title.segments[2]?.link).toEqual({
      kind: "thread",
      threadId: "thr_xyz",
    });
  });

  it.each([
    {
      expectedShimmer: true,
      expectedDecorationText: "",
      status: "pending",
    },
    {
      expectedShimmer: false,
      expectedDecorationText: "(error)",
      status: "error",
    },
    {
      expectedShimmer: false,
      expectedDecorationText: "(interrupted)",
      status: "interrupted",
    },
  ] satisfies Array<{
    expectedShimmer: boolean;
    expectedDecorationText: string;
    status: Exclude<TimelineSystemRow["status"], "completed" | null>;
  }>)(
    "renders parent change $status status decoration",
    ({ expectedShimmer, expectedDecorationText, status }) => {
      const title = buildTimelineRowTitle(
        parentChangeSystemRow({
          parentChange: {
            action: "assign",
            previousParentThreadId: null,
            previousParentThreadTitle: null,
            nextParentThreadId: "thr_next",
            nextParentThreadTitle: "Frontend Parent",
          },
          status,
        }),
        DEFAULT_OPTIONS,
      );

      expect(title.segments.map((s) => s.text)).toEqual([
        "Worker 3",
        "assigned to",
        "Frontend Parent",
      ]);
      expect(title.segments[0]?.shimmer).toBe(expectedShimmer);
      expect(title.tone).toBe("default");
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
      ...fileReadRow("/repo/src/app.ts"),
      status: "error",
    } satisfies TimelineFileReadWorkRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Read /repo/src/app.ts (error)");
    expect(title.tone).toBe("default");
    expect(title.decorations).toEqual([
      { kind: "status", status: "error", durationMs: null, emphasis: false },
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

  it("flags failed system operation titles with an (error) decoration, not a destructive tone", () => {
    const title = buildTimelineRowTitle(systemOperationRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe("Thread release failed (error)");
    expect(title.tone).toBe("default");
    expect(title.decorations).toEqual([
      { kind: "status", status: "error", durationMs: null, emphasis: true },
    ]);
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

  it("renders context-cleared operations without a synthetic duration", () => {
    const row: TimelineSystemRow = {
      ...baseRow("context-cleared"),
      kind: "system",
      systemKind: "operation",
      operationKind: "context-clear",
      title: "Context cleared",
      detail: null,
      status: "completed",
      completedAt: 1,
    };

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Context cleared");
    expect(title.decorations).toEqual([]);
  });

  it("formats turn durations over 60 minutes as hours", () => {
    const title = buildTimelineRowTitle(turnRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe("Worked for (1h 1m 1s)");
  });

  it("formats subsecond completed turn durations", () => {
    const row = {
      ...turnRow(),
      completedAt: 251,
      summaryCount: 3,
    } satisfies TimelineViewTurnRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Worked for (250ms)");
  });

  it("formats completed turn durations of at least one second without milliseconds", () => {
    const row = {
      ...turnRow(),
      completedAt: 1_501,
      summaryCount: 3,
    } satisfies TimelineViewTurnRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Worked for (2s)");
  });

  it("keeps subsecond completed command durations hidden", () => {
    const row = {
      ...commandRow(),
      completedAt: 251,
    } satisfies TimelineCommandWorkRow;

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Ran pnpm exec turbo run test --filter=@bb/app");
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
      expectedPlain:
        "Interrupted web search: timeline renderer (3s, interrupted)",
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
    {
      row: {
        ...imageViewRow(),
        status: "interrupted",
        completedAt: 3_001,
      } satisfies TimelineImageViewWorkRow,
      expectedPlain:
        "Interrupted image view: /tmp/sightglass-quote-merge-check/dashboard-main.png (3s, interrupted)",
    },
  ])(
    "renders interrupted $row.workKind titles with elapsed duration",
    ({ row, expectedPlain }) => {
      const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

      expect(title.plain).toBe(expectedPlain);
      expect(title.decorations).toEqual([
        {
          kind: "status",
          status: "interrupted",
          durationMs: 3_000,
          emphasis: false,
        },
      ]);
    },
  );

  it("renders image view rows with a compact visible file name and full plain path", () => {
    const title = buildTimelineRowTitle(imageViewRow(), DEFAULT_OPTIONS);

    expect(title.plain).toBe(
      "Viewed image: /tmp/sightglass-quote-merge-check/dashboard-main.png",
    );
    expect(title.segments[1]).toMatchObject({
      text: "dashboard-main.png",
      plainText: "/tmp/sightglass-quote-merge-check/dashboard-main.png",
      truncate: true,
    });
  });

  it("renders pending image view rows with active viewing title text", () => {
    const title = buildTimelineRowTitle(
      {
        ...imageViewRow(),
        completedAt: null,
        status: "pending",
      },
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe(
      "Viewing image: /tmp/sightglass-quote-merge-check/dashboard-main.png",
    );
    expect(title.segments[0]).toMatchObject({
      text: "Viewing image:",
      shimmer: true,
    });
  });

  it("can render step summaries as bundle titles or muted background summaries", () => {
    const row = workSummaryRow([webSearchRow(), webFetchRow()]);

    const bundleTitle = buildTimelineRowTitle(row, DEFAULT_OPTIONS);
    const backgroundTitle = buildTimelineRowTitle(row, {
      summaryStyle: "background",
      workStyle: "default",
    });

    expect(bundleTitle.plain).toBe("Researched 1 search query, 1 web page");
    expect(bundleTitle.segments[0]?.text).toBe("Researched");
    expect(bundleTitle.segments[1]?.text).toBe("1 search query, 1 web page");
    expect(backgroundTitle.plain).toBe("Researched 1 search query, 1 web page");
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

  it("summarizes bundled image view rows", () => {
    const row = workSummaryRow([imageViewRow(), imageViewRow()]);

    const title = buildTimelineRowTitle(row, DEFAULT_OPTIONS);

    expect(title.plain).toBe("Viewed 2 images");
  });

  it("summarizes file changes by action", () => {
    const title = buildTimelineRowTitle(
      workSummaryRow([createdFileRow(), deletedFileRow(), editedFileRow()]),
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
            ...fileReadRow("/repo/src/app.ts"),
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

  it("includes the skill name when compacting SKILL.md read titles", () => {
    const skillPath =
      "/Users/brsbl/.codex/plugins/cache/openai-bundled/browser/26.608.12217/skills/control-in-app-browser/SKILL.md";

    const title = buildTimelineRowTitle(
      fileReadRow(skillPath),
      DEFAULT_OPTIONS,
    );

    expect(title.segments.map((segment) => segment.text)).toEqual([
      "Read",
      "control-in-app-browser/SKILL.md",
    ]);
    expect(title.plain).toBe(`Read ${skillPath}`);
  });

  it("uses the plugin name when compacting plugin-root SKILL.md read titles", () => {
    const skillPath =
      "/Users/brsbl/.codex/plugins/cache/openai-bundled/browser/26.608.12217/SKILL.md";

    const title = buildTimelineRowTitle(
      fileReadRow(skillPath),
      DEFAULT_OPTIONS,
    );

    expect(title.segments.map((segment) => segment.text)).toEqual([
      "Read",
      "browser/SKILL.md",
    ]);
    expect(title.plain).toBe(`Read ${skillPath}`);
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
      { kind: "status", status: "error", durationMs: null, emphasis: false },
    ]);
  });

  it("carries a presentation badge onto command and exploration titles", () => {
    const badge = {
      glyph: "SquareUnlock02",
      label: "Outside of sandbox",
      hint: "Outside of sandbox",
      tone: "destructive",
    } as const;
    const presentation = {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
      badge,
    };
    const badgeDecoration = {
      kind: "badge",
      glyph: "SquareUnlock02",
      label: "Outside of sandbox",
      hint: "Outside of sandbox",
      tone: "destructive",
    };

    const plainCommand = buildTimelineRowTitle(
      { ...commandRow(), presentation } satisfies TimelineCommandWorkRow,
      DEFAULT_OPTIONS,
    );
    expect(plainCommand.decorations[0]).toEqual(badgeDecoration);
    expect(plainCommand.plain).toContain("(Outside of sandbox)");

    const explorationTitles = buildTimelineActivityIntentTitles({
      ...commandRow(),
      presentation,
      activityIntents: [searchIntent("TODO", "src"), listFilesIntent("test")],
    } satisfies TimelineCommandWorkRow);
    expect(explorationTitles[0]?.title.decorations).toEqual([badgeDecoration]);
    expect(explorationTitles[1]?.title.decorations).toEqual([]);

    for (const [approvalStatus, status, expected] of [
      ["waiting_for_approval", "pending", true],
      ["denied", "interrupted", true],
      [null, "pending", true],
      [null, "error", true],
      [null, "interrupted", true],
      [null, "completed", true],
    ] as const) {
      const row = {
        ...commandRow(),
        approvalStatus,
        status,
        presentation,
        activityIntents: [searchIntent("TODO", "src")],
      } satisfies TimelineCommandWorkRow;
      expect(
        buildTimelineRowTitle(row, DEFAULT_OPTIONS).decorations.some(
          (decoration) => decoration.kind === "badge",
        ),
      ).toBe(expected);
      expect(
        buildTimelineActivityIntentTitles(row)[0]?.title.decorations.some(
          (decoration) => decoration.kind === "badge",
        ),
      ).toBe(expected);
    }
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
      {
        kind: "status",
        status: "interrupted",
        durationMs: null,
        emphasis: false,
      },
    ]);
  });
});

type QuestionViewRow = Extract<TimelineViewWorkRow, { workKind: "question" }>;

function questionRow(args: {
  lifecycle: QuestionViewRow["lifecycle"];
  questions: QuestionViewRow["questions"];
  answers?: QuestionViewRow["answers"];
}): QuestionViewRow {
  return {
    ...baseRow("question-1"),
    kind: "work",
    workKind: "question",
    status: "pending",
    interactionId: "pi-1",
    lifecycle: args.lifecycle,
    questions: args.questions,
    answers: args.answers ?? null,
    statusReason: null,
  };
}

const branchQuestion = {
  id: "branch",
  prompt: "Which branch should I update?",
  shortLabel: "Branch",
  multiSelect: false,
  allowFreeText: true,
  options: [
    { value: "main", label: "main" },
    { value: "release", label: "release/1.0" },
  ],
};

const testsQuestion = {
  id: "tests",
  prompt: "Should I run the tests?",
  shortLabel: "Tests",
  multiSelect: false,
  allowFreeText: true,
  options: [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ],
};

describe("buildTimelineRowTitle question rows", () => {
  it("shows the prompt for a single pending question", () => {
    const title = buildTimelineRowTitle(
      questionRow({ lifecycle: "pending", questions: [branchQuestion] }),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe(
      "Waiting for answer Which branch should I update?",
    );
  });

  it("appends the chosen answer for a single answered question", () => {
    const title = buildTimelineRowTitle(
      questionRow({
        lifecycle: "answered",
        questions: [branchQuestion],
        answers: { branch: { selected: ["main"] } },
      }),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toBe("Answered Which branch should I update? — main");
  });

  it("summarizes the count for multiple questions instead of only the first", () => {
    const pending = buildTimelineRowTitle(
      questionRow({
        lifecycle: "pending",
        questions: [branchQuestion, testsQuestion],
      }),
      DEFAULT_OPTIONS,
    );

    expect(pending.plain).toBe("Waiting for answers to 2 questions");
    expect(pending.plain).not.toContain("Which branch");

    const answered = buildTimelineRowTitle(
      questionRow({
        lifecycle: "answered",
        questions: [branchQuestion, testsQuestion],
        answers: {
          branch: { selected: ["main"] },
          tests: { selected: ["yes"] },
        },
      }),
      DEFAULT_OPTIONS,
    );

    expect(answered.plain).toBe("Answered 2 questions");
  });

  it("marks an interrupted question with a status decoration", () => {
    const title = buildTimelineRowTitle(
      questionRow({ lifecycle: "interrupted", questions: [branchQuestion] }),
      DEFAULT_OPTIONS,
    );

    expect(title.plain).toContain("Asked Which branch should I update?");
    expect(title.decorations).toEqual([
      {
        kind: "status",
        status: "interrupted",
        durationMs: null,
        emphasis: false,
      },
    ]);
  });
});
