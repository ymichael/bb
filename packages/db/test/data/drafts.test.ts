import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  createDraft,
  getDraft,
  listDrafts,
  deleteDraft,
} from "../../src/data/drafts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const project = createProject(db, noopNotifier, { name: "test-project" });
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
      content: "[]",
      model: "gpt-5",
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
      serviceTier: "flex",
    });

    expect(draft.id).toMatch(/^draft_/);
    expect(draft.threadId).toBe(thread.id);
    expect(draft.content).toBe("[]");
    expect(draft.model).toBe("gpt-5");
    expect(draft.serviceTier).toBe("flex");
  });

  it("gets a draft by ID", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: "[]",
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
    });

    const fetched = getDraft(db, draft.id);
    expect(fetched?.id).toBe(draft.id);
    expect(getDraft(db, "draft_nonexistent")).toBeNull();
  });

  it("lists drafts by thread", () => {
    const { db, thread } = setup();
    createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: "[]",
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
    });
    createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: "[{}]",
      reasoningLevel: "high",
      sandboxMode: "danger-full-access",
    });

    expect(listDrafts(db, thread.id)).toHaveLength(2);
  });

  it("deletes a draft", () => {
    const { db, thread } = setup();
    const draft = createDraft(db, noopNotifier, {
      threadId: thread.id,
      content: "[]",
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
    });

    expect(deleteDraft(db, noopNotifier, draft.id)).toBe(true);
    expect(listDrafts(db, thread.id)).toHaveLength(0);
    expect(deleteDraft(db, noopNotifier, draft.id)).toBe(false);
  });
});
