import { describe, expect, it } from "vitest";
import {
  CONTAINER_BOUNDS_CLASS,
  classifyRowSnapshotDiff,
  createRowDiffReport,
  describeRowChange,
  idleRowDiffClasses,
  mergeRowDiffReport,
  type RowDiffClass,
  type RowSnapshotVariants,
  type SnapshotRow,
} from "./row-diff-classes.js";

function turn(
  turnId: string,
  segment: number | null,
  children: SnapshotRow[] | null,
  bounds: {
    summaryCount: number;
    sourceSeqStart: number;
    sourceSeqEnd: number;
  },
): SnapshotRow {
  return {
    kind: "turn",
    id: segment === null ? `t:${turnId}:turn` : `t:${turnId}:turn:${segment}`,
    turnId,
    children,
    status: "completed",
    ...bounds,
  };
}

function tool(callId: string, extra: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    kind: "work",
    workKind: "tool",
    id: `t:tool:${callId}`,
    callId,
    toolName: "Read",
    output: "",
    ...extra,
  };
}

function assistant(itemId: string, text: string): SnapshotRow {
  return {
    kind: "conversation",
    role: "assistant",
    id: `t:assistant:${itemId}`,
    text,
  };
}

function snapshot(
  variants: Record<string, SnapshotRow[]>,
): RowSnapshotVariants {
  return {
    variants: Object.fromEntries(
      Object.entries(variants).map(([name, rows]) => [
        name,
        { pages: [{ rows }] },
      ]),
    ),
  };
}

function run(
  before: RowSnapshotVariants,
  after: RowSnapshotVariants,
  classes: RowDiffClass[],
) {
  const report = createRowDiffReport();
  const changes = classifyRowSnapshotDiff(
    "p/thr",
    before,
    after,
    classes,
    report,
  );
  return { changes, report };
}

