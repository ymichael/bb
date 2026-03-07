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

function threadOperationIntent(
  seq: number,
  title: string,
  detail?: string,
  options?: {
    action?: "commit" | "squash_merge";
    phase?: "requested" | "queued" | "running" | "completed" | "failed" | "update";
    operationId?: string;
  },
): Extract<UIMessage, { kind: "operation" }> {
  return {
    kind: "operation",
    id: `thread-operation-${seq}`,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    opType: "thread-operation-intent",
    title,
    ...(options?.action && options?.phase
      ? {
          threadOperation: {
            action: options.action,
            phase: options.phase,
            ...(options.operationId ? { operationId: options.operationId } : {}),
          },
        }
      : {}),
    ...(detail ? { detail } : {}),
  };
}

function worktreeOperation(
  seq: number,
  opType: "worktree-commit" | "worktree-squash-merge",
  title: string,
  detail?: string,
): Extract<UIMessage, { kind: "operation" }> {
  return {
    kind: "operation",
    id: `worktree-operation-${seq}`,
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

  it("uses primary-checkout metadata for collapse boundaries instead of title text", () => {
    const rows = getOperationRows([
      {
        ...primaryCheckoutOperation(
          1,
          "Primary checkout promotion update",
          "Promoting thread worktree into primary checkout",
        ),
        primaryCheckout: {
          action: "promote",
          phase: "started",
        },
      },
      {
        ...primaryCheckoutOperation(
          2,
          "Primary checkout promotion update",
          "Primary checkout now reflects this thread worktree",
        ),
        primaryCheckout: {
          action: "promote",
          phase: "completed",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Primary checkout promotion update");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
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
    expect(rows[0]?.title).toBe("Provisioned Worktree");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(4);
    expect(rows[0]?.detail).toContain("Environment: Git Worktree Workspace");
    expect(rows[0]?.detail).toContain(".bb-env-setup.ts • /tmp/worktree • Timeout 600s");
    expect(rows[0]?.detail).toContain(".bb-env-setup.ts • /tmp/worktree • Timeout 600s • Duration 3074ms");
    expect(rows[0]?.detail).toContain("worktree • /tmp/worktree");
  });
});

describe("buildThreadDetailRows squash merge operation collapsing", () => {
  it("prefers the canonical worktree squash outcome over duplicate lifecycle updates", () => {
    const rows = getOperationRows([
      threadOperationIntent(
        1,
        "Squash merge requested",
        "Squash-merge operation requested",
      ),
      threadOperationIntent(
        2,
        "Squash merge queued",
        "Squash-merge operation queued for deterministic execution",
      ),
      threadOperationIntent(
        3,
        "Squash merging changes",
        "Running squash-merge operation",
      ),
      worktreeOperation(
        4,
        "worktree-squash-merge",
        "Squash merged",
        "Squash merged into main",
      ),
      threadOperationIntent(
        5,
        "Squash merge completed",
        "Squash merged into main",
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("worktree-squash-merge");
    expect(rows[0]?.title).toBe("Squash merged");
    expect(rows[0]?.detail).toContain("Squash merged into main");
  });

  it("keeps in-progress squash lifecycle visible when no final worktree outcome exists yet", () => {
    const rows = getOperationRows([
      threadOperationIntent(
        1,
        "Squash merge requested",
        "Squash-merge operation requested",
      ),
      {
        kind: "user",
        id: "prompt-2",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        text: "Please squash-merge the changes in this thread workspace.",
      },
      threadOperationIntent(
        3,
        "Squash merge queued",
        "Squash-merge operation queued for deterministic execution",
      ),
      threadOperationIntent(
        4,
        "Squash merging changes",
        "Running squash-merge operation",
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-operation-intent");
    expect(rows[0]?.title).toBe("Squash merging changes");
    expect(rows[0]?.detail).toContain("Running squash-merge operation");
    expect(rows[0]?.detail).toContain("Prompt:");
  });
});

describe("buildThreadDetailRows commit operation collapsing", () => {
  it("prefers the canonical worktree commit outcome over duplicate lifecycle updates", () => {
    const rows = getOperationRows([
      threadOperationIntent(
        1,
        "Commit requested",
        "Commit operation requested",
      ),
      threadOperationIntent(
        2,
        "Commit queued",
        "Commit operation queued for deterministic execution",
      ),
      threadOperationIntent(
        3,
        "Committing changes",
        "Running commit operation",
      ),
      worktreeOperation(
        4,
        "worktree-commit",
        "Committed changes",
        "Committed changes",
      ),
      threadOperationIntent(
        5,
        "Commit completed",
        "Committed changes",
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("worktree-commit");
    expect(rows[0]?.title).toBe("Committed changes");
    expect(rows[0]?.detail).toContain("Committed changes");
  });

  it("collapses in-flight commit lifecycle updates when no canonical outcome exists yet", () => {
    const rows = getOperationRows([
      threadOperationIntent(
        1,
        "Committing changes",
        "Running commit operation",
        {
          action: "commit",
          phase: "running",
          operationId: "op-1",
        },
      ),
      threadOperationIntent(
        2,
        "Commit completed",
        "Committed changes",
        {
          action: "commit",
          phase: "completed",
          operationId: "op-1",
        },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-operation-intent");
    expect(rows[0]?.title).toBe("Commit completed");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
    expect(rows[0]?.detail).toContain("Committed changes");
  });

  it("does not merge commit lifecycle updates across different operation ids", () => {
    const rows = getOperationRows([
      threadOperationIntent(
        1,
        "Committing changes",
        "Running commit operation for first request",
        {
          action: "commit",
          phase: "running",
          operationId: "op-1",
        },
      ),
      threadOperationIntent(
        2,
        "Commit completed",
        "Committed changes for second request",
        {
          action: "commit",
          phase: "completed",
          operationId: "op-2",
        },
      ),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe("Committing changes");
    expect(rows[1]?.title).toBe("Commit completed");
  });

  it("keeps earlier completed lifecycle rows when a later operation has the canonical outcome", () => {
    const rows = getOperationRows([
      threadOperationIntent(
        1,
        "Commit completed",
        "Committed changes from op-1",
        {
          action: "commit",
          phase: "completed",
          operationId: "op-1",
        },
      ),
      threadOperationIntent(
        2,
        "Committing changes",
        "Running commit operation for op-2",
        {
          action: "commit",
          phase: "running",
          operationId: "op-2",
        },
      ),
      worktreeOperation(
        3,
        "worktree-commit",
        "Committed changes",
        "Committed changes from op-2",
      ),
      threadOperationIntent(
        4,
        "Commit completed",
        "Committed changes from op-2",
        {
          action: "commit",
          phase: "completed",
          operationId: "op-2",
        },
      ),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.opType).toBe("thread-operation-intent");
    expect(rows[0]?.title).toBe("Commit completed");
    expect(rows[0]?.detail).toContain("op-1");
    expect(rows[1]?.opType).toBe("worktree-commit");
    expect(rows[1]?.detail).toContain("op-2");
  });
});
