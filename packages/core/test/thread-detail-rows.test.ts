import { describe, expect, it } from "vitest";
import { buildThreadDetailRows, type ThreadDetailRow } from "../src/thread-detail-rows.js";
import type { UIMessage, UIProvisioningTranscriptEntry } from "../src/ui-message.js";

function primaryCheckoutOperation(
  seq: number,
  title: string,
  detail?: string,
): Extract<UIMessage, { kind: "operation" }> {
  const threadOperation = (() => {
    switch (title) {
      case "Promoting primary checkout":
        return { operation: "primary_checkout", status: "started", metadata: { action: "promote" } } as const;
      case "Promoted to primary checkout":
        return { operation: "primary_checkout", status: "completed", metadata: { action: "promote" } } as const;
      case "Primary checkout promotion failed":
        return { operation: "primary_checkout", status: "failed", metadata: { action: "promote" } } as const;
      case "Primary checkout already promoted":
        return { operation: "primary_checkout", status: "noop", metadata: { action: "promote" } } as const;
      case "Demoting primary checkout":
        return { operation: "primary_checkout", status: "started", metadata: { action: "demote" } } as const;
      case "Demoted from primary checkout":
        return { operation: "primary_checkout", status: "completed", metadata: { action: "demote" } } as const;
      case "Primary checkout demotion failed":
        return { operation: "primary_checkout", status: "failed", metadata: { action: "demote" } } as const;
      case "Primary checkout already demoted":
        return { operation: "primary_checkout", status: "noop", metadata: { action: "demote" } } as const;
      default:
        return undefined;
    }
  })();
  return {
    kind: "operation",
    id: `op-${seq}`,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    opType: "operation",
    title,
    ...(threadOperation ? { threadOperation } : {}),
    ...(detail ? { detail } : {}),
  };
}

