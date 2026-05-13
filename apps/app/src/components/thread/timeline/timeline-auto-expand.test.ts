import { describe, expect, it } from "vitest";
import { buildTimelineViewRows } from "@bb/thread-view";
import {
  commandRow,
  conversationRow,
  delegationRow,
} from "@/test/fixtures/thread-timeline-rows";
import { collectTimelineAutoExpandedRowIds } from "./timeline-auto-expand";

describe("collectTimelineAutoExpandedRowIds", () => {
  it("returns no auto-expanded ids when the scope is inactive", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        output: "first output",
        sourceSeqStart: 1,
        status: "pending",
      }),
    ]);

    const ids = collectTimelineAutoExpandedRowIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a trailing bundle in an active scope without expanding its children", () => {
    // Single rule: in an active container, expand the trailing row if it
    // is expandable. Bundle children do not get the rule applied.
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
    ]);

    expect(rows).toHaveLength(1);
    const bundle = rows[0];
    if (!bundle || bundle.kind !== "bundle-summary") {
      throw new Error("expected the trailing row to be a bundle-summary");
    }

    const ids = collectTimelineAutoExpandedRowIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([bundle.id]);
    // Bundle children stay collapsed.
    for (const child of bundle.children) {
      expect(ids.has(child.id)).toBe(false);
    }
  });

  it("does not auto-expand a displaced completed bundle in an active scope", () => {
    // Two completed bundles in an active scope. Only the trailing/latest
    // bundle auto-expands; the earlier displaced bundle stays collapsed
    // so the timeline doesn't surface stale, finished work.
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        sourceSeqStart: 1,
      }),
      commandRow({
        id: "command-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
      }),
      commandRow({
        id: "explore-1",
        command: "cat src/app.ts",
        activityIntents: [
          {
            type: "read",
            command: "cat src/app.ts",
            name: "app.ts",
            path: "src/app.ts",
          },
        ],
        sourceSeqStart: 3,
      }),
      commandRow({
        id: "explore-2",
        command: "cat src/other.ts",
        activityIntents: [
          {
            type: "read",
            command: "cat src/other.ts",
            name: "other.ts",
            path: "src/other.ts",
          },
        ],
        sourceSeqStart: 4,
      }),
    ]);

    // Two bundles: the run-commands group and the exploration group.
    expect(rows).toHaveLength(2);
    const [displaced, trailing] = rows;
    if (!displaced || displaced.kind !== "bundle-summary") {
      throw new Error("expected the first row to be a bundle-summary");
    }
    if (!trailing || trailing.kind !== "bundle-summary") {
      throw new Error("expected the trailing row to be a bundle-summary");
    }

    const ids = collectTimelineAutoExpandedRowIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has(trailing.id)).toBe(true);
    expect(ids.has(displaced.id)).toBe(false);
  });

  it("does not auto-expand anything when an assistant message is the frontier", () => {
    // Assistant-role conversation rows count as the frontier (events the
    // agent produced) but are not expandable, so they suppress
    // auto-expansion of any bundle before them.
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
      conversationRow({
        id: "assistant-final",
        role: "assistant",
        text: "All done.",
      }),
    ]);

    const ids = collectTimelineAutoExpandedRowIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("looks past trailing user conversation rows when finding the frontier", () => {
    // User-role conversation rows (initial messages, follow-ups, pending
    // or accepted steers) are inputs to the agent, not events the agent
    // produced. The rule skips them and treats the previous agent-emitted
    // row as the frontier.
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
      conversationRow({
        id: "pending-steer-1",
        role: "user",
        text: "Keep this in mind",
        userRequest: { kind: "steer", status: "pending" },
      }),
    ]);

    const bundle = rows.find((row) => row.kind === "bundle-summary");
    if (!bundle) {
      throw new Error("expected a bundle-summary row in the view");
    }

    const ids = collectTimelineAutoExpandedRowIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has(bundle.id)).toBe(true);
  });

  it("does not auto-expand a pending delegation's frontier on an idle thread", () => {
    // Strict scope propagation: an idle top-level scope does not bestow
    // an active scope on its children, even if the delegation itself is
    // pending. The user is browsing history, not watching live work.
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "idle-pending-delegation",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-pending-command",
            command: "pnpm test",
            output: "still running",
            sourceSeqStart: 50,
            status: "pending",
          }),
        ],
      }),
    ]);

    const ids = collectTimelineAutoExpandedRowIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a pending delegation's frontier when the top-level scope is active", () => {
    // Active scope propagates *through* a pending delegation: the
    // delegation row itself auto-expands at the top level and the
    // pending command inside the delegation auto-expands as the
    // delegation's frontier.
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "active-pending-delegation",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-pending-command",
            command: "pnpm test",
            output: "still running",
            sourceSeqStart: 50,
            status: "pending",
          }),
        ],
      }),
    ]);

    const ids = collectTimelineAutoExpandedRowIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has("active-pending-delegation")).toBe(true);
    expect(ids.has("nested-pending-command")).toBe(true);
  });
});
