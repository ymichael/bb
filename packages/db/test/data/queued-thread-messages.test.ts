import { describe, expect, it, vi } from "vitest";
import { threadScope, type PromptInput } from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import { insertEvents } from "../../src/data/events.js";
import {
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessage,
  claimQueuedThreadMessageGroup,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessages,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
  reorderQueuedThreadMessage,
  requeueClaimedQueuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
  updateQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

const defaultInput = textInput("hello");
const altInput = textInput("world");

function setup() {
  const db = createMigratedConnection();
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
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(queuedMessage.id).toMatch(/^qmsg_/);
    expect(queuedMessage.threadId).toBe(thread.id);
    expect(queuedMessage.content).toBe(JSON.stringify(defaultInput));
    expect(queuedMessage.model).toBe("gpt-5");
    expect(queuedMessage.serviceTier).toBe("default");
    expect(queuedMessage.groupWithNext).toBe(false);
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
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
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
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(2);
  });

  it("lists an idle thread waiting for its turn to start", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "turn-starting" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).toContain(thread.id);
  });

  it("updates queued message content without changing its identity or position", () => {
    const { db, thread } = setup();
    const first = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const second = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      expectedGroupedPrefixQueuedMessageIds: [first.id, second.id],
      groupBoundaryQueuedMessageId: second.id,
      notifier: noopNotifier,
      threadId: thread.id,
    });
    const before = getQueuedThreadMessage(db, first.id);

    const result = updateQueuedThreadMessage(db, noopNotifier, {
      content: textInput("edited in place"),
      expectedUpdatedAt: before?.updatedAt ?? -1,
      id: first.id,
      threadId: thread.id,
    });

    expect(result.kind).toBe("updated");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([first.id, second.id]);
    expect(getQueuedThreadMessage(db, first.id)).toMatchObject({
      content: JSON.stringify(textInput("edited in place")),
      createdAt: before?.createdAt,
      groupWithNext: true,
      id: first.id,
      model: before?.model,
      permissionMode: before?.permissionMode,
      reasoningLevel: before?.reasoningLevel,
      serviceTier: before?.serviceTier,
      sortKey: before?.sortKey,
    });
  });

  it("rejects a second update based on the same queued message version", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        content: textInput("first edit"),
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }).kind,
    ).toBe("updated");
    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        content: textInput("stale edit"),
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "stale" });
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.content).toBe(
      JSON.stringify(textInput("first edit")),
    );
  });

  it("advances updatedAt when an update occurs within the same millisecond", () => {
    const fixedNow = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const { db, thread } = setup();
      const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const result = updateQueuedThreadMessage(db, noopNotifier, {
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      });

      expect(result).toMatchObject({
        kind: "updated",
        queuedMessage: { updatedAt: fixedNow + 1 },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not update a queued message that is already claimed for sending", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    claimQueuedThreadMessage(db, noopNotifier, queuedMessage.id);

    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "claimed" });
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.content).toBe(
      JSON.stringify(defaultInput),
    );
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
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id)).toBe(
      true,
    );
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);
    expect(deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id)).toBe(
      false,
    );
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
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const claimedQueuedMessage = claimQueuedThreadMessage(
      db,
      noopNotifier,
      queuedMessage.id,
    );
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
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const firstClaim = claimQueuedThreadMessage(
      db,
      noopNotifier,
      queuedMessage.id,
    );
    if (!firstClaim) {
      throw new Error("Expected first queued message claim");
    }
    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: "qclaim_staleowner",
      }),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(
      firstClaim.claimToken,
    );
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: [
            { id: queuedMessage.id, claimToken: "qclaim_staleowner" },
          ],
        }),
      ),
    ).toBe(false);

    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(true);
    const secondClaim = claimQueuedThreadMessage(
      db,
      noopNotifier,
      queuedMessage.id,
    );
    if (!secondClaim) {
      throw new Error("Expected second queued message claim");
    }
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: [
            { id: queuedMessage.id, claimToken: firstClaim.claimToken },
          ],
        }),
      ),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(
      secondClaim.claimToken,
    );
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: [
            { id: queuedMessage.id, claimToken: secondClaim.claimToken },
          ],
        }),
      ),
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
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      const claimedQueuedMessage = claimQueuedThreadMessage(
        db,
        noopNotifier,
        queuedMessage.id,
      );
      expect(claimedQueuedMessage?.claimedAt).toBe(1_000);
      expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
      expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [],
        }),
      ).toBe(1);
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([queuedMessage.id]);
      expect(
        getQueuedThreadMessage(db, queuedMessage.id)?.claimToken,
      ).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not release stale queued message claims protected by a live owner", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      const protectedQueuedMessage = createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: defaultInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      const releasableQueuedMessage = createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: altInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      const protectedClaim = claimQueuedThreadMessage(
        db,
        noopNotifier,
        protectedQueuedMessage.id,
      );
      const releasableClaim = claimQueuedThreadMessage(
        db,
        noopNotifier,
        releasableQueuedMessage.id,
      );
      if (!protectedClaim || !releasableClaim) {
        throw new Error("Expected queued message claims");
      }

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [protectedClaim.claimToken],
        }),
      ).toBe(1);

      expect(
        getQueuedThreadMessage(db, protectedQueuedMessage.id)?.claimToken,
      ).toBe(protectedClaim.claimToken);
      expect(
        getQueuedThreadMessage(db, releasableQueuedMessage.id)?.claimToken,
      ).toBeNull();
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([releasableQueuedMessage.id]);
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
        waitingOn: { kind: "turn-starting" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      nowSpy.mockReturnValueOnce(2_000);
      const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const claimedQueuedMessage = claimNextQueuedThreadMessageGroup(
        db,
        noopNotifier,
        thread.id,
      )?.[0];
      expect(claimedQueuedMessage?.id).toBe(firstQueuedMessage.id);
      expect(
        listQueuedThreadMessages(db, thread.id).map(
          (queuedMessage) => queuedMessage.id,
        ),
      ).toEqual([secondQueuedMessage.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("persists the contiguous lead group boundary", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("updated");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: true },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects a group boundary when the expected prefix is stale", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: firstQueuedMessage.id,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("reordered");

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("stale_neighbor");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("claims the contiguous lead group together", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const claimedQueuedMessages = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
    );

    expect(
      claimedQueuedMessages?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([firstQueuedMessage.id, secondQueuedMessage.id]);
    expect(
      listQueuedThreadMessages(db, thread.id).map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([thirdQueuedMessage.id]);
  });

  it("pauses ordinary turn-end rows without pausing system notices", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const ordinary = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const notice = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: {
        kind: "child-completed",
        subject: {
          kind: "thread",
          threadId: "thr_child",
          threadName: "Child",
        },
      },
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).toContain(thread.id);
    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, ordinary.id, {
        kind: "automatic",
        isGroupEligible: () => true,
      }),
    ).toBeNull();
    expect(
      claimNextQueuedThreadMessageGroup(db, noopNotifier, thread.id)?.map(
        (row) => row.id,
      ),
    ).toEqual([notice.id]);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([ordinary.id]);
  });

  it("does not split a requeued group: the tail waits with its blocked lead", () => {
    const { db, thread } = setup();
    const lead = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const tail = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [lead.id, tail.id],
      groupBoundaryQueuedMessageId: tail.id,
    });
    const claimed = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
    );
    expect(claimed?.map((queuedMessage) => queuedMessage.id)).toEqual([
      lead.id,
      tail.id,
    ]);
    requeueClaimedQueuedThreadMessages(db, noopNotifier, {
      claims: claimed!.map(({ id, claimToken }) => ({ id, claimToken })),
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limits", reason: "At capacity" },
      sendAt: null,
    });

    // The requeue wrote the wait on the lead only; the tail must not be
    // claimable alone, or the drain would dispatch half a composed prompt.
    expect(
      claimNextQueuedThreadMessageGroup(db, noopNotifier, thread.id),
    ).toBeNull();

    // An independent row behind the blocked group still drains past it.
    const independent = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("independent"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    expect(
      claimNextQueuedThreadMessageGroup(db, noopNotifier, thread.id)?.map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([independent.id]);
  });

  it("claiming a cleared lead takes its still-grouped tail with it", () => {
    const { db, thread } = setup();
    const lead = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const tail = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [lead.id, tail.id],
      groupBoundaryQueuedMessageId: tail.id,
    });
    const claimed = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
    );
    requeueClaimedQueuedThreadMessages(db, noopNotifier, {
      claims: claimed!.map(({ id, claimToken }) => ({ id, claimToken })),
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limits", reason: "At capacity" },
      sendAt: null,
    });
    clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: lead.id,
      threadId: thread.id,
    });

    // The requested drain clears the lead's wait and claims by id; the claim
    // is a claim on the batch, so the tail dispatches with it.
    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, lead.id, {
        kind: "explicit-send",
      })?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([lead.id, tail.id]);
  });

  it("claims only the selected message when sending outside the lead group", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    const claimedQueuedMessages = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thirdQueuedMessage.id,
      { kind: "explicit-send" },
    );

    expect(
      claimedQueuedMessages?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([thirdQueuedMessage.id]);
    expect(
      listQueuedThreadMessages(db, thread.id).map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([firstQueuedMessage.id, secondQueuedMessage.id]);
  });

  it("clears the previous group edge when deleting a grouped follower", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      deleteQueuedThreadMessage(db, noopNotifier, secondQueuedMessage.id),
    ).toBe(true);

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
    expect(
      claimNextQueuedThreadMessageGroup(db, noopNotifier, thread.id)?.map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("clears the previous group edge when claiming a grouped follower", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      claimQueuedThreadMessageGroup(db, noopNotifier, secondQueuedMessage.id, {
        kind: "explicit-send",
      })?.map((queuedMessage) => queuedMessage.id),
    ).toEqual([secondQueuedMessage.id]);

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("clears the claimed follower group edge when releasing a failed direct send", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
        thirdQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: thirdQueuedMessage.id,
    });

    const claimed = claimQueuedThreadMessageGroup(
      db,
      noopNotifier,
      secondQueuedMessage.id,
      { kind: "explicit-send" },
    );
    expect(claimed?.map((queuedMessage) => queuedMessage.id)).toEqual([
      secondQueuedMessage.id,
    ]);
    expect(claimed?.[0]).toBeDefined();
    if (!claimed?.[0]) return;

    releaseQueuedMessageClaim(db, noopNotifier, {
      id: claimed[0].id,
      claimToken: claimed[0].claimToken,
    });

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects grouped prefixes that mix sender attribution", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      senderThreadId: "thr_sender",
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("invalid_sender");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("rejects grouped prefixes that mix execution options", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5.5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(result.kind).toBe("invalid_execution_options");
    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("does not consume any grouped claim when batch deletion is stale", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });
    const claimedQueuedMessages = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
    );
    if (!claimedQueuedMessages) {
      throw new Error("Expected grouped claim");
    }

    const staleClaim = [
      claimedQueuedMessages[0]!,
      { ...claimedQueuedMessages[1]!, claimToken: "qclaim_stale" },
    ];
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: staleClaim,
        }),
      ),
    ).toBe(false);

    expect(getQueuedThreadMessage(db, firstQueuedMessage.id)?.claimToken).toBe(
      claimedQueuedMessages[0]!.claimToken,
    );
    expect(getQueuedThreadMessage(db, secondQueuedMessage.id)?.claimToken).toBe(
      claimedQueuedMessages[1]!.claimToken,
    );
  });

  it("reorders queued messages to the front, middle, and end", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const moveToFront = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: null,
      nextQueuedMessageId: firstQueuedMessage.id,
    });
    expect(moveToFront.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      firstQueuedMessage.id,
      secondQueuedMessage.id,
    ]);

    const moveToMiddle = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: secondQueuedMessage.id,
      previousQueuedMessageId: thirdQueuedMessage.id,
      nextQueuedMessageId: firstQueuedMessage.id,
    });
    expect(moveToMiddle.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      secondQueuedMessage.id,
      firstQueuedMessage.id,
    ]);

    const moveToEnd = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: firstQueuedMessage.id,
      nextQueuedMessageId: null,
    });
    expect(moveToEnd.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      secondQueuedMessage.id,
      firstQueuedMessage.id,
      thirdQueuedMessage.id,
    ]);
  });

  it("claims the reordered first queued message", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: secondQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("reordered");

    const claimedQueuedMessage = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
    )?.[0];
    expect(claimedQueuedMessage?.id).toBe(secondQueuedMessage.id);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("rolls back a reorder when the requested group boundary is invalid", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      senderThreadId: "thr_sender",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
        groupBoundaryQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("invalid_sender");

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
    ]);
  });

  it("clears grouping when reorder-only would regroup different messages", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ],
      groupBoundaryQueuedMessageId: secondQueuedMessage.id,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: firstQueuedMessage.id,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("reordered");

    expect(
      listQueuedThreadMessages(db, thread.id).map((queuedMessage) => ({
        id: queuedMessage.id,
        groupWithNext: queuedMessage.groupWithNext,
      })),
    ).toEqual([
      { id: firstQueuedMessage.id, groupWithNext: false },
      { id: thirdQueuedMessage.id, groupWithNext: false },
      { id: secondQueuedMessage.id, groupWithNext: false },
    ]);
    expect(
      claimNextQueuedThreadMessageGroup(db, noopNotifier, thread.id)?.map(
        (queuedMessage) => queuedMessage.id,
      ),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("rejects reordering claimed, missing, cross-thread, and inverted neighbors", () => {
    const { db, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: thread.projectId,
      providerId: "codex",
    });
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const otherQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: otherThread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: "qmsg_missing",
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("not_found");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: otherQueuedMessage.id,
        nextQueuedMessageId: null,
      }).kind,
    ).toBe("stale_neighbor");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: firstQueuedMessage.id,
        previousQueuedMessageId: thirdQueuedMessage.id,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("invalid_neighbor_order");

    const claimedQueuedMessage = claimQueuedThreadMessage(
      db,
      noopNotifier,
      secondQueuedMessage.id,
    );
    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: secondQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("claimed");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("stale_neighbor");
  });
});