describe("classifyRowSnapshotDiff", () => {
  it("matches rows by identity, so an inserted sibling is one added change and the shifted rows are untouched", () => {
    const before = snapshot({
      nested: [
        turn("t1", null, [tool("a"), tool("c")], {
          summaryCount: 2,
          sourceSeqStart: 1,
          sourceSeqEnd: 5,
        }),
      ],
      default: [
        turn("t1", null, null, {
          summaryCount: 2,
          sourceSeqStart: 1,
          sourceSeqEnd: 5,
        }),
      ],
    });
    const after = snapshot({
      nested: [
        turn("t1", null, [tool("a"), tool("b"), tool("c")], {
          summaryCount: 3,
          sourceSeqStart: 1,
          sourceSeqEnd: 5,
        }),
      ],
      default: [
        turn("t1", null, null, {
          summaryCount: 3,
          sourceSeqStart: 1,
          sourceSeqEnd: 5,
        }),
      ],
    });
    const { report } = run(before, after, [
      {
        name: "unhidden",
        reason: "r",
        match: { added: { kind: "work", workKind: "tool" } },
      },
    ]);
    expect(report.unclassified).toEqual([]);
    expect(report.claims.get("unhidden")).toBe(1);
    expect(report.claims.get(CONTAINER_BOUNDS_CLASS)).toBe(2);
  });

  it("reports a change no class claims, with the changed field set", () => {
    const before = snapshot({ default: [tool("a", { output: "x" })] });
    const after = snapshot({
      default: [tool("a", { output: "y", toolName: "Grep" })],
    });
    const { report } = run(before, after, [
      {
        name: "output-only",
        reason: "r",
        match: { changed: { workKind: "tool", fields: ["output"] } },
      },
    ]);
    expect(report.unclassified.map(describeRowChange)).toEqual([
      "changed work/tool [output,toolName]",
    ]);
    expect(
      idleRowDiffClasses(
        [
          {
            name: "output-only",
            reason: "r",
            match: { changed: { workKind: "tool", fields: ["output"] } },
          },
        ],
        report,
      ),
    ).toEqual(["output-only"]);
  });

  it("reports a dead entry even when a sibling entry with the same name fired", () => {
    const before = snapshot({ default: [tool("a")] });
    const after = snapshot({
      default: [{ ...tool("a"), workKind: "file-read", id: "t:file-read:a" }],
    });
    const classes: RowDiffClass[] = [
      {
        name: "upgraded",
        reason: "fires",
        match: {
          reshaped: {
            from: { workKind: "tool" },
            to: { workKind: "file-read" },
          },
        },
      },
      {
        name: "upgraded",
        reason: "never fires",
        match: {
          reshaped: { from: { workKind: "tool" }, to: { workKind: "search" } },
        },
      },
    ];
    const { report } = run(before, after, classes);
    expect(report.claims.get("upgraded")).toBe(1);
    expect(idleRowDiffClasses(classes, report)).toEqual([
      `upgraded#1 ${JSON.stringify(classes[1]!.match)}`,
    ]);
    const merged = createRowDiffReport();
    mergeRowDiffReport(merged, report);
    expect(idleRowDiffClasses(classes, merged)).toEqual(
      idleRowDiffClasses(classes, report),
    );
  });

  it("treats a turn that lost a segment as re-segmented and the row that folded into it as moved, not removed", () => {
    const text = assistant("m18", "I'll wait for the agent.");
    const before = snapshot({
      nested: [
        turn("t1", 0, [tool("a")], {
          summaryCount: 1,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
        text,
        turn("t1", 1, [tool("b")], {
          summaryCount: 1,
          sourceSeqStart: 5,
          sourceSeqEnd: 7,
        }),
      ],
      default: [
        turn("t1", 0, null, {
          summaryCount: 1,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
        text,
        turn("t1", 1, null, {
          summaryCount: 1,
          sourceSeqStart: 5,
          sourceSeqEnd: 7,
        }),
      ],
    });
    const after = snapshot({
      nested: [
        turn("t1", null, [tool("a"), text, tool("b")], {
          summaryCount: 3,
          sourceSeqStart: 1,
          sourceSeqEnd: 7,
        }),
      ],
      default: [
        turn("t1", null, null, {
          summaryCount: 3,
          sourceSeqStart: 1,
          sourceSeqEnd: 7,
        }),
      ],
    });
    const { report } = run(before, after, [
      {
        name: "rejoined",
        reason: "r",
        match: { resegmented: { kind: "turn" } },
      },
      {
        name: "rejoined",
        reason: "r",
        match: { moved: { kind: "conversation", role: "assistant" } },
      },
    ]);
    expect(report.unclassified).toEqual([]);
    expect(report.claims.get("rejoined")).toBe(4);
  });

  it("recurses into a reshaped row's children and ignores a child's id prefix change", () => {
    const child = (prefix: string) => ({
      kind: "conversation",
      role: "assistant",
      id: `${prefix}:child:t:assistant:c1`,
      text: "hi",
    });
    const before = snapshot({
      nested: [{ ...tool("agent"), childRows: undefined }],
    });
    const after = snapshot({
      nested: [
        {
          kind: "work",
          workKind: "delegation",
          id: "t:delegation:agent",
          callId: "agent",
          toolName: "Read",
          output: "",
          childRows: [child("t:delegation:agent")],
        },
      ],
    });
    const { report } = run(before, after, [
      {
        name: "structural",
        reason: "r",
        match: {
          reshaped: {
            from: { workKind: "tool" },
            to: { workKind: "delegation" },
          },
        },
      },
      {
        name: "surfaced",
        reason: "r",
        match: { added: { kind: "conversation", nested: true } },
      },
    ]);
    expect(report.unclassified).toEqual([]);
    expect(report.claims.get("structural")).toBe(1);
    expect(report.claims.get("surfaced")).toBe(1);
  });

  it("lets a reshaped class restrict the fields the reshape may touch", () => {
    const before = snapshot({ default: [tool("a", { status: "completed" })] });
    const after = snapshot({
      default: [
        {
          ...tool("a"),
          workKind: "file-read",
          id: "t:file-read:a",
          path: "/x",
          status: "failed",
        },
      ],
    });
    const restricted: RowDiffClass = {
      name: "upgraded",
      reason: "r",
      match: {
        reshaped: {
          from: { workKind: "tool" },
          to: { workKind: "file-read" },
          fields: ["id", "path"],
        },
      },
    };
    const unrestricted = run(before, after, [
      {
        ...restricted,
        match: {
          reshaped: {
            from: { workKind: "tool" },
            to: { workKind: "file-read" },
          },
        },
      },
    ]);
    expect(unrestricted.report.unclassified).toEqual([]);
    const { report } = run(before, after, [restricted]);
    expect(report.unclassified.map(describeRowChange)).toEqual([
      "reshaped work/tool → work/file-read [id,path,status]",
    ]);
  });

  it("attributes a turn's bounds change to the classes its children fell into", () => {
    const before = snapshot({
      nested: [
        turn("t1", null, [tool("a")], {
          summaryCount: 1,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
      default: [
        turn("t1", null, null, {
          summaryCount: 1,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
    });
    const after = snapshot({
      nested: [
        turn("t1", null, [tool("a"), tool("b")], {
          summaryCount: 2,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
      default: [
        turn("t1", null, null, {
          summaryCount: 2,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
    });
    const { report } = run(before, after, [
      { name: "unhidden", reason: "r", match: { added: { workKind: "tool" } } },
    ]);
    expect(report.unclassified).toEqual([]);
    expect(Object.fromEntries(report.containerBoundsBy)).toEqual({
      unhidden: 2,
    });
  });

  it("compares the page fields beside rows and lets a pageField class claim them", () => {
    const before = {
      variants: {
        default: { pages: [{ rows: [tool("a")], pendingTodos: null }] },
      },
    };
    const after = {
      variants: {
        default: {
          pages: [{ rows: [tool("a")], pendingTodos: { items: [] } }],
        },
      },
    };
    expect(
      run(before, after, []).report.unclassified.map(describeRowChange),
    ).toEqual(["changed page.pendingTodos"]);
    const claimed = run(before, after, [
      {
        name: "banner",
        reason: "r",
        match: { pageField: { field: "pendingTodos" } },
      },
    ]);
    expect(claimed.report.unclassified).toEqual([]);
    expect(claimed.report.claims.get("banner")).toBe(1);
  });

  it("does not let a turn status change hide behind a changed child", () => {
    const before = snapshot({
      nested: [
        turn("t1", null, [tool("a")], {
          summaryCount: 1,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
      default: [
        turn("t1", null, null, {
          summaryCount: 1,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
    });
    const after = snapshot({
      nested: [
        {
          ...turn(
            "t1",
            null,
            [{ ...tool("a"), workKind: "file-read", id: "t:file-read:a" }],
            {
              summaryCount: 1,
              sourceSeqStart: 1,
              sourceSeqEnd: 3,
            },
          ),
          status: "interrupted",
        },
      ],
      default: [
        {
          ...turn("t1", null, null, {
            summaryCount: 1,
            sourceSeqStart: 1,
            sourceSeqEnd: 3,
          }),
          status: "interrupted",
        },
      ],
    });
    const { report } = run(before, after, [
      {
        name: "upgraded",
        reason: "r",
        match: {
          reshaped: {
            from: { workKind: "tool" },
            to: { workKind: "file-read" },
          },
        },
      },
    ]);
    expect(report.claims.get("upgraded")).toBe(1);
    expect(report.claims.get(CONTAINER_BOUNDS_CLASS)).toBeUndefined();
    expect(report.unclassified.map(describeRowChange)).toEqual([
      "changed turn [status]",
      "changed turn [status]",
    ]);
  });

  it("does not let a bounds-only turn change hide behind children that did not change", () => {
    const before = snapshot({
      nested: [
        turn("t1", null, [tool("a")], {
          summaryCount: 1,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
    });
    const after = snapshot({
      nested: [
        turn("t1", null, [tool("a")], {
          summaryCount: 4,
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        }),
      ],
    });
    const { report } = run(before, after, []);
    expect(report.unclassified.map(describeRowChange)).toEqual([
      "changed turn [summaryCount]",
    ]);
  });
});
