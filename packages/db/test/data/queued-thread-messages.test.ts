import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  claimQueuedThreadMessage,
  claimNextQueuedThreadMessage,
  createQueuedThreadMessage,
  deleteClaimedQueuedThreadMessage,
  deleteClaimedQueuedThreadMessageInTransaction,
  deleteQueuedThreadMessage,
  deleteQueuedThreadMessageInTransaction,
  getQueuedThreadMessage,
  listQueuedThreadMessages,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";

const defaultInput = [{ type: "text" as const, text: "hello" }];
const altInput = [{ type: "text" as const, text: "world" }];

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, thread };
}

describe("queued thread messages", () => {
  it("creates a queued message", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(queuedMessage.id).toMatch(/^qmsg_/);
    expect(queuedMessage.threadId).toBe(thread.id);
    expect(queuedMessage.content).toBe(JSON.stringify(defaultInput));
    expect(queuedMessage.model).toBe("gpt-5");
    expect(queuedMessage.serviceTier).toBe("default");
  });

  it("gets a queued message by ID", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    const fetched = getQueuedThreadMessage(db, queuedMessage.id);
    expect(fetched?.id).toBe(queuedMessage.id);
    expect(getQueuedThreadMessage(db, "qmsg_nonexistent")).toBeNull();
  });

  it("lists queued messages by thread", () => {
    const { db, thread } = setup();
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(2);
  });

  it("deletes a queued message", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id)).toBe(true);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);
    expect(deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id)).toBe(false);
  });

  it("deletes a queued message in a caller-owned transaction", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    const deleted = db.transaction((tx) =>
      deleteQueuedThreadMessageInTransaction(tx, { id: queuedMessage.id }),
    );

    expect(deleted).toBe(true);
    expect(getQueuedThreadMessage(db, queuedMessage.id)).toBeNull();
  });

  it("claims a queued message and hides it from the queue until the claim is released", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    const claimedQueuedMessage = claimQueuedThreadMessage(db, noopNotifier, queuedMessage.id);
    expect(claimedQueuedMessage?.id).toBe(queuedMessage.id);
    expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }
    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: claimedQueuedMessage.claimToken,
      }),
    ).toBe(true);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(1);
  });

  it("does not release or consume a queued message claimed by another owner", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    const firstClaim = claimQueuedThreadMessage(db, noopNotifier, queuedMessage.id);
    if (!firstClaim) {
      throw new Error("Expected first queued message claim");
    }
    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: "qclaim_staleowner",
      }),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(firstClaim.claimToken);
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageInTransaction(tx, {
          id: queuedMessage.id,
          claimToken: "qclaim_staleowner",
        }),
      ),
    ).toBe(false);

    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(true);
    const secondClaim = claimQueuedThreadMessage(db, noopNotifier, queuedMessage.id);
    if (!secondClaim) {
      throw new Error("Expected second queued message claim");
    }
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageInTransaction(tx, {
          id: queuedMessage.id,
          claimToken: firstClaim.claimToken,
        }),
      ),
    ).toBe(false);
    expect(
      deleteClaimedQueuedThreadMessage(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(secondClaim.claimToken);
    expect(
      deleteClaimedQueuedThreadMessage(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: secondClaim.claimToken,
      }),
    ).toBe(true);
    expect(getQueuedThreadMessage(db, queuedMessage.id)).toBeNull();
  });

  it("releases stale queued message claims", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      const claimedQueuedMessage = claimQueuedThreadMessage(db, noopNotifier, queuedMessage.id);
      expect(claimedQueuedMessage?.claimedAt).toBe(1_000);
      expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
      expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleQueuedMessageClaims(db, noopNotifier, { claimedBefore: 5_000 }),
      ).toBe(1);
      expect(listQueuedThreadMessages(db, thread.id).map((row) => row.id)).toEqual([
        queuedMessage.id,
      ]);
      expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims the oldest queued message first", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValueOnce(1_000);
      const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      nowSpy.mockReturnValueOnce(2_000);
      const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
      });

      const claimedQueuedMessage = claimNextQueuedThreadMessage(db, noopNotifier, thread.id);
      expect(claimedQueuedMessage?.id).toBe(firstQueuedMessage.id);
      expect(listQueuedThreadMessages(db, thread.id).map((queuedMessage) => queuedMessage.id)).toEqual([
        secondQueuedMessage.id,
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
