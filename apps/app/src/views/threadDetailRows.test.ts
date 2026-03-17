import { describe, expect, it } from "vitest";
import type { UIMessage } from "@bb/core";
import { buildThreadDetailRows } from "./threadDetailRows";

function baseMessage(
  id: string,
  sourceSeq: number,
): Pick<UIMessage, "id" | "threadId" | "sourceSeqStart" | "sourceSeqEnd" | "createdAt"> {
  return {
    id,
    threadId: "thread-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
  };
}

describe("buildThreadDetailRows", () => {
  it("collapses tool activity before the final assistant message in a turn", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "do work",
      },
      {
        ...baseMessage("exploring-1", 2),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("exploring-2", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-2",
            command: "rg TODO src",
            parsedCmd: [
              {
                type: "search",
                cmd: "rg TODO src",
                query: "TODO",
                path: "src",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("assistant-1", 4),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "done",
        status: "completed",
      },
      {
        ...baseMessage("tool-2", 5),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-2",
        command: "pwd",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "tool-group",
      "message",
      "message",
    ]);

    const group = rows.find((row) => row.kind === "tool-group");
    expect(group).toBeDefined();
    if (!group || group.kind !== "tool-group") return;
    expect(group.summaryCount).toBe(2);
    expect(group.messages).toHaveLength(1);
    expect(group.messages[0]?.kind).toBe("tool-exploring");
    if (group.messages[0]?.kind !== "tool-exploring") return;
    expect(group.messages[0].calls).toHaveLength(2);

    const renderedMessageIds = rows
      .filter((row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message")
      .map((row) => row.message.id);
    expect(renderedMessageIds).toEqual(["user-1", "assistant-1", "tool-2"]);
  });

  it("does not collapse rows when a turn has no assistant message", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "do work",
      },
      {
        ...baseMessage("search-1", 2),
        kind: "web-search",
        turnId: "turn-1",
        callId: "web-1",
        status: "pending",
      },
      {
        ...baseMessage("exploring-1", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "pending",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "pending",
          },
        ],
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "message"]);
  });

  it("collapses each turn independently", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("exploring-1", 1),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("assistant-1", 2),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "turn 1",
        status: "completed",
      },
      {
        ...baseMessage("search-2", 3),
        kind: "web-search",
        turnId: "turn-2",
        callId: "web-2",
        query: "vite cache",
        status: "completed",
      },
      {
        ...baseMessage("assistant-2", 4),
        kind: "assistant-text",
        turnId: "turn-2",
        text: "turn 2",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    const groupedRows = rows.filter((row) => row.kind === "tool-group");
    expect(groupedRows).toHaveLength(2);
    expect(groupedRows.map((row) => row.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  it("does not merge exploring messages across non-exploring entries", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("exploring-1", 1),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("file-1", 2),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-1",
        changes: [{ path: "/repo/a.ts" }],
        status: "completed",
      },
      {
        ...baseMessage("exploring-2", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-2",
            command: "cat package.json",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat package.json",
                name: "package.json",
                path: "/repo/package.json",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("assistant-1", 4),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "done",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    const group = rows.find((row) => row.kind === "tool-group");
    expect(group).toBeDefined();
    if (!group || group.kind !== "tool-group") return;

    expect(group.summaryCount).toBe(3);
    expect(group.messages.map((message) => message.kind)).toEqual([
      "tool-exploring",
      "file-edit",
      "tool-exploring",
    ]);
  });

  it("merges consecutive exploring rows even when they are not in a tool-group", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("assistant-1", 1),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "I will inspect the repo",
        status: "completed",
      },
      {
        ...baseMessage("exploring-1", 2),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("exploring-2", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-2",
            command: "rg TODO src",
            parsedCmd: [
              {
                type: "search",
                cmd: "rg TODO src",
                query: "TODO",
                path: "src",
              },
            ],
            status: "completed",
          },
        ],
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("message");
    expect(rows[1]?.kind).toBe("message");
    if (rows[1]?.kind !== "message") return;
    expect(rows[1].message.kind).toBe("tool-exploring");
    if (rows[1].message.kind !== "tool-exploring") return;
    expect(rows[1].message.calls).toHaveLength(2);
  });

  it("merges consecutive file-edit rows and preserves inline diff entries", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("assistant-1", 1),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "Applying changes",
        status: "completed",
      },
      {
        ...baseMessage("file-1", 2),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-1",
        status: "completed",
        changes: [
          {
            path: "/repo/src/new-file.ts",
            kind: "add",
            diff: "@@ -0,0 +1 @@\n+export const created = true;",
          },
        ],
      },
      {
        ...baseMessage("file-2", 3),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-2",
        status: "completed",
        changes: [
          {
            path: "/repo/src/old-file.ts",
            kind: "delete",
            diff: "@@ -1 +0,0 @@\n-export const removed = true;",
          },
        ],
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("message");
    expect(rows[1]?.kind).toBe("message");
    if (rows[1]?.kind !== "message") return;
    expect(rows[1].message.kind).toBe("file-edit");
    if (rows[1].message.kind !== "file-edit") return;
    expect(rows[1].message.changes).toHaveLength(2);
    expect(rows[1].message.changes.map((change) => change.path)).toEqual([
      "/repo/src/new-file.ts",
      "/repo/src/old-file.ts",
    ]);
  });

  it("merges consecutive file-edit rows inside tool groups", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "apply the patch",
      },
      {
        ...baseMessage("file-1", 2),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-1",
        status: "completed",
        changes: [
          {
            path: "/repo/src/new-file.ts",
            kind: "add",
            diff: "@@ -0,0 +1 @@\n+export const created = true;",
          },
        ],
      },
      {
        ...baseMessage("file-2", 3),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-2",
        status: "completed",
        changes: [
          {
            path: "/repo/src/old-file.ts",
            kind: "delete",
            diff: "@@ -1 +0,0 @@\n-export const removed = true;",
          },
        ],
      },
      {
        ...baseMessage("assistant-1", 4),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "done",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows.map((row) => row.kind)).toEqual(["message", "tool-group", "message"]);

    const group = rows.find((row) => row.kind === "tool-group");
    expect(group).toBeDefined();
    if (!group || group.kind !== "tool-group") return;
    expect(group.summaryCount).toBe(2);
    expect(group.messages).toHaveLength(1);
    expect(group.messages[0]?.kind).toBe("file-edit");
    if (group.messages[0]?.kind !== "file-edit") return;
    expect(group.messages[0].changes).toHaveLength(2);
  });

  it("splits tool groups around assistant messages within the same turn", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("tool-1", 1),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "shell",
        callId: "call-1",
        command: "pnpm test",
        status: "completed",
      },
      {
        ...baseMessage("assistant-1", 2),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "I’m delegating a verification run now.",
        status: "completed",
      },
      {
        ...baseMessage("tool-2", 3),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "shell",
        callId: "call-2",
        command: "pnpm exec vitest",
        status: "completed",
      },
      {
        ...baseMessage("assistant-2", 4),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "The verification is done.",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);

    expect(rows.map((row) => row.kind)).toEqual([
      "tool-group",
      "message",
      "tool-group",
      "message",
    ]);
  });

  it("merges consecutive provisioning operations into a single row", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("provisioning-started-1", 1),
        kind: "operation",
        opType: "provisioning-started",
        title: "Provisioning started",
        provisioning: {
          transcript: [{ key: "environment", text: "environment: Direct" }],
        },
      },
      {
        ...baseMessage("provisioning-env-setup-1", 2),
        kind: "operation",
        opType: "provisioning-env-setup",
        title: "Environment setup started",
        provisioning: {
          workspaceRoot: "/Users/michael/Projects/bb",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
          },
        },
      },
      {
        ...baseMessage("provisioning-env-setup-2", 3),
        kind: "operation",
        opType: "provisioning-env-setup",
        title: "Environment setup completed",
        provisioning: {
          workspaceRoot: "/Users/michael/Projects/bb",
          setup: {
            status: "completed",
            scriptPath: ".bb-env-setup.ts",
            timeoutMs: 600000,
            durationMs: 3074,
          },
        },
      },
      {
        ...baseMessage("provisioning-completed-1", 4),
        kind: "operation",
        opType: "provisioning-completed",
        title: "Provisioning ready",
        provisioning: {
          workspaceRoot: "/Users/michael/Projects/bb",
          transcript: [{ key: "environment", text: "environment: Direct" }],
        },
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("operation");
    if (rows[0].message.kind !== "operation") return;
    expect(rows[0].message.opType).toBe("provisioning");
    expect(rows[0].message.title).toBe("Provisioned environment");
    expect(rows[0].message.provisioning?.workspaceRoot).toBe("/Users/michael/Projects/bb");
    expect(rows[0].message.provisioning?.transcript?.[0]?.text).toBe("environment: Direct");
    expect(rows[0].message.provisioning?.setup?.scriptPath).toBe(".bb-env-setup.ts");
    expect(rows[0].message.provisioning?.setup?.durationMs).toBe(3074);
    expect(rows[0].message.detail).toBeUndefined();
  });

  it("merges consecutive reconnect retry errors into a single row", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("error-1", 1),
        kind: "error",
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
      },
      {
        ...baseMessage("error-2", 2),
        kind: "error",
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 3/5",
      },
      {
        ...baseMessage("error-3", 3),
        kind: "error",
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 4/5",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("error");
    if (rows[0].message.kind !== "error") return;
    expect(rows[0].message.message).toBe("Reconnecting... 4/5");
    expect(rows[0].message.sourceSeqStart).toBe(1);
    expect(rows[0].message.sourceSeqEnd).toBe(3);
  });

  it("keeps streamed provisioning output on the merged provisioning row", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("provisioning-started-1", 1),
        kind: "operation",
        opType: "provisioning-started",
        title: "Provisioning started",
        provisioning: {
          transcript: [{ key: "environment", text: "environment: Direct" }],
        },
      },
      {
        ...baseMessage("provisioning-env-setup-1", 2),
        kind: "operation",
        opType: "provisioning-env-setup",
        title: "Environment setup started",
        provisioning: {
          workspaceRoot: "/Users/michael/Projects/bb",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
          },
        },
      },
      {
        ...baseMessage("provisioning-env-setup-2", 3),
        kind: "operation",
        opType: "provisioning-env-setup",
        title: "Environment setup running",
        provisioning: {
          workspaceRoot: "/Users/michael/Projects/bb",
          setup: {
            status: "running",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
            output: "+ pnpm install",
          },
        },
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("operation");
    if (rows[0].message.kind !== "operation") return;
    expect(rows[0].message.opType).toBe("provisioning");
    expect(rows[0].message.provisioning?.setup?.status).toBe("running");
    expect(rows[0].message.provisioning?.setup?.output).toBe("+ pnpm install");
  });

  it("merges squash operation intent request/prompt/lifecycle into one row", () => {
    const promptText =
      "Please squash-merge the changes in this thread workspace.\n" +
      "Please use the default merge-base branch reported by git.";
    const messages: UIMessage[] = [
      {
        ...baseMessage("squash-requested-1", 1),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Squash merge requested",
        detail: "Squash-merge operation requested",
        threadOperation: {
          action: "squash_merge",
          phase: "requested",
        },
      },
      {
        ...baseMessage("squash-prompt-1", 2),
        kind: "user",
        text: promptText,
      },
      {
        ...baseMessage("squash-queued-1", 3),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Squash merge queued",
        detail: "Squash-merge operation queued for deterministic execution",
        threadOperation: {
          action: "squash_merge",
          phase: "queued",
        },
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("operation");
    if (rows[0].message.kind !== "operation") return;
    expect(rows[0].message.opType).toBe("thread-operation-intent");
    expect(rows[0].message.title).toBe("Squash merge queued");
    expect(rows[0].message.detail).toContain("Squash-merge operation queued for deterministic execution");
    expect(rows[0].message.detail).toContain("Prompt:");
    expect(rows[0].message.detail).toContain(promptText);
  });

  it("prefers a single canonical squash merge row when lifecycle and worktree outcomes overlap", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("squash-requested-1", 1),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Squash merge requested",
        detail: "Squash-merge operation requested",
        threadOperation: {
          action: "squash_merge",
          phase: "requested",
        },
      },
      {
        ...baseMessage("squash-running-1", 2),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Squash merging changes",
        detail: "Running squash-merge operation",
        threadOperation: {
          action: "squash_merge",
          phase: "running",
        },
      },
      {
        ...baseMessage("squash-worktree-1", 3),
        kind: "operation",
        opType: "worktree-squash-merge",
        title: "Squash merged",
        detail: "Squash merged into main",
      },
      {
        ...baseMessage("squash-completed-1", 4),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Squash merge completed",
        detail: "Squash merged into main",
        threadOperation: {
          action: "squash_merge",
          phase: "completed",
        },
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("operation");
    if (rows[0].message.kind !== "operation") return;
    expect(rows[0].message.opType).toBe("worktree-squash-merge");
    expect(rows[0].message.title).toBe("Squash merged");
    expect(rows[0].message.detail).toContain("Squash merged into main");
  });

  it("prefers a single canonical commit row when lifecycle and worktree outcomes overlap", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("commit-running-1", 1),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Committing changes",
        detail: "Running commit operation",
        threadOperation: {
          action: "commit",
          phase: "running",
        },
      },
      {
        ...baseMessage("commit-worktree-1", 2),
        kind: "operation",
        opType: "worktree-commit",
        title: "Committed changes",
        detail: "Committed changes",
      },
      {
        ...baseMessage("commit-completed-1", 3),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Commit completed",
        detail: "Committed changes",
        threadOperation: {
          action: "commit",
          phase: "completed",
        },
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("operation");
    if (rows[0].message.kind !== "operation") return;
    expect(rows[0].message.opType).toBe("worktree-commit");
    expect(rows[0].message.title).toBe("Committed changes");
    expect(rows[0].message.detail).toContain("Committed changes");
  });

  it("collapses in-flight commit lifecycle updates when no worktree outcome exists yet", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("commit-running-1", 1),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Committing changes",
        detail: "Running commit operation",
        threadOperation: {
          action: "commit",
          phase: "running",
        },
      },
      {
        ...baseMessage("commit-completed-1", 2),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Commit completed",
        detail: "Committed changes",
        threadOperation: {
          action: "commit",
          phase: "completed",
        },
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("operation");
    if (rows[0].message.kind !== "operation") return;
    expect(rows[0].message.opType).toBe("thread-operation-intent");
    expect(rows[0].message.title).toBe("Commit completed");
    expect(rows[0].message.sourceSeqStart).toBe(1);
    expect(rows[0].message.sourceSeqEnd).toBe(2);
    expect(rows[0].message.detail).toContain("Committed changes");
  });

  it("does not merge commit lifecycle updates across different operation ids", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("commit-running-1", 1),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Committing changes",
        detail: "Running commit operation for first request",
        threadOperation: {
          action: "commit",
          phase: "running",
          operationId: "op-1",
        },
      },
      {
        ...baseMessage("commit-completed-2", 2),
        kind: "operation",
        opType: "thread-operation-intent",
        title: "Commit completed",
        detail: "Committed changes for second request",
        threadOperation: {
          action: "commit",
          phase: "completed",
          operationId: "op-2",
        },
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("message");
    if (rows[0]?.kind !== "message") return;
    expect(rows[0].message.kind).toBe("operation");
    if (rows[0].message.kind !== "operation") return;
    expect(rows[0].message.title).toBe("Committing changes");

    expect(rows[1]?.kind).toBe("message");
    if (rows[1]?.kind !== "message") return;
    expect(rows[1].message.kind).toBe("operation");
    if (rows[1].message.kind !== "operation") return;
    expect(rows[1].message.title).toBe("Commit completed");
  });

  it("keeps compaction and thread title updates visible outside tool groups", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "continue",
      },
      {
        ...baseMessage("exploring-1", 2),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "rg compact",
            parsedCmd: [],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("compact-1", 3),
        kind: "operation",
        turnId: "turn-1",
        opType: "compaction",
        title: "Context compacted",
        detail: "Compacted",
      },
      {
        ...baseMessage("rename-1", 4),
        kind: "operation",
        turnId: "turn-1",
        opType: "thread-title-updated",
        title: "Title updated",
        detail: "Old → New",
      },
      {
        ...baseMessage("assistant-1", 5),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "done",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "tool-group",
      "message",
      "message",
      "message",
    ]);

    const renderedMessageIds = rows
      .filter((row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message")
      .map((row) => row.message.id);
    expect(renderedMessageIds).toEqual([
      "user-1",
      "compact-1",
      "rename-1",
      "assistant-1",
    ]);
  });
});
