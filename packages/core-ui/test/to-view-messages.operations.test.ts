import { describe, expect, it } from "vitest";
import type { ThreadEventRow, ViewMessage } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import { getViewMessageScopeTurnId } from "../src/message-scope.js";
import { toViewMessages, toViewProjection } from "../src/to-view-messages.js";
import { buildTimelineRows } from "../src/thread-detail-rows.js";
import { fromRows } from "./timeline-test-harness.js";

describe("toViewMessages operations", () => {
  it("keeps provisioning operations pending while thread provisioning is still in progress", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "provision",
              text: "Creating worktree",
              status: "started",
            },
          ],
        },
        createdAt: 1,
        scope: threadScope(),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "setup",
              text: "Running .bb-env-setup.sh",
              status: "started",
            },
          ],
        },
        createdAt: 2,
        scope: threadScope(),
      },
    ];

    const rows = buildTimelineRows(
      toViewProjection(fromRows(events), {
        threadStatus: "provisioning",
        turnMessageDetail: "full",
      }),
      { includeNestedRows: false },
    );
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]?.message.kind).toBe("operation");
    if (messageRows[0]?.message.kind !== "operation") {
      return;
    }

    expect(messageRows[0].message.opType).toBe("thread-provisioning");
    expect(messageRows[0].message.status).toBe("pending");
    expect(messageRows[0].message.title).toBe("Provisioning thread");
  });

  it("projects turn plan updates as tasks rows", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/plan/updated",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: "Plan is now clearer",
          plan: [
            { step: "Inspect project", status: "completed" },
            { step: "Apply fix", status: "active" },
          ],
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const tasks = projected.find(
      (message): message is Extract<ViewMessage, { kind: "tasks" }> =>
        message.kind === "tasks",
    );

    expect(tasks).toBeDefined();
    expect(tasks).toMatchObject({
      source: "plan",
      title: "Tasks updated",
      status: "completed",
    });
    expect(tasks?.tasks).toEqual([
      { text: "Inspect project", status: "completed" },
      { text: "Apply fix", status: "active" },
    ]);
  });

  it("projects deprecation and config warnings as operations", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "provider/warning",
        data: {
          providerThreadId: "thread-1",
          category: "deprecation",
          summary: "Legacy API will be removed",
          details: "Use v2 APIs instead",
        },
        createdAt: 1,
        scope: threadScope(),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "provider/warning",
        data: {
          providerThreadId: "thread-1",
          category: "config",
          summary: "Unknown config key",
          details: "Remove 'legacyFlag'",
        },
        createdAt: 2,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops.some((message) => message.opType === "deprecation")).toBe(true);
    expect(ops.some((message) => message.opType === "warning")).toBe(true);
  });

  it("uses general warning summaries as operation titles", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "provider/warning",
        data: {
          providerThreadId: "thread-1",
          category: "general",
          summary: "Rate limit status updated",
          details: "status: allowed • limit: five_hour",
        },
        createdAt: 1,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.title).toBe("Rate limit status updated");
    expect(op?.detail).toBe("status: allowed • limit: five_hour");
  });

  it("hides provider thread name updates from the timeline", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "thread/name/updated",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          threadName: "Compaction summary title",
        },
        createdAt: 1,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(0);
  });

  it("hides repeated provider thread name updates from the timeline", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "thread/name/updated",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          threadName: "Server-assigned title",
        },
        createdAt: 1,
        scope: threadScope(),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "thread/name/updated",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          threadName: "Server-assigned title",
        },
        createdAt: 2,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(0);
  });

  it("keeps in-progress compaction items pending for active threads", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("compaction");
    expect(op?.title).toBe("Context compacting...");
    expect(op?.status).toBe("pending");
  });

  it("coalesces compaction lifecycle events into a single completed operation", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "thread/compacted",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events));
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("compaction");
    expect(ops[0]?.title).toBe("Context compacted");
    expect(ops[0]?.sourceSeqStart).toBe(1);
    expect(ops[0]?.sourceSeqEnd).toBe(2);
  });

  it("coalesces compaction start and compacted events by turn id", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "thread/compacted",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];
    const projected = toViewMessages(fromRows(events));
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("compaction");
    expect(ops[0]?.title).toBe("Context compacted");
    expect(ops[0]?.status).toBe("completed");
    expect(ops[0] ? getViewMessageScopeTurnId(ops[0]) : null).toBe("turn-1");
    expect(ops[0]?.sourceSeqStart).toBe(1);
    expect(ops[0]?.sourceSeqEnd).toBe(2);
  });

  it("closes failed compactions before active follow-up renders", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-failed",
          item: {
            id: "compact-failed",
            type: "contextCompaction",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-failed"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "provider/error",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-failed",
          message: "Provider error",
          detail: "Remote compaction failed",
        },
        createdAt: 2,
        scope: turnScope("turn-failed"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-failed",
          status: "failed",
          error: {
            message: "Remote compaction failed",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-failed"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-success",
          item: {
            id: "compact-success",
            type: "contextCompaction",
          },
        },
        createdAt: 4,
        scope: turnScope("turn-success"),
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-success",
          item: {
            id: "compact-success",
            type: "contextCompaction",
          },
        },
        createdAt: 5,
        scope: turnScope("turn-success"),
      },
      {
        id: "evt-6",
        threadId: "thread-1",
        seq: 6,
        type: "thread/compacted",
        data: {
          providerThreadId: "provider-thread-1",
          threadId: "thread-1",
          turnId: "turn-success",
        },
        createdAt: 6,
        scope: turnScope("turn-success"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(2);
    expect(ops[0]?.title).toBe("Context compaction failed");
    expect(ops[0]?.status).toBe("error");
    expect(ops[0]?.detail).toContain("Remote compaction failed");
    expect(ops[1]?.title).toBe("Context compacted");
    expect(ops[1]?.status).toBe("completed");
    expect(ops[1]?.sourceSeqStart).toBe(4);
    expect(ops[1]?.sourceSeqEnd).toBe(5);
  });

  it("interrupts open compactions when their turn is interrupted", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-interrupted",
          item: {
            id: "compact-interrupted",
            type: "contextCompaction",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-interrupted"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-interrupted",
          status: "interrupted",
          error: {
            message: "User interrupted",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-interrupted"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.title).toBe("Context compaction interrupted");
    expect(op?.status).toBe("interrupted");
    expect(op?.detail).toBe("User interrupted");
    expect(op?.sourceSeqStart).toBe(1);
    expect(op?.sourceSeqEnd).toBe(2);
  });

  it("projects compacted events with turn ids as operations", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "thread/compacted",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("compaction");
    expect(op?.title).toBe("Context compacted");
  });

  it("projects thread interruption events as interrupted operations", () => {
    const projected = toViewMessages(
      fromRows([
        {
          id: "evt-1",
          threadId: "thread-1",
          seq: 1,
          type: "system/thread/interrupted",
          data: {
            reason: "user",
          },
          createdAt: 1,
          scope: threadScope(),
        },
      ]),
    );
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("thread-interrupted");
    expect(op?.title).toBe("Stopped by user");
    expect(op?.status).toBe("interrupted");
  });

  it("projects provider/unhandled events as readable operations", () => {
    const projected = toViewMessages(
      fromRows([
        {
          id: "evt-1",
          threadId: "thread-1",
          seq: 1,
          type: "provider/unhandled",
          data: {
            providerThreadId: "provider-thread-1",
            providerId: "codex",
            rawType: "item/tool/requestUserInput",
            rawEvent: {
              jsonrpc: "2.0",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                message: "Tool is waiting for input",
                tool: "prompt_user",
              },
            },
            turnId: "turn-1",
          },
          createdAt: 1,
          scope: turnScope("turn-1"),
        },
      ]),
    );
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("provider-unhandled");
    expect(op?.title).toBe("Unhandled Codex event");
    expect(op?.detail).toContain("Raw event: item/tool/requestUserInput");
    expect(op?.detail).toContain('"message": "Tool is waiting for input"');
    expect(op?.detail).toContain('"tool": "prompt_user"');
  });

  it("projects provisioning events as operations", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "provision",
              text: "Creating worktree",
              status: "started",
            },
          ],
        },
        createdAt: 1,
        scope: threadScope(),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "setup",
              text: "Running .bb-env-setup.sh",
              status: "started",
            },
          ],
        },
        createdAt: 2,
        scope: threadScope(),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "completed",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "setup",
              text: ".bb-env-setup.sh finished",
              status: "completed",
            },
          ],
        },
        createdAt: 3,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("thread-provisioning");
    expect(ops[0]?.title).toBe("Provisioned thread");
    expect(ops[0]?.status).toBe("completed");
    expect(ops[0]?.provisioning?.transcript?.map((entry) => entry.key)).toEqual(
      ["provision", "setup", "setup"],
    );
  });

  it("keeps completed provisioning completed when the thread later errors", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "provision",
              text: "Waiting for workspace",
              status: "started",
            },
          ],
        },
        createdAt: 1,
        scope: threadScope(),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "completed",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "branch",
              text: "Using branch: main",
              status: "completed",
            },
          ],
        },
        createdAt: 2,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "error",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("thread-provisioning");
    expect(ops[0]?.status).toBe("completed");
    expect(ops[0]?.title).toBe("Provisioned thread");
  });

  it("does not let stale failed provisioning updates replace a completed lifecycle", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "completed",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "branch",
              text: "Using branch: main",
              status: "completed",
            },
          ],
        },
        createdAt: 1,
        scope: threadScope(),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "failed",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "setup",
              text: "Workspace setup failed",
              status: "failed",
            },
          ],
        },
        createdAt: 2,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "error",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("thread-provisioning");
    expect(ops[0]?.status).toBe("completed");
    expect(ops[0]?.title).toBe("Provisioned thread");
    expect(ops[0]?.sourceSeqStart).toBe(1);
    expect(ops[0]?.sourceSeqEnd).toBe(2);
  });

  it("projects active provisioning events as pending operations", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "workspace",
              text: "Preparing workspace",
              status: "started",
            },
          ],
        },
        createdAt: 1,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "provisioning",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("thread-provisioning");
    expect(ops[0]?.title).toBe("Provisioning thread");
    expect(ops[0]?.status).toBe("pending");
  });

  it("captures provisioning transcript entries from the new single event type", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "branch",
              text: "Using branch: bb/thread-123 (abcdef1)",
              status: "completed",
            },
            {
              type: "step",
              key: "setup",
              text: "Running .bb-env-setup.sh",
              status: "started",
            },
          ],
        },
        createdAt: 1,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "provisioning",
    });
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op?.opType).toBe("thread-provisioning");
    expect(op?.provisioning?.transcript).toEqual([
      {
        type: "step",
        key: "branch",
        text: "Using branch: bb/thread-123 (abcdef1)",
        status: "completed",
      },
      {
        type: "step",
        key: "setup",
        text: "Running .bb-env-setup.sh",
        status: "started",
      },
    ]);
  });

  it("projects ownership change operations", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/operation",
        data: {
          operation: "ownership_change",
          operationId: "op-ownership-1",
          status: "completed",
          message: "Thread assigned to manager",
          metadata: {
            action: "assign",
            previousParentThreadId: null,
            nextParentThreadId: "manager-1",
          },
        },
        createdAt: 1,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op?.opType).toBe("operation");
    expect(op?.title).toBe("Thread assigned to manager");
    expect(op?.threadOperation).toEqual({
      operation: "ownership_change",
      rawOperation: "ownership_change",
      operationId: "op-ownership-1",
      status: "completed",
      rawStatus: "completed",
      metadata: {
        action: "assign",
        previousParentThreadId: null,
        nextParentThreadId: "manager-1",
      },
    });
  });

  it("projects docker provisioning rows from structured events without string details", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Check the docker environment" }],
          target: { kind: "thread-start" },
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
        createdAt: 1,
        scope: threadScope(),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "provision",
              text: "Provisioning thread",
              status: "started",
            },
          ],
        },
        createdAt: 2,
        scope: threadScope(),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/thread-provisioning",
        data: {
          provisioningId: "tpv-1",
          status: "completed",
          environmentId: "env-1",
          entries: [
            {
              type: "step",
              key: "provision",
              text: "Provisioning thread",
              status: "started",
            },
          ],
        },
        createdAt: 3,
        scope: threadScope(),
      },
    ];

    const rows = buildTimelineRows(
      toViewProjection(fromRows(events), {
        threadStatus: "idle",
        turnMessageDetail: "full",
      }),
      { includeNestedRows: false },
    );
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(2);
    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind !== "operation") {
      return;
    }

    expect(messageRows[1].message.opType).toBe("thread-provisioning");
    expect(messageRows[1].message.title).toBe("Provisioned thread");
    expect(messageRows[1].message.provisioning?.transcript?.[0]?.text).toBe(
      "Provisioning thread",
    );
    expect(messageRows[1].message.detail).toBeUndefined();
  });

  it("formats system error messages with detail", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/error",
        data: {
          code: "project_root_missing",
          message: "Project folder not found: /Users/michael/Projects/bb",
          detail:
            "This project points to a folder that no longer exists. Update the project path and retry.",
        },
        createdAt: 1,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "error",
    });
    const error = projected.find(
      (message): message is Extract<ViewMessage, { kind: "error" }> =>
        message.kind === "error",
    );

    expect(error).toBeDefined();
    expect(error?.message).toContain("Project folder not found");
    expect(error?.message).toContain("Update the project path and retry");
  });

  it("projects reconnect metadata from system error events", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/error",
        data: {
          code: "provider_reconnect",
          message: "Reconnecting... 2/5",
          reconnectAttempt: 2,
          reconnectTotal: 5,
        },
        createdAt: 1,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const error = projected.find(
      (message): message is Extract<ViewMessage, { kind: "error" }> =>
        message.kind === "error",
    );

    expect(error).toBeDefined();
    expect(error?.reconnectAttempt).toBe(2);
    expect(error?.reconnectTotal).toBe(5);
  });
});
