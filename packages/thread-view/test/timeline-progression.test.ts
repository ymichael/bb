import { describe, expect, it } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineConversationRow,
  TimelineFileChangeWorkRow,
  TimelineRowBase,
} from "@bb/server-contract";
import {
  buildTimelineViewRows,
  buildTimelineWorkSummaryLabel,
  findActiveLatestBundleId,
  findTimelineFrontierRow,
  type ThreadTimelineViewRow,
  type TimelineBundleSummaryRow,
  type TimelineStepSummaryRow,
} from "../src/index.js";

/**
 * Frame-by-frame progression test. The frames mirror Michael's
 * `plans/timeline-rows.md` example: a turn that starts with a user message,
 * accumulates exploration work, has the exploration bundle displaced when a
 * file edit lands, and finally collapses into a step-summary at the next
 * assistant-message boundary.
 *
 * Each frame asserts the structural output of `buildTimelineViewRows` and the
 * positional `findActiveLatestBundleId` lookup that list-level renderers use
 * to decide which bundle gets the present-tense / shimmer treatment.
 */

let nextSeq = 1;

function nextSequence(): number {
  const seq = nextSeq;
  nextSeq += 1;
  return seq;
}

function baseRow(id: string): TimelineRowBase {
  const seq = nextSequence();
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: seq,
    createdAt: seq,
  };
}

function userRow(text: string): TimelineConversationRow {
  return {
    ...baseRow(`user-${text.slice(0, 8)}`),
    kind: "conversation",
    role: "user",
    text,
    attachments: null,
    userRequest: { kind: "message", status: "accepted" },
  };
}

function assistantRow(text: string): TimelineConversationRow {
  return {
    ...baseRow(`assistant-${text.slice(0, 8)}`),
    kind: "conversation",
    role: "assistant",
    text,
    attachments: null,
    userRequest: null,
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

function listIntent(pattern: string): TimelineActivityIntent {
  return {
    type: "list_files",
    command: `ls ${pattern}`,
    path: pattern,
  };
}

function commandRow(args: {
  id: string;
  command: string;
  intents?: TimelineActivityIntent[];
  status?: "completed" | "pending";
}): TimelineCommandWorkRow {
  return {
    ...baseRow(args.id),
    kind: "work",
    workKind: "command",
    status: args.status ?? "completed",
    callId: `${args.id}-call`,
    command: args.command,
    cwd: null,
    source: null,
    output: "",
    exitCode: 0,
    completedAt: 200,
    approvalStatus: null,
    activityIntents: args.intents ?? [],
  };
}

function readRow(path: string): TimelineCommandWorkRow {
  return commandRow({
    id: `read-${path}`,
    command: `cat ${path}`,
    intents: [readIntent(path)],
  });
}

function listRow(pattern: string): TimelineCommandWorkRow {
  return commandRow({
    id: `list-${pattern}`,
    command: `ls ${pattern}`,
    intents: [listIntent(pattern)],
  });
}

function editRow(path: string): TimelineFileChangeWorkRow {
  return {
    ...baseRow(`edit-${path}`),
    kind: "work",
    workKind: "file-change",
    status: "completed",
    callId: `edit-${path}-call`,
    change: {
      path,
      kind: "update",
      movePath: null,
      diff: "-old\n+new",
      diffStats: { added: 1, removed: 1 },
    },
    stdout: null,
    stderr: null,
    approvalStatus: null,
  };
}

function expectBundle(row: ThreadTimelineViewRow): TimelineBundleSummaryRow {
  if (row.kind !== "bundle-summary") {
    throw new Error(`expected bundle-summary, got ${row.kind}`);
  }
  return row;
}

function expectStep(row: ThreadTimelineViewRow): TimelineStepSummaryRow {
  if (row.kind !== "step-summary") {
    throw new Error(`expected step-summary, got ${row.kind}`);
  }
  return row;
}

describe("timeline progression frames", () => {
  it("frame 0: user-only timeline has no work yet", () => {
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Create the timeline ASCII layout artifact."),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("conversation");
    expect(findActiveLatestBundleId(rows)).toBeNull();
  });

  it("frame 1: assistant + single read renders as a leaf, not a bundle", () => {
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Create the timeline ASCII layout artifact."),
      assistantRow("I am reading the relevant docs."),
      readRow("AGENTS.md"),
    ]);

    expect(rows).toHaveLength(3);
    expect(rows[0]?.kind).toBe("conversation");
    expect(rows[1]?.kind).toBe("conversation");
    expect(rows[2]?.kind).toBe("work");
    expect(findActiveLatestBundleId(rows)).toBeNull();
  });

  it("frame 2: two same-concept reads form an active-latest exploration bundle", () => {
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Create the timeline ASCII layout artifact."),
      assistantRow("I am reading the relevant docs."),
      readRow("AGENTS.md"),
      readRow("docs/CODE_REVIEW.md"),
    ]);

    expect(rows).toHaveLength(3);
    const bundle = expectBundle(rows[2]!);
    expect(bundle.children).toHaveLength(2);
    expect(buildTimelineWorkSummaryLabel(bundle, { active: true })).toBe(
      "Exploring 2 files",
    );
    expect(findActiveLatestBundleId(rows)).toBe(bundle.id);
  });

  it("frame 3: adding a list to the exploration keeps a single bundle", () => {
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Create the timeline ASCII layout artifact."),
      assistantRow("I am reading the relevant docs."),
      readRow("AGENTS.md"),
      readRow("docs/CODE_REVIEW.md"),
      listRow("plans"),
    ]);

    expect(rows).toHaveLength(3);
    const bundle = expectBundle(rows[2]!);
    expect(bundle.children).toHaveLength(3);
    expect(buildTimelineWorkSummaryLabel(bundle, { active: true })).toBe(
      "Exploring 2 files, 1 list",
    );
    expect(findActiveLatestBundleId(rows)).toBe(bundle.id);
  });

  it("frame 4: a file edit displaces the exploration bundle to completed-not-latest", () => {
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Create the timeline ASCII layout artifact."),
      assistantRow("I am drafting the artifact."),
      readRow("AGENTS.md"),
      readRow("docs/CODE_REVIEW.md"),
      listRow("plans"),
      editRow("plans/timeline-rows.md"),
    ]);

    expect(rows).toHaveLength(4);
    const explorationBundle = expectBundle(rows[2]!);
    expect(rows[3]?.kind).toBe("work");
    expect(rows[3]).toMatchObject({ workKind: "file-change" });

    // The trailing work row is a single edit leaf, so the exploration bundle
    // is displaced (no active-latest bundle in this frame).
    expect(findActiveLatestBundleId(rows)).toBeNull();
    // The displaced bundle's label renders past tense by default.
    expect(buildTimelineWorkSummaryLabel(explorationBundle)).toBe(
      "Explored 2 files, 1 list",
    );
  });

  it("frame 5: the next assistant message closes the step into one step-summary", () => {
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Create the timeline ASCII layout artifact."),
      assistantRow("I am drafting the artifact."),
      readRow("AGENTS.md"),
      readRow("docs/CODE_REVIEW.md"),
      listRow("plans"),
      editRow("plans/timeline-rows.md"),
      assistantRow("I am checking the generated examples."),
    ]);

    expect(rows).toHaveLength(4);
    expect(rows[0]?.kind).toBe("conversation");
    expect(rows[1]?.kind).toBe("conversation");
    const step = expectStep(rows[2]!);
    expect(buildTimelineWorkSummaryLabel(step)).toBe(
      "Explored 2 files, 1 list, edited 1 file",
    );
    expect(rows[3]?.kind).toBe("conversation");
  });

  it("turn-completion lazy detail collapses trailing work into a step-summary", () => {
    // Lazy turn detail signals that the turn is closed; trailing work in the
    // children list collapses into a step-summary even without an explicit
    // assistant message after it.
    nextSeq = 1;
    const lazyTurnRows = buildTimelineViewRows(
      [
        assistantRow("I am drafting the artifact."),
        readRow("AGENTS.md"),
        readRow("docs/CODE_REVIEW.md"),
        editRow("plans/timeline-rows.md"),
      ],
      { closedScope: true },
    );

    expect(lazyTurnRows).toHaveLength(2);
    expect(lazyTurnRows[0]?.kind).toBe("conversation");
    const step = expectStep(lazyTurnRows[1]!);
    expect(buildTimelineWorkSummaryLabel(step)).toBe(
      "Explored 2 files, edited 1 file",
    );
  });
});

