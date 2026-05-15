import { describe, expect, it, vi } from "vitest";
import {
  archiveThread,
  createConnection,
  createQueuedThreadMessage,
  createProject,
  createPromptHistoryEntry,
  createThread,
  markThreadDeleted,
  migrate,
  noopNotifier,
  promptHistoryEntries,
  upsertHost,
} from "@bb/db";
import type { PromptHistoryScope, PromptInput } from "@bb/domain";
import {
  listProjectPromptHistory,
  listThreadPromptHistory,
  recordAcceptedPromptHistoryEntry,
} from "../../src/services/prompt-history.js";

type TestDb = ReturnType<typeof createConnection>;

interface InsertPromptHistoryEntryArgs {
  createdAt: number;
  db: TestDb;
  input: PromptInput[];
  projectId: string;
  requestSequence: number;
  scope: PromptHistoryScope;
  threadId: string;
}

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const firstProject = createProject(db, noopNotifier, {
    name: "Project A",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project-a" },
  }).project;
  const secondProject = createProject(db, noopNotifier, {
    name: "Project B",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project-b" },
  }).project;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return { db, firstProject, secondProject, logger };
}

function insertPromptHistoryEntry(args: InsertPromptHistoryEntryArgs) {
  return createPromptHistoryEntry(args.db, {
    projectId: args.projectId,
    threadId: args.threadId,
    scope: args.scope,
    requestSequence: args.requestSequence,
    input: args.input,
    createdAt: args.createdAt,
  });
}

describe("prompt history service", () => {
  it("returns project create history scoped to one project", () => {
    const { db, firstProject, secondProject, logger } = setup();
    const firstThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const secondThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const otherProjectThread = createThread(db, noopNotifier, {
      projectId: secondProject.id,
      providerId: "codex",
    });

    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: firstThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: [{ type: "text", text: "Investigate auth flow" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: [{ type: "text", text: "Open incident thread" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "project",
      requestSequence: 2,
      createdAt: 30,
      input: [{ type: "text", text: "Open incident thread" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "thread",
      requestSequence: 3,
      createdAt: 40,
      input: [{ type: "text", text: "Follow up inside thread" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: secondProject.id,
      threadId: otherProjectThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 60,
      input: [{ type: "text", text: "Other project prompt" }],
    });

    expect(
      listProjectPromptHistory(
        { db, logger },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 30,
        input: [{ type: "text", text: "Open incident thread" }],
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: [{ type: "text", text: "Investigate auth flow" }],
      },
    ]);
  });

  it("includes archived thread starter prompts in project history", () => {
    const { db, firstProject, logger } = setup();
    const liveThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const archivedThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: liveThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: [{ type: "text", text: "Visible starter prompt" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: archivedThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: [{ type: "text", text: "Archived starter prompt" }],
    });
    archiveThread(db, noopNotifier, archivedThread.id);

    expect(
      listProjectPromptHistory(
        { db, logger },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 20,
        input: [{ type: "text", text: "Archived starter prompt" }],
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: [{ type: "text", text: "Visible starter prompt" }],
      },
    ]);
  });

  it("excludes deleted thread starter prompts from project history", () => {
    const { db, firstProject, logger } = setup();
    const liveThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const deletedThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: liveThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: [{ type: "text", text: "Visible starter prompt" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: deletedThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: [{ type: "text", text: "Deleted starter prompt" }],
    });
    markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    expect(
      listProjectPromptHistory(
        { db, logger },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: [{ type: "text", text: "Visible starter prompt" }],
      },
    ]);
  });

  it("does not record project history for managed child thread starts", () => {
    const { db, firstProject, logger } = setup();
    const managerThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
      type: "manager",
    });
    const directThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const managedThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
      parentThreadId: managerThread.id,
    });

    expect(
      recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread: directThread,
          input: [{ type: "text", text: "User-created thread" }],
          initiator: "user",
          target: { kind: "thread-start" },
          requestSequence: 1,
        },
      ),
    ).toBe(true);
    expect(
      recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread: managedThread,
          input: [{ type: "text", text: "Manager-created worker" }],
          initiator: "user",
          target: { kind: "thread-start" },
          requestSequence: 1,
        },
      ),
    ).toBe(false);

    expect(
      listProjectPromptHistory(
        { db, logger },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: expect.any(Number),
        input: [{ type: "text", text: "User-created thread" }],
      },
    ]);
  });

  it("returns thread follow-up history with queued messages merged in", () => {
    const { db, firstProject, logger } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: [{ type: "text", text: "Start thread" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "thread",
      requestSequence: 2,
      createdAt: 30,
      input: [{ type: "text", text: "Fix the flaky test" }],
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "thread",
      requestSequence: 3,
      createdAt: 40,
      input: [{ type: "text", text: "Add regression coverage" }],
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: [{ type: "text", text: "Add regression coverage" }],
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(
      listThreadPromptHistory(
        { db, logger },
        {
          threadId: thread.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^queued-message:/u),
        createdAt: expect.any(Number),
        input: [{ type: "text", text: "Add regression coverage" }],
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 30,
        input: [{ type: "text", text: "Fix the flaky test" }],
      },
    ]);
  });

  it("skips malformed stored prompt history rows instead of failing the request", () => {
    const { db, firstProject, logger } = setup();
    const validThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const malformedThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: validThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: [{ type: "text", text: "Recover valid prompt history" }],
    });
    db.insert(promptHistoryEntries)
      .values({
        id: "phist_malformed",
        projectId: firstProject.id,
        threadId: malformedThread.id,
        scope: "project",
        requestSequence: 1,
        input: '[{"type":"text"}]',
        createdAt: 20,
      })
      .run();

    expect(
      listProjectPromptHistory(
        { db, logger },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: [{ type: "text", text: "Recover valid prompt history" }],
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "phist_malformed",
        err: expect.anything(),
        requestSequence: 1,
        threadId: malformedThread.id,
      }),
      "Skipping malformed prompt history row",
    );
  });
});
