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

function provisioningOperation(
  seq: number,
  opType:
    | "provisioning-started"
    | "provisioning-env-setup"
    | "provisioning-completed",
  title: string,
  detail?: string,
): Extract<UIMessage, { kind: "operation" }> {
  return {
    kind: "operation",
    id: `provisioning-${seq}`,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    opType,
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

  it("collapses a completed promote/demote cycle into a single round-trip row", () => {
    const rows = getOperationRows([
      primaryCheckoutOperation(1, "Promoting primary checkout"),
      primaryCheckoutOperation(2, "Promoted to primary checkout"),
      primaryCheckoutOperation(3, "Demoting primary checkout"),
      primaryCheckoutOperation(4, "Demoted from primary checkout"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Promoted then demoted as primary checkout");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(4);
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

describe("buildThreadDetailRows provisioning operation collapsing", () => {
  it("collapses provisioning start/env setup/completed updates into one operation row", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        "Environment: Git Worktree Workspace",
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup started",
        ".bb-env-setup.ts • /tmp/worktree • Timeout 600s",
      ),
      provisioningOperation(
        3,
        "provisioning-env-setup",
        "Environment setup completed",
        ".bb-env-setup.ts • /tmp/worktree • Timeout 600s • Duration 3074ms",
      ),
      provisioningOperation(
        4,
        "provisioning-completed",
        "Provisioning ready",
        "worktree • /tmp/worktree",
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("provisioning");
    expect(rows[0]?.title).toBe("Provisioned Git Worktree Workspace");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(4);
    expect(rows[0]?.detail).toContain("Environment: Git Worktree Workspace");
    expect(rows[0]?.detail).toContain(".bb-env-setup.ts • /tmp/worktree • Timeout 600s");
    expect(rows[0]?.detail).toContain(".bb-env-setup.ts • /tmp/worktree • Timeout 600s • Duration 3074ms");
    expect(rows[0]?.detail).toContain("worktree • /tmp/worktree");
  });
});