describe("findTimelineFrontierRow", () => {
  it("returns null for an empty timeline", () => {
    expect(findTimelineFrontierRow([])).toBeNull();
  });

  it("returns null when every row is a user-role conversation row", () => {
    // User-role conversation rows are skipped because they're inputs to
    // the agent rather than events the agent produced.
    nextSeq = 1;
    const rows = buildTimelineViewRows([userRow("Initial request.")]);
    expect(findTimelineFrontierRow(rows)).toBeNull();
  });

  it("looks past a trailing user-role conversation row to the prior agent row", () => {
    // A pending steer at the tail does not displace the previous frontier
    // of agent-produced activity.
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Initial request."),
      assistantRow("Working on it."),
      readRow("AGENTS.md"),
      readRow("docs/CODE_REVIEW.md"),
      {
        ...baseRow("steer-1"),
        kind: "conversation",
        role: "user",
        text: "Keep this in mind",
        attachments: null,
        userRequest: { kind: "steer", status: "pending" },
      },
    ]);

    const frontier = findTimelineFrontierRow(rows);
    expect(frontier?.kind).toBe("bundle-summary");
  });

  it("treats a trailing assistant-role conversation row as the frontier", () => {
    // Assistant-role conversation rows count as agent-produced events,
    // so they become the frontier when they trail the timeline.
    nextSeq = 1;
    const rows = buildTimelineViewRows([
      userRow("Initial request."),
      readRow("AGENTS.md"),
      readRow("docs/CODE_REVIEW.md"),
      assistantRow("All done."),
    ]);

    const frontier = findTimelineFrontierRow(rows);
    expect(frontier?.kind).toBe("conversation");
    if (frontier?.kind === "conversation") {
      expect(frontier.role).toBe("assistant");
    }
  });
});
