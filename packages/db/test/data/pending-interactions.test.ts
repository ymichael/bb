import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  createPendingInteraction,
  getActivePendingInteractionForThread,
  getPendingInteractionByProviderRequest,
  interruptPendingInteractionsForThreadIds,
  interruptPendingInteractionsForThreads,
  listPendingInteractionsByThread,
  setPendingInteractionResolved,
} from "../../src/data/pending-interactions.js";
import { createThread } from "../../src/data/threads.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/test-project",
    },
  });
  const environment = createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
    projectId: project.id,
    hostId: host.id,
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });
  const siblingThread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });

  return { db, thread, siblingThread };
}

function commandApprovalPayload(command: string, itemId: string): string {
  return JSON.stringify({
    subject: {
      kind: "command",
      itemId,
      command,
      cwd: "/tmp/project",
    },
    reason: null,
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  });
}

function fileChangeApprovalPayload(itemId: string): string {
  return JSON.stringify({
    subject: {
      kind: "file_change",
      itemId,
    },
    reason: "Needs file write approval",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  });
}

describe("pending interactions", () => {
  it("creates and looks up provider-correlated pending interactions", () => {
    const { db, thread } = setup();

    const created = createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });

    expect(created.status).toBe("pending");
    expect(
      getPendingInteractionByProviderRequest(db, {
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        providerRequestId: "request-1",
      })?.id,
    ).toBe(created.id);
    expect(getActivePendingInteractionForThread(db, thread.id)?.id).toBe(
      created.id,
    );
  });

  it("rejects duplicate provider request identities", () => {
    const { db, siblingThread, thread } = setup();
    const created = createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });

    expect(() =>
      createPendingInteraction(db, {
        threadId: siblingThread.id,
        turnId: "turn-2",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        providerRequestId: "request-1",
        payload: commandApprovalPayload("git status", "item-2"),
      }),
    ).toThrow();
    expect(
      getPendingInteractionByProviderRequest(db, {
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        providerRequestId: "request-1",
      })?.id,
    ).toBe(created.id);
  });

  it("lists pending interactions newest first and transitions them to resolved", () => {
    const { db, thread } = setup();

    const older = createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });
    const newer = createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-2",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-2",
      payload: fileChangeApprovalPayload("item-2"),
    });

    expect(
      listPendingInteractionsByThread(db, { threadId: thread.id }).map(
        (row) => row.id,
      ),
    ).toEqual([newer.id, older.id]);

    const resolved = setPendingInteractionResolved(db, {
      id: older.id,
      resolution: JSON.stringify({
        decision: "allow_for_session",
        grantedPermissions: null,
      }),
    });

    expect(resolved).toMatchObject({
      id: older.id,
      status: "resolved",
    });
  });

  it("interrupts pending interactions for matching provider threads only", () => {
    const { db, thread, siblingThread } = setup();

    const interruptedTarget = createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      payload: commandApprovalPayload("git push", "item-1"),
    });
    createPendingInteraction(db, {
      threadId: siblingThread.id,
      turnId: "turn-2",
      providerId: "claude-code",
      providerThreadId: "provider-thread-2",
      providerRequestId: "request-2",
      payload: commandApprovalPayload("rm -rf build", "item-2"),
    });

    const interrupted = interruptPendingInteractionsForThreads(db, {
      providerId: "codex",
      threadIds: [thread.id],
      statusReason: "Provider exited",
    });

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({
      id: interruptedTarget.id,
      status: "interrupted",
      statusReason: "Provider exited",
    });
    expect(
      getActivePendingInteractionForThread(db, siblingThread.id)?.status,
    ).toBe("pending");
  });

  it(
    "chunks provider-thread interrupts to stay under SQLite variable limits",
    () => {
      const { db, siblingThread, thread } = setup();
      const threadIds = Array.from(
        { length: 1_050 },
        (_, index) => `thr_missing_batch_${index}`,
      );
      threadIds[0] = thread.id;
      threadIds[1_000] = siblingThread.id;
      const targetThreadIds = [thread.id, siblingThread.id];

      for (const [index, threadId] of targetThreadIds.entries()) {
        createPendingInteraction(db, {
          threadId,
          turnId: `turn-batched-interrupt-provider-${index}`,
          providerId: "codex",
          providerThreadId: `provider-thread-batched-interrupt-provider-${index}`,
          providerRequestId: `request-batched-interrupt-provider-${index}`,
          payload: commandApprovalPayload(
            "git push",
            `item-batched-interrupt-provider-${index}`,
          ),
        });
      }

      expect(
        new Set(
          interruptPendingInteractionsForThreads(db, {
            providerId: "codex",
            threadIds,
            statusReason: "Provider exited",
          }).map((row) => row.threadId),
        ),
      ).toEqual(new Set(targetThreadIds));
    },
  );

  it(
    "chunks thread-id interrupts to stay under SQLite variable limits",
    () => {
      const { db, siblingThread, thread } = setup();
      const threadIds = Array.from(
        { length: 1_050 },
        (_, index) => `thr_missing_batch_${index}`,
      );
      threadIds[0] = thread.id;
      threadIds[1_000] = siblingThread.id;
      const targetThreadIds = [thread.id, siblingThread.id];

      for (const [index, threadId] of targetThreadIds.entries()) {
        createPendingInteraction(db, {
          threadId,
          turnId: `turn-batched-interrupt-thread-${index}`,
          providerId: "codex",
          providerThreadId: `provider-thread-batched-interrupt-thread-${index}`,
          providerRequestId: `request-batched-interrupt-thread-${index}`,
          payload: commandApprovalPayload(
            "git push",
            `item-batched-interrupt-thread-${index}`,
          ),
        });
      }

      expect(
        new Set(
          interruptPendingInteractionsForThreadIds(db, {
            threadIds,
            statusReason: "Thread stopped",
          }).map((row) => row.threadId),
        ),
      ).toEqual(new Set(targetThreadIds));
    },
  );

});
