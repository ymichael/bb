import { describe, expect, it } from "vitest";
import { buildThreadDetailRows, type ThreadDetailRow } from "../src/thread-detail-rows.js";
import type { UIMessage } from "../src/ui-message.js";

function primaryCheckoutOperation(
  seq: number,
  title: string,
  detail?: string,
): Extract<UIMessage, { kind: "operation" }> {
  return {
    kind: "operation",
    id: `op-${seq}`,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    opType: "primary-checkout",
    title,
    ...(detail ? { detail } : {}),
  };
}

function getOperationRows(messages: UIMessage[]): Array<Extract<UIMessage, { kind: "operation" }>> {
  return buildThreadDetailRows(messages)
    .filter((row): row is Extract<ThreadDetailRow, { kind: "message" }> =>
      row.kind === "message" && row.message.kind === "operation")
    .map((row) => row.message);
}

describe("buildThreadDetailRows primary-checkout operation collapsing", () => {
  it("collapses a promote started/completed pair into a single operation row", () => {
    const rows = getOperationRows([
      primaryCheckoutOperation(
        1,
        "Promoting primary checkout",
        "Promoting thread worktree into primary checkout",
      ),
      primaryCheckoutOperation(
        2,
        "Promoted to primary checkout",
        "Primary checkout now reflects this thread worktree • Branch: feat/example",
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Promoted to primary checkout");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
    expect(rows[0]?.detail).toContain("Promoting thread worktree into primary checkout");
    expect(rows[0]?.detail).toContain("Primary checkout now reflects this thread worktree");
  });

  it("keeps distinct promote and demote cycles as separate rows", () => {
    const rows = getOperationRows([
      primaryCheckoutOperation(1, "Promoting primary checkout"),
      primaryCheckoutOperation(2, "Promoted to primary checkout"),
      primaryCheckoutOperation(3, "Demoting primary checkout"),
      primaryCheckoutOperation(4, "Demoted from primary checkout"),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe("Promoted to primary checkout");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
    expect(rows[1]?.title).toBe("Demoted from primary checkout");
    expect(rows[1]?.sourceSeqStart).toBe(3);
    expect(rows[1]?.sourceSeqEnd).toBe(4);
  });

  it("keeps an in-progress primary-checkout update visible while pending", () => {
    const rows = getOperationRows([
      primaryCheckoutOperation(1, "Promoting primary checkout"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Promoting primary checkout");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(1);
  });
});
