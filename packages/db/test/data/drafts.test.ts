import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  claimDraft,
  claimNextDraft,
  createDraft,
  deleteClaimedDraft,
  deleteClaimedDraftInTransaction,
  deleteDraft,
  deleteDraftInTransaction,
  getDraft,
  listDrafts,
  releaseDraftClaim,
  releaseStaleDraftClaims,
} from "../../src/data/drafts.js";
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

describe("drafts", () => {
  it("creates a draft", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(draft.id).toMatch(/^draft_/);
    expect(draft.threadId).toBe(thread.id);
    expect(draft.content).toBe(JSON.stringify(defaultInput));
    expect(draft.model).toBe("gpt-5");
    expect(draft.serviceTier).toBe("default");
  });

  it("gets a draft by ID", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    const fetched = getDraft(db, draft.id);
    expect(fetched?.id).toBe(draft.id);
    expect(getDraft(db, "draft_nonexistent")).toBeNull();
  });

  it("lists drafts by thread", () => {
    const { db, thread } = setup();
    createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(listDrafts(db, thread.id)).toHaveLength(2);
  });

  it("deletes a draft", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(deleteDraft(db, noopNotifier, draft.id)).toBe(true);
    expect(listDrafts(db, thread.id)).toHaveLength(0);
    expect(deleteDraft(db, noopNotifier, draft.id)).toBe(false);
  });

  it("deletes a draft in a caller-owned transaction", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    const deleted = db.transaction((tx) =>
      deleteDraftInTransaction(tx, { id: draft.id }),
    );

    expect(deleted).toBe(true);
    expect(getDraft(db, draft.id)).toBeNull();
  });

  it("claims a draft and hides it from the queue until the claim is released", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    const claimedDraft = claimDraft(db, noopNotifier, draft.id);
    expect(claimedDraft?.id).toBe(draft.id);
    expect(claimedDraft?.claimToken).toMatch(/^dclaim_/);
    expect(listDrafts(db, thread.id)).toHaveLength(0);

    if (!claimedDraft) {
      throw new Error("Expected draft claim");
    }
    expect(
      releaseDraftClaim(db, noopNotifier, {
        id: draft.id,
        claimToken: claimedDraft.claimToken,
      }),
    ).toBe(true);
    expect(listDrafts(db, thread.id)).toHaveLength(1);
  });

  it("does not release or consume a draft claimed by another owner", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    const firstClaim = claimDraft(db, noopNotifier, draft.id);
    if (!firstClaim) {
      throw new Error("Expected first draft claim");
    }
    expect(
      releaseDraftClaim(db, noopNotifier, {
        id: draft.id,
        claimToken: "dclaim_staleowner",
      }),
    ).toBe(false);
    expect(getDraft(db, draft.id)?.claimToken).toBe(firstClaim.claimToken);
    expect(
      db.transaction((tx) =>
        deleteClaimedDraftInTransaction(tx, {
          id: draft.id,
          claimToken: "dclaim_staleowner",
        }),
      ),
    ).toBe(false);

    expect(
      releaseDraftClaim(db, noopNotifier, {
        id: draft.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(true);
    const secondClaim = claimDraft(db, noopNotifier, draft.id);
    if (!secondClaim) {
      throw new Error("Expected second draft claim");
    }
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(
      db.transaction((tx) =>
        deleteClaimedDraftInTransaction(tx, {
          id: draft.id,
          claimToken: firstClaim.claimToken,
        }),
      ),
    ).toBe(false);
    expect(
      deleteClaimedDraft(db, noopNotifier, {
        id: draft.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(false);
    expect(getDraft(db, draft.id)?.claimToken).toBe(secondClaim.claimToken);
    expect(
      deleteClaimedDraft(db, noopNotifier, {
        id: draft.id,
        claimToken: secondClaim.claimToken,
      }),
    ).toBe(true);
    expect(getDraft(db, draft.id)).toBeNull();
  });

  it("releases stale draft claims", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      const draft = createDraft(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      const claimedDraft = claimDraft(db, noopNotifier, draft.id);
      expect(claimedDraft?.claimedAt).toBe(1_000);
      expect(claimedDraft?.claimToken).toMatch(/^dclaim_/);
      expect(listDrafts(db, thread.id)).toHaveLength(0);

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleDraftClaims(db, noopNotifier, { claimedBefore: 5_000 }),
      ).toBe(1);
      expect(listDrafts(db, thread.id).map((row) => row.id)).toEqual([
        draft.id,
      ]);
      expect(getDraft(db, draft.id)?.claimToken).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims the oldest queued draft first", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValueOnce(1_000);
      const firstDraft = createDraft(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      nowSpy.mockReturnValueOnce(2_000);
      const secondDraft = createDraft(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
      });

      const claimedDraft = claimNextDraft(db, noopNotifier, thread.id);
      expect(claimedDraft?.id).toBe(firstDraft.id);
      expect(listDrafts(db, thread.id).map((draft) => draft.id)).toEqual([
        secondDraft.id,
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
