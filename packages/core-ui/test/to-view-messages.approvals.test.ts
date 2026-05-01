import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import { turnScope } from "@bb/domain";
import { toViewMessages } from "../src/to-view-messages.js";
import { fromRows } from "./timeline-test-harness.js";

describe("toViewMessages approval projection", () => {
  it("projects permission approval lifecycle events without operation metadata", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-approval",
        threadId: "thread-1",
        seq: 1,
        type: "system/permissionGrant/lifecycle",
        data: {
          interactionId: "pi_123",
          providerId: "codex",
          providerRequestId: "request-123",
          status: "pending",
          message: "Waiting for approval to grant Bash",
          subject: {
            kind: "permission_grant",
            itemId: "item_123",
            toolName: "Bash",
            permissions: {
              network: null,
              fileSystem: {
                read: ["/tmp/project"],
                write: [],
              },
            },
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });

    expect(projected).toEqual([
      expect.objectContaining({
        kind: "permission-grant-lifecycle",
        id: "thread-1:approval:pi_123",
        title: "Waiting for approval to grant Bash",
        status: "pending",
        approvalTarget: {
          itemId: "item_123",
          toolName: "Bash",
        },
      }),
    ]);
  });

  it("replaces command approval state with the command item lifecycle", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-approval-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            status: "pending",
            approvalStatus: "waiting_for_approval",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-command-started",
        threadId: "thread-1",
        seq: 2,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            status: "pending",
            approvalStatus: null,
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-command-completed",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            status: "completed",
            approvalStatus: null,
            aggregatedOutput: "done",
            exitCode: 0,
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });

    expect(projected).toMatchObject([
      {
        kind: "command",
        callId: "item-1",
        command: "git push",
        status: "completed",
        output: "done",
        approvalStatus: null,
      },
    ]);
  });

  it("projects denied command approvals as the command item terminal state", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-approval-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            status: "pending",
            approvalStatus: "waiting_for_approval",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-approval-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            status: "interrupted",
            approvalStatus: "denied",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });

    expect(projected).toMatchObject([
      {
        kind: "command",
        callId: "item-1",
        command: "git push",
        status: "interrupted",
        approvalStatus: "denied",
      },
    ]);
  });

  it("replaces file-change approval state with the file-change item lifecycle", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-file-approval-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "item-file",
            changes: [],
            status: "pending",
            approvalStatus: "waiting_for_approval",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-file-completed",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "item-file",
            changes: [
              {
                path: "src/app.ts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-old\n+new",
              },
            ],
            status: "completed",
            approvalStatus: null,
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const [projected] = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });

    expect(projected).toMatchObject({
      kind: "file-edit",
      callId: "item-file",
      status: "completed",
      changes: [
        {
          path: "src/app.ts",
          kind: "update",
        },
      ],
    });
    expect(projected).toHaveProperty("approvalStatus", null);
  });
});
