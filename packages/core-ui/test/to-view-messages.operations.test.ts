import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import {
  toViewMessages,
  toViewProjection,
} from "../src/to-view-messages.js";
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
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
        },
        createdAt: 2,
      },
    ];

    const rows = buildTimelineRows(
      toViewProjection(fromRows(events), {
        threadStatus: "provisioning",
        turnMessageDetail: "full",
      }),
      { includeToolGroupMessages: false },
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
        type: "warning",
        data: {
          providerThreadId: "thread-1",
          category: "deprecation",
          summary: "Legacy API will be removed",
          details: "Use v2 APIs instead",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "warning",
        data: {
          providerThreadId: "thread-1",
          category: "config",
          summary: "Unknown config key",
          details: "Remove 'legacyFlag'",
        },
        createdAt: 2,
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
        type: "warning",
        data: {
          providerThreadId: "thread-1",
          category: "general",
          summary: "Rate limit status updated",
          details: "status: allowed • limit: five_hour",
        },
        createdAt: 1,
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
      },
    ];

    const projected = toViewMessages(fromRows(events), { threadStatus: "active" });
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


  it("projects legacy compaction events as operations", () => {
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
    const projected = toViewMessages(fromRows([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread/interrupted",
        data: {
          reason: "user",
        },
        createdAt: 1,
      },
    ]));
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
    const projected = toViewMessages(fromRows([
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
      },
    ]));
    const op = projected.find(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("provider-unhandled");
    expect(op?.title).toBe("Unhandled Codex event");
    expect(op?.detail).toContain("Raw event: item/tool/requestUserInput");
    expect(op?.detail).toContain("\"message\": \"Tool is waiting for input\"");
    expect(op?.detail).toContain("\"tool\": \"prompt_user\"");
  });


  it("projects provisioning events as operations", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/thread-provisioning",
        data: {
          status: "completed",
          environmentId: "env-1",
          entries: [{ type: "step", key: "setup", text: ".bb-env-setup.sh finished", status: "completed" }],
        },
        createdAt: 3,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(3);
    expect(ops[0]?.opType).toBe("thread-provisioning");
    expect(ops[0]?.title).toBe("Provisioning thread");
    expect(ops[1]?.opType).toBe("thread-provisioning");
    expect(ops[1]?.title).toBe("Provisioning thread");
    expect(ops[2]?.opType).toBe("thread-provisioning");
    expect(ops[2]?.title).toBe("Provisioned thread");
  });


  it("projects active provisioning events as pending operations", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "session", text: "Starting agent session", status: "started" }],
        },
        createdAt: 1,
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
          status: "active",
          environmentId: "env-1",
          entries: [
            { type: "step", key: "branch", text: "Using branch: bb/thread-123 (abcdef1)", status: "completed" },
            { type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" },
          ],
        },
        createdAt: 1,
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
      { type: "step", key: "branch", text: "Using branch: bb/thread-123 (abcdef1)", status: "completed" },
      { type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" },
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
          status: "completed",
          message: "Thread assigned to manager",
          metadata: {
            action: "assign",
            previousParentThreadId: null,
            nextParentThreadId: "manager-1",
          },
        },
        createdAt: 1,
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
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Check the docker environment" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Provisioning thread", status: "started" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/thread-provisioning",
        data: {
          status: "completed",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Provisioning thread", status: "started" }],
        },
        createdAt: 3,
      },
    ];

    const rows = buildTimelineRows(
      toViewProjection(fromRows(events), {
        threadStatus: "idle",
        turnMessageDetail: "full",
      }),
      { includeToolGroupMessages: false },
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
});