function provisioningOperation(
  seq: number,
  opType:
    | "provisioning-started"
    | "provisioning-progress"
    | "provisioning-env-setup"
    | "provisioning-completed",
  title: string,
  detail?: string,
  options?: {
    environmentDisplayName?: string;
    workspaceRoot?: string;
    branchName?: string;
    fallbackReason?: string;
    phases?: {
      prepare_environment?: {
        status: "started" | "completed" | "failed";
        startedAt?: number;
        durationMs?: number;
      };
      start_provider_session?: {
        status: "started" | "completed" | "failed";
        startedAt?: number;
        durationMs?: number;
      };
    };
    setup?: {
      status: "started" | "running" | "completed" | "failed";
      startedAt?: number;
      scriptPath?: string;
      timeoutMs?: number;
      durationMs?: number;
      output?: string;
    };
    transcript?: UIProvisioningTranscriptEntry[];
  },
): Extract<UIMessage, { kind: "operation" }> {
  const transcript = [
    ...(options?.environmentDisplayName
      ? [{ key: "environment", text: `environment: ${options.environmentDisplayName}` }]
      : []),
    ...(options?.branchName
      ? [{ key: "branch", text: `checked out branch ${options.branchName}` }]
      : []),
    ...(options?.setup?.scriptPath
      ? [{
          key: "setup",
          text:
            options.setup.status === "completed"
              ? `ran ${options.setup.scriptPath}`
              : options.setup.status === "failed"
                ? `setup script failed: ${options.setup.scriptPath}`
                : `running ${options.setup.scriptPath}`,
          ...(options.setup.startedAt !== undefined
            ? { startedAt: options.setup.startedAt }
            : {}),
        }]
      : []),
    ...(options?.phases?.start_provider_session
      ? [{
          key: "phase:start_provider_session",
          text:
            options.phases.start_provider_session.status === "completed"
              ? "started provider session"
              : options.phases.start_provider_session.status === "failed"
                ? "provider session start failed"
                : "starting provider session",
          ...(options.phases.start_provider_session.startedAt !== undefined
            ? { startedAt: options.phases.start_provider_session.startedAt }
            : {}),
        }]
      : []),
    ...(options?.fallbackReason
      ? [{ key: "fallback", text: `fallback: ${options.fallbackReason}` }]
      : []),
    ...(options?.transcript
      ? options.transcript.map((entry) => structuredClone(entry))
      : []),
  ].reduce<UIProvisioningTranscriptEntry[]>((entries, entry) => {
    const existingIndex = entries.findIndex(
      (existingEntry) => existingEntry.key === entry.key,
    );
    if (existingIndex === -1) {
      entries.push(entry);
      return entries;
    }
    entries[existingIndex] = entry;
    return entries;
  }, []);

  return {
    kind: "operation",
    id: `provisioning-${seq}`,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    opType,
    title,
    ...((options?.environmentDisplayName ||
    options?.workspaceRoot ||
    options?.fallbackReason ||
    options?.phases ||
    options?.setup ||
    transcript.length > 0)
      ? {
          provisioning: {
            ...(options?.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
            ...(options?.setup ? { setup: { ...options.setup } } : {}),
            ...(transcript.length > 0 ? { transcript } : {}),
          },
        }
      : {}),
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
  const inferredThreadOperation = (() => {
    switch (title) {
      case "Commit requested":
        return { operation: "commit", status: "requested" } as const;
      case "Commit queued":
        return { operation: "commit", status: "queued" } as const;
      case "Committing changes":
        return { operation: "commit", status: "running" } as const;
      case "Commit completed":
        return { operation: "commit", status: "completed" } as const;
      case "Commit failed":
        return { operation: "commit", status: "failed" } as const;
      case "Commit operation update":
        return { operation: "commit", status: "update" } as const;
      case "Squash merge requested":
        return { operation: "squash_merge", status: "requested" } as const;
      case "Squash merge queued":
        return { operation: "squash_merge", status: "queued" } as const;
      case "Squash merging changes":
        return { operation: "squash_merge", status: "running" } as const;
      case "Squash merge completed":
        return { operation: "squash_merge", status: "completed" } as const;
      case "Squash merge failed":
        return { operation: "squash_merge", status: "failed" } as const;
      case "Squash merge operation update":
        return { operation: "squash_merge", status: "update" } as const;
      default:
        return undefined;
    }
  })();
  return {
    kind: "operation",
    id: `thread-operation-${seq}`,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    opType: "operation",
    title,
    ...((options?.action && options?.phase) || inferredThreadOperation
      ? {
          threadOperation: {
            operation: options?.action ?? inferredThreadOperation?.operation ?? "commit",
            status: options?.phase ?? inferredThreadOperation?.status ?? "update",
            ...(options?.operationId ? { operationId: options.operationId } : {}),
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

describe("buildThreadDetailRows primary-checkout (operation) collapsing", () => {
  it("does not collapse earlier assistant messages into a tool group", () => {
    const rows = buildThreadDetailRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "say hi",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        text: "Hi!",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "What can I help with?",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "message"]);
    expect(rows.filter((row) => row.kind === "tool-group")).toHaveLength(0);
  });

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
    expect(rows[0]?.detail).toContain("Primary checkout now reflects this thread worktree");
  });

  it("collapses a completed promote/demote cycle into two merged operation rows", () => {
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

  it("uses operation metadata for collapse boundaries instead of title text", () => {
    const rows = getOperationRows([
      {
        ...primaryCheckoutOperation(
          1,
          "Primary checkout promotion update",
          "Promoting thread worktree into primary checkout",
        ),
        threadOperation: {
          operation: "primary_checkout",
          status: "started",
          metadata: { action: "promote" },
        },
      },
      {
        ...primaryCheckoutOperation(
          2,
          "Primary checkout promotion update",
          "Primary checkout now reflects this thread worktree",
        ),
        threadOperation: {
          operation: "primary_checkout",
          status: "completed",
          metadata: { action: "promote" },
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Primary checkout promotion update");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
  });

  it("does not collapse operation rows that only share display titles", () => {
    const rows = getOperationRows([
      {
        kind: "operation",
        id: "op-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        opType: "operation",
        title: "Promoting primary checkout",
      },
      {
        kind: "operation",
        id: "op-2",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        opType: "operation",
        title: "Promoted to primary checkout",
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[1]?.sourceSeqStart).toBe(2);
  });
});

describe("buildThreadDetailRows reconnect error collapsing", () => {
  it("collapses consecutive reconnect retry errors into the latest row", () => {
    const rows = buildThreadDetailRows([
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 10,
        sourceSeqEnd: 10,
        createdAt: 10,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
      },
      {
        kind: "error",
        id: "error-2",
        threadId: "thread-1",
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
        createdAt: 11,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 3/5",
      },
      {
        kind: "error",
        id: "error-3",
        threadId: "thread-1",
        sourceSeqStart: 12,
        sourceSeqEnd: 12,
        createdAt: 12,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 4/5",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("error");
    if (rows[0].message.kind !== "error") return;
    expect(rows[0].message.message).toBe("Reconnecting... 4/5");
    expect(rows[0].message.sourceSeqStart).toBe(10);
    expect(rows[0].message.sourceSeqEnd).toBe(12);
    expect(rows[0].message.createdAt).toBe(12);
    expect(rows[0].message.startedAt).toBe(10);
  });

  it("does not collapse reconnect errors across breaks or retry budgets", () => {
    const rows = buildThreadDetailRows([
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 10,
        sourceSeqEnd: 10,
        createdAt: 10,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
        createdAt: 11,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        status: "completed",
      },
      {
        kind: "error",
        id: "error-2",
        threadId: "thread-1",
        sourceSeqStart: 12,
        sourceSeqEnd: 12,
        createdAt: 12,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 3/4",
      },
      {
        kind: "error",
        id: "error-3",
        threadId: "thread-1",
        sourceSeqStart: 13,
        sourceSeqEnd: 13,
        createdAt: 13,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 4/5",
      },
    ]);

    expect(rows).toHaveLength(4);
  });
});

describe("buildThreadDetailRows provisioning operation collapsing", () => {
  it("collapses provisioning start/env setup/completed updates into one operation row", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        { environmentDisplayName: "Worktree" },
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup started",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
          },
        },
      ),
      provisioningOperation(
        3,
        "provisioning-env-setup",
        "Environment setup completed",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "completed",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
            durationMs: 3074,
          },
        },
      ),
      provisioningOperation(
        4,
        "provisioning-completed",
        "Provisioning ready",
        undefined,
        { environmentDisplayName: "Worktree", workspaceRoot: "/tmp/worktree" },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("provisioning");
    expect(rows[0]?.title).toBe("Provisioned environment");
    expect(rows[0]?.provisioning?.transcript?.[0]?.text).toBe("environment: Worktree");
    expect(rows[0]?.provisioning?.workspaceRoot).toBe("/tmp/worktree");
    expect(rows[0]?.provisioning?.setup?.scriptPath).toBe(".bb-env-setup.ts");
    expect(rows[0]?.provisioning?.setup?.timeoutMs).toBe(600000);
    expect(rows[0]?.provisioning?.setup?.durationMs).toBe(3074);
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(4);
    expect(rows[0]?.detail).toBeUndefined();
  });

  it("keeps completed provisioning rows fully structured", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        { environmentDisplayName: "Direct" },
      ),
      provisioningOperation(
        2,
        "provisioning-completed",
        "Provisioning ready",
        undefined,
        { environmentDisplayName: "Direct" },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("provisioning");
    expect(rows[0]?.title).toBe("Provisioned environment");
    expect(rows[0]?.provisioning?.transcript?.[0]?.text).toBe("environment: Direct");
    expect(rows[0]?.detail).toBeUndefined();
  });

  it("keeps a stable merged provisioning id as new lifecycle updates arrive", () => {
    const startedRows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        { environmentDisplayName: "Worktree" },
      ),
    ]);
    const mergedRows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        { environmentDisplayName: "Worktree" },
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup started",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
          },
        },
      ),
      provisioningOperation(
        3,
        "provisioning-env-setup",
        "Environment setup running",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "running",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
            output: "+ pnpm install",
          },
        },
      ),
    ]);

    expect(startedRows[0]?.id).toBe("provisioning-1");
    expect(startedRows[0]?.opType).toBe("provisioning");
    expect(startedRows[0]?.title).toBe("Provisioning environment");
    expect(mergedRows[0]?.id).toBe("provisioning-1");
  });

  it("preserves streamed env-setup output when collapsing provisioning rows", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        { environmentDisplayName: "Worktree" },
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup started",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
          },
        },
      ),
      provisioningOperation(
        3,
        "provisioning-env-setup",
        "Environment setup running",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "running",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
            output: "+ pnpm install",
          },
        },
      ),
      provisioningOperation(
        4,
        "provisioning-env-setup",
        "Environment setup running",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "running",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
            output: "Done in 3.2s",
          },
        },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("provisioning");
    expect(rows[0]?.title).toBe("Provisioning environment");
    expect(rows[0]?.provisioning?.transcript?.[0]?.text).toBe("environment: Worktree");
    expect(rows[0]?.provisioning?.workspaceRoot).toBe("/tmp/worktree");
    expect(rows[0]?.provisioning?.setup?.status).toBe("running");
    expect(rows[0]?.provisioning?.setup?.output).toBe("+ pnpm install\nDone in 3.2s");
    expect(rows[0]?.detail).toBeUndefined();
  });

  it("preserves provisioning phase timing when collapsing provisioning rows", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        { environmentDisplayName: "Direct Workspace" },
      ),
      provisioningOperation(
        2,
        "provisioning-progress",
        "Environment prepared",
        undefined,
        {
          phases: {
            prepare_environment: {
              status: "completed",
              startedAt: 2,
              durationMs: 1200,
            },
          },
        },
      ),
      provisioningOperation(
        3,
        "provisioning-progress",
        "Starting provider session",
        undefined,
        {
          phases: {
            start_provider_session: {
              status: "started",
              startedAt: 3,
            },
          },
        },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("provisioning");
    expect(rows[0]?.title).toBe("Provisioning environment");
    expect(rows[0]?.provisioning?.transcript?.map((entry) => entry.key)).toEqual([
      "environment",
      "phase:start_provider_session",
    ]);
    expect(rows[0]?.provisioning?.transcript?.[1]?.startedAt).toBe(3);
  });

  it("keeps one provisioning row when user interruption lands mid-provisioning", () => {
    const rows = buildThreadDetailRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        { environmentDisplayName: "Direct Workspace" },
      ),
      provisioningOperation(
        2,
        "provisioning-progress",
        "Environment prepared",
        undefined,
        {
          phases: {
            prepare_environment: {
              status: "completed",
              startedAt: 2,
              durationMs: 1200,
            },
          },
        },
      ),
      provisioningOperation(
        3,
        "provisioning-progress",
        "Starting provider session",
        undefined,
        {
          phases: {
            start_provider_session: {
              status: "started",
              startedAt: 3,
            },
          },
        },
      ),
      {
        kind: "operation",
        id: "op-4",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        startedAt: 4,
        opType: "thread-interrupted",
        title: "Stopped by user",
        status: "interrupted",
      },
      {
        kind: "operation",
        id: "provisioning-5",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        opType: "provisioning-progress",
        title: "Provider session start failed",
        status: "error",
        provisioning: {
          transcript: [
            {
              key: "phase:start_provider_session",
              text: "provider session start failed",
              startedAt: 3,
            },
          ],
        },
      },
      {
        kind: "error",
        id: "error-6",
        threadId: "thread-1",
        sourceSeqStart: 6,
        sourceSeqEnd: 6,
        createdAt: 6,
        rawType: "system/error",
        message: "Thread provisioning failed",
      },
    ]).filter((row): row is Extract<ThreadDetailRow, { kind: "message" }> => row.kind === "message");

    expect(rows).toHaveLength(3);
    expect(rows[0]?.message.kind).toBe("operation");
    if (rows[0]?.message.kind === "operation") {
      expect(rows[0].message.opType).toBe("provisioning");
      expect(rows[0].message.title).toBe("Provisioning environment failed");
      expect(rows[0].message.sourceSeqStart).toBe(1);
      expect(rows[0].message.sourceSeqEnd).toBe(5);
    }
    expect(rows[1]?.message.kind).toBe("operation");
    if (rows[1]?.message.kind === "operation") {
      expect(rows[1].message.opType).toBe("thread-interrupted");
      expect(rows[1].message.title).toBe("Stopped by user");
    }
  });

  it("preserves ordered provisioning transcript items when collapsing rows", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-started",
        "Provisioning started",
        undefined,
        {
          environmentDisplayName: "Worktree",
          transcript: [
            { key: "environment", text: "environment: Worktree" },
            { key: "worktree", text: "creating worktree" },
          ],
        },
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup started",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          branchName: "feature/test",
          setup: {
            status: "started",
            startedAt: 2,
            scriptPath: ".bb-env-setup.sh",
          },
          transcript: [
            { key: "branch", text: "checked out branch feature/test (abcdef1)" },
            { key: "setup", text: "running .bb-env-setup.sh", startedAt: 2 },
          ],
        },
      ),
      provisioningOperation(
        3,
        "provisioning-progress",
        "Provider session started",
        undefined,
        {
          phases: {
            start_provider_session: {
              status: "completed",
              startedAt: 3,
              durationMs: 2000,
            },
          },
          transcript: [
            { key: "phase:start_provider_session", text: "started provider session in 2s" },
          ],
        },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("provisioning");
    expect(rows[0]?.provisioning?.transcript?.map((entry) => entry.key)).toEqual([
      "environment",
      "worktree",
      "branch",
      "setup",
      "phase:start_provider_session",
    ]);
    expect(rows[0]?.provisioning?.transcript?.[3]).toMatchObject({
      key: "setup",
      text: "running .bb-env-setup.sh",
      startedAt: 2,
    });
    expect(rows[0]?.provisioning?.transcript?.[4]).toMatchObject({
      key: "phase:start_provider_session",
      text: "started provider session in 2s",
    });
    expect(rows[0]?.provisioning?.transcript?.[2]).toMatchObject({
      key: "branch",
      text: "checked out branch feature/test (abcdef1)",
    });
  });

  it("keeps the earliest transcript startedAt when later updates replace the same key", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-env-setup",
        "Environment setup started",
        undefined,
        {
          setup: {
            status: "started",
            startedAt: 10,
            scriptPath: ".bb-env-setup.sh",
          },
          transcript: [{ key: "setup", text: "running .bb-env-setup.sh", startedAt: 10 }],
        },
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup running",
        undefined,
        {
          setup: {
            status: "running",
            startedAt: 25,
            scriptPath: ".bb-env-setup.sh",
            output: "+ pnpm install",
          },
          transcript: [{ key: "setup", text: "running .bb-env-setup.sh", startedAt: 25 }],
        },
      ),
      provisioningOperation(
        3,
        "provisioning-progress",
        "Starting provider session",
        undefined,
        {
          phases: {
            start_provider_session: {
              status: "started",
              startedAt: 30,
            },
          },
          transcript: [{ key: "phase:start_provider_session", text: "starting provider session", startedAt: 30 }],
        },
      ),
      provisioningOperation(
        4,
        "provisioning-progress",
        "Starting provider session",
        undefined,
        {
          phases: {
            start_provider_session: {
              status: "started",
              startedAt: 45,
            },
          },
          transcript: [{ key: "phase:start_provider_session", text: "starting provider session", startedAt: 45 }],
        },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.provisioning?.transcript).toEqual([
      { key: "setup", text: "running .bb-env-setup.sh", startedAt: 10 },
      { key: "phase:start_provider_session", text: "starting provider session", startedAt: 30 },
    ]);
  });

  it("clears transcript startedAt when a replacement entry changes text and omits it", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-env-setup",
        "Environment setup started",
        undefined,
        {
          setup: {
            status: "started",
            startedAt: 10,
            scriptPath: ".bb-env-setup.sh",
          },
          transcript: [{ key: "setup", text: "running .bb-env-setup.sh", startedAt: 10 }],
        },
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup completed",
        undefined,
        {
          setup: {
            status: "completed",
            durationMs: 5_000,
            scriptPath: ".bb-env-setup.sh",
          },
          transcript: [{ key: "setup", text: "ran .bb-env-setup.sh in 5s" }],
        },
      ),
    ]);

    expect(rows[0]?.provisioning?.transcript).toEqual([
      { key: "setup", text: "ran .bb-env-setup.sh in 5s" },
    ]);
  });

  it("collapses env-setup-only updates without looking stuck in provisioning", () => {
    const rows = getOperationRows([
      provisioningOperation(
        1,
        "provisioning-env-setup",
        "Environment setup started",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
          },
        },
      ),
      provisioningOperation(
        2,
        "provisioning-env-setup",
        "Environment setup completed",
        undefined,
        {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "completed",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
            durationMs: 3074,
          },
        },
      ),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("provisioning");
    expect(rows[0]?.title).toBe("Environment setup completed");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
    expect(rows[0]?.provisioning?.workspaceRoot).toBe("/tmp/worktree");
    expect(rows[0]?.provisioning?.setup?.scriptPath).toBe(".bb-env-setup.ts");
    expect(rows[0]?.provisioning?.setup?.durationMs).toBe(3074);
    expect(rows[0]?.detail).toBeUndefined();
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
    expect(rows[0]?.opType).toBe("operation");
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
    expect(rows[0]?.opType).toBe("operation");
    expect(rows[0]?.title).toBe("Commit completed");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
    expect(rows[0]?.detail).toContain("Committed changes");
  });

  it("does not collapse thread-operation lifecycle rows that only share display titles", () => {
    const rows = getOperationRows([
      {
        kind: "operation",
        id: "thread-operation-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        opType: "operation",
        title: "Committing changes",
      },
      {
        kind: "operation",
        id: "thread-operation-2",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        opType: "operation",
        title: "Commit completed",
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[1]?.sourceSeqStart).toBe(2);
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
    expect(rows[0]?.opType).toBe("operation");
    expect(rows[0]?.title).toBe("Commit completed");
    expect(rows[0]?.detail).toContain("op-1");
    expect(rows[1]?.opType).toBe("worktree-commit");
    expect(rows[1]?.detail).toContain("op-2");
  });
});
