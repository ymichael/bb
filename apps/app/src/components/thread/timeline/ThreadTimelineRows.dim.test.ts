import type { ThreadTimelineViewRow } from "@bb/thread-view";
import { buildTimelineViewRows } from "@bb/thread-view";
import { describe, expect, it } from "vitest";
import {
  commandRow,
  conversationRow,
  systemRow,
  toolRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  PAST_ROW_DIM_CLASS_NAME,
  pastRowDimClassName,
} from "./ThreadTimelineRows";

function viewRow(
  rows: Parameters<typeof buildTimelineViewRows>[0],
): ThreadTimelineViewRow {
  const built = buildTimelineViewRows(rows);
  const first = built[0];
  if (!first) {
    throw new Error("expected at least one view row");
  }
  return first;
}

const inactiveScope = {
  activeLatestBundleId: null,
  scopeActive: false,
} as const;

describe("pastRowDimClassName", () => {
  it("recedes a completed work row", () => {
    const row = viewRow([toolRow({ status: "completed" })]);
    expect(pastRowDimClassName({ ...inactiveScope, row })).toBe(
      PAST_ROW_DIM_CLASS_NAME,
    );
  });

  it("keeps running, errored, and interrupted work rows at full strength", () => {
    for (const status of ["pending", "error", "interrupted"] as const) {
      const row = viewRow([toolRow({ status })]);
      expect(pastRowDimClassName({ ...inactiveScope, row })).toBeUndefined();
    }
  });

  it("recedes a completed system row", () => {
    const row = viewRow([systemRow({ status: "completed" })]);
    expect(row.kind).toBe("system");
    expect(pastRowDimClassName({ ...inactiveScope, row })).toBe(
      PAST_ROW_DIM_CLASS_NAME,
    );
  });

  it("keeps a still-running system row at full strength", () => {
    const row = viewRow([systemRow({ status: "pending" })]);
    expect(pastRowDimClassName({ ...inactiveScope, row })).toBeUndefined();
  });

  it("recedes a completed turn header", () => {
    const row = viewRow([turnRow({ status: "completed" })]);
    expect(row.kind).toBe("turn");
    expect(pastRowDimClassName({ ...inactiveScope, row })).toBe(
      PAST_ROW_DIM_CLASS_NAME,
    );
  });

  it("recedes rolled-up bundle and step summaries", () => {
    const bundle = viewRow([
      commandRow({ id: "cmd-1", command: "pnpm build", sourceSeqStart: 1 }),
      commandRow({ id: "cmd-2", command: "pnpm test", sourceSeqStart: 2 }),
    ]);
    expect(bundle.kind).toBe("bundle-summary");
    expect(pastRowDimClassName({ ...inactiveScope, row: bundle })).toBe(
      PAST_ROW_DIM_CLASS_NAME,
    );

    const step = viewRow([
      commandRow({ id: "cmd-1", command: "pnpm build", sourceSeqStart: 1 }),
      commandRow({ id: "cmd-2", command: "pnpm test", sourceSeqStart: 2 }),
      conversationRow({
        id: "msg-1",
        role: "assistant",
        text: "done",
        sourceSeqStart: 3,
      }),
    ]);
    expect(step.kind).toBe("step-summary");
    expect(pastRowDimClassName({ ...inactiveScope, row: step })).toBe(
      PAST_ROW_DIM_CLASS_NAME,
    );
  });

  it("keeps the active-latest bundle prominent but recedes it once scope is idle", () => {
    const bundle = viewRow([
      commandRow({ id: "cmd-1", command: "pnpm build", sourceSeqStart: 1 }),
      commandRow({ id: "cmd-2", command: "pnpm test", sourceSeqStart: 2 }),
    ]);
    expect(bundle.kind).toBe("bundle-summary");

    expect(
      pastRowDimClassName({
        activeLatestBundleId: bundle.id,
        scopeActive: true,
        row: bundle,
      }),
    ).toBeUndefined();

    expect(
      pastRowDimClassName({
        activeLatestBundleId: bundle.id,
        scopeActive: false,
        row: bundle,
      }),
    ).toBe(PAST_ROW_DIM_CLASS_NAME);
  });

  it("never dims agent or user prose", () => {
    const assistant = viewRow([
      conversationRow({ role: "assistant", text: "answer" }),
    ]);
    expect(
      pastRowDimClassName({ ...inactiveScope, row: assistant }),
    ).toBeUndefined();

    const user = viewRow([conversationRow({ role: "user", text: "question" })]);
    expect(
      pastRowDimClassName({ ...inactiveScope, row: user }),
    ).toBeUndefined();
  });
});
