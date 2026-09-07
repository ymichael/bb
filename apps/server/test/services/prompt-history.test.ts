import { describe, expect, it } from "vitest";
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
import { textInput } from "../helpers/prompt-input.js";

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
  return { db, firstProject, secondProject };
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
    const { db, firstProject, secondProject } = setup();
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
      input: textInput("Investigate auth flow"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Open incident thread"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "project",
      requestSequence: 2,
      createdAt: 30,
      input: textInput("Open incident thread"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      scope: "thread",
      requestSequence: 3,
      createdAt: 40,
      input: textInput("Follow up inside thread"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: secondProject.id,
      threadId: otherProjectThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 60,
      input: textInput("Other project prompt"),
    });

    expect(
      listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 30,
        input: textInput("Open incident thread"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Investigate auth flow"),
      },
    ]);
  });

  it("includes archived thread starter prompts in project history", () => {
    const { db, firstProject } = setup();
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
      input: textInput("Visible starter prompt"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: archivedThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Archived starter prompt"),
    });
    archiveThread(db, noopNotifier, archivedThread.id);

    expect(
      listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 20,
        input: textInput("Archived starter prompt"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Visible starter prompt"),
      },
    ]);
  });

  it("includes hidden root prompts in ordinary project history", () => {
    const { db, firstProject } = setup();
    const visibleThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const hiddenRootThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
      visibility: "hidden",
    });

    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: visibleThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 10,
      input: textInput("Visible starter prompt"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: hiddenRootThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Workflow worker prompt"),
    });

    expect(
      listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 20,
        input: textInput("Workflow worker prompt"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Visible starter prompt"),
      },
    ]);
  });

  it("excludes deleted thread starter prompts from project history", () => {
    const { db, firstProject } = setup();
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
      input: textInput("Visible starter prompt"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: deletedThread.id,
      scope: "project",
      requestSequence: 1,
      createdAt: 20,
      input: textInput("Deleted starter prompt"),
    });
    markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    expect(
      listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Visible starter prompt"),
      },
    ]);
  });

  it("does not record project history for child thread starts", () => {
    const { db, firstProject } = setup();
    const parentThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const directThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const childThread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
      parentThreadId: parentThread.id,
    });

    expect(
      recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread: directThread,
          input: textInput("User-created thread"),
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
          thread: childThread,
          input: textInput("Parent-created worker"),
          initiator: "user",
          target: { kind: "thread-start" },
          requestSequence: 1,
        },
      ),
    ).toBe(false);

    expect(
      listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: expect.any(Number),
        input: textInput("User-created thread"),
      },
    ]);
  });

  it("returns thread follow-up history with queued messages merged in", () => {
    const { db, firstProject } = setup();
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
      input: textInput("Start thread"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "thread",
      requestSequence: 2,
      createdAt: 30,
      input: textInput("Fix the flaky test"),
    });
    insertPromptHistoryEntry({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      scope: "thread",
      requestSequence: 3,
      createdAt: 40,
      input: textInput("Add regression coverage"),
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("Add regression coverage"),
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
      listThreadPromptHistory(
        { db },
        {
          threadId: thread.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^queued-message:/u),
        createdAt: expect.any(Number),
        input: textInput("Add regression coverage"),
      },
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 30,
        input: textInput("Fix the flaky test"),
      },
    ]);
  });

  it("silently skips malformed stored prompt history rows", () => {
    const { db, firstProject } = setup();
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
      input: textInput("Recover valid prompt history"),
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
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: 10,
        input: textInput("Recover valid prompt history"),
      },
    ]);
  });
  it("does not persist empty-input turns as prompt history rows", () => {
    const { db, firstProject } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    expect(
      recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread,
          input: [],
          initiator: "user",
          target: { kind: "thread-start" },
          requestSequence: 1,
        },
      ),
    ).toBe(false);

    expect(db.select().from(promptHistoryEntries).all()).toEqual([]);
    expect(
      listProjectPromptHistory(
        { db },
        {
          projectId: firstProject.id,
          limit: 50,
        },
      ),
    ).toEqual([]);
  });

  it("excludes agent-only context from recalled prompt history", () => {
    const { db, firstProject } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });
    const visibleInput = textInput("Explain the selected message");

    expect(
      recordAcceptedPromptHistoryEntry(
        { db },
        {
          thread,
          input: [
            {
              type: "text",
              text: "Replying to this earlier message",
              mentions: [],
              visibility: "agent-only",
            },
            ...visibleInput,
          ],
          initiator: "user",
          target: { kind: "new-turn" },
          requestSequence: 1,
        },
      ),
    ).toBe(true);
    expect(
      listThreadPromptHistory({ db }, { threadId: thread.id, limit: 50 }),
    ).toEqual([
      {
        id: expect.stringMatching(/^phist_/u),
        createdAt: expect.any(Number),
        input: visibleInput,
      },
    ]);
  });
});
