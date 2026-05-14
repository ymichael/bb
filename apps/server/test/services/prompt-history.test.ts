import { describe, expect, it, vi } from "vitest";
import {
  archiveThread,
  createConnection,
  createDraft,
  createProject,
  createThread,
  insertEvents,
  markThreadDeleted,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  type PromptInput,
  type TurnRequestTarget,
} from "@bb/domain";
import {
  listProjectPromptHistory,
  listThreadPromptHistory,
} from "../../src/services/prompt-history.js";

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
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return { db, firstProject, secondProject, logger };
}

function insertTurnRequestEvent(args: {
  createdAt: number;
  db: ReturnType<typeof createConnection>;
  initiator: "user" | "agent";
  input: PromptInput[];
  projectId: string;
  sequence: number;
  target: TurnRequestTarget;
  threadId: string;
}) {
  insertEvents(args.db, noopNotifier, [
    {
      threadId: args.threadId,
      sequence: args.sequence,
      type: "client/turn/requested",
      itemId: null,
      itemKind: null,
      scope: threadScope(),
      createdAt: args.createdAt,
      data: JSON.stringify({
        direction: "outbound",
        requestId: encodeClientTurnRequestIdNumber({ value: args.sequence }),
        source: "tell",
        initiator: args.initiator,
        input: args.input,
        target: args.target,
        request: {
          method:
            args.target.kind === "thread-start" ? "thread/start" : "turn/start",
          params: {
            projectId: args.projectId,
          },
        },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
          seq: args.sequence,
        },
      }),
    },
  ]);
}

function insertTurnLifecycleEvent(args: {
  createdAt: number;
  db: ReturnType<typeof createConnection>;
  initiator: "user" | "agent";
  sequence: number;
  threadId: string;
  type: "client/thread/start" | "client/turn/start";
}) {
  insertEvents(args.db, noopNotifier, [
    {
      threadId: args.threadId,
      sequence: args.sequence,
      type: args.type,
      itemId: null,
      itemKind: null,
      scope: threadScope(),
      createdAt: args.createdAt,
      data: JSON.stringify({
        direction: "outbound",
        source: "tell",
        initiator: args.initiator,
        request: {
          method:
            args.type === "client/thread/start" ? "thread/start" : "turn/start",
          params: {},
        },
      }),
    },
  ]);
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

    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: firstThread.id,
      sequence: 1,
      createdAt: 10,
      initiator: "user",
      input: [{ type: "text", text: "Investigate auth flow" }],
      target: { kind: "thread-start" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      sequence: 1,
      createdAt: 20,
      initiator: "user",
      input: [{ type: "text", text: "Open incident thread" }],
      target: { kind: "thread-start" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      sequence: 2,
      createdAt: 30,
      initiator: "user",
      input: [{ type: "text", text: "Open incident thread" }],
      target: { kind: "thread-start" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      sequence: 3,
      createdAt: 40,
      initiator: "user",
      input: [{ type: "text", text: "Follow up inside thread" }],
      target: { kind: "new-turn" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: secondThread.id,
      sequence: 4,
      createdAt: 50,
      initiator: "agent",
      input: [{ type: "text", text: "Agent-owned prompt" }],
      target: { kind: "thread-start" },
    });
    insertTurnRequestEvent({
      db,
      projectId: secondProject.id,
      threadId: otherProjectThread.id,
      sequence: 1,
      createdAt: 60,
      initiator: "user",
      input: [{ type: "text", text: "Other project prompt" }],
      target: { kind: "thread-start" },
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
        id: expect.stringMatching(/^event:/u),
        createdAt: 30,
        input: [{ type: "text", text: "Open incident thread" }],
      },
      {
        id: expect.stringMatching(/^event:/u),
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

    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: liveThread.id,
      sequence: 1,
      createdAt: 10,
      initiator: "user",
      input: [{ type: "text", text: "Visible starter prompt" }],
      target: { kind: "thread-start" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: archivedThread.id,
      sequence: 1,
      createdAt: 20,
      initiator: "user",
      input: [{ type: "text", text: "Archived starter prompt" }],
      target: { kind: "thread-start" },
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
        id: expect.stringMatching(/^event:/u),
        createdAt: 20,
        input: [{ type: "text", text: "Archived starter prompt" }],
      },
      {
        id: expect.stringMatching(/^event:/u),
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

    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: liveThread.id,
      sequence: 1,
      createdAt: 10,
      initiator: "user",
      input: [{ type: "text", text: "Visible starter prompt" }],
      target: { kind: "thread-start" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: deletedThread.id,
      sequence: 1,
      createdAt: 20,
      initiator: "user",
      input: [{ type: "text", text: "Deleted starter prompt" }],
      target: { kind: "thread-start" },
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
        id: expect.stringMatching(/^event:/u),
        createdAt: 10,
        input: [{ type: "text", text: "Visible starter prompt" }],
      },
    ]);
  });

  it("returns thread follow-up history with queued drafts merged in", () => {
    const { db, firstProject, logger } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      sequence: 1,
      createdAt: 10,
      initiator: "user",
      input: [{ type: "text", text: "Start thread" }],
      target: { kind: "thread-start" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      sequence: 2,
      createdAt: 30,
      initiator: "user",
      input: [{ type: "text", text: "Fix the flaky test" }],
      target: { kind: "new-turn" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      sequence: 3,
      createdAt: 40,
      initiator: "user",
      input: [{ type: "text", text: "Add regression coverage" }],
      target: { kind: "steer", expectedTurnId: "turn-1" },
    });
    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      sequence: 4,
      createdAt: 45,
      initiator: "agent",
      input: [{ type: "text", text: "Internal system turn" }],
      target: { kind: "auto", expectedTurnId: "turn-1" },
    });
    createDraft(db, noopNotifier, {
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
        id: expect.stringMatching(/^draft:/u),
        createdAt: expect.any(Number),
        input: [{ type: "text", text: "Add regression coverage" }],
      },
      {
        id: expect.stringMatching(/^event:/u),
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

    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: validThread.id,
      sequence: 1,
      createdAt: 10,
      initiator: "user",
      input: [{ type: "text", text: "Recover valid prompt history" }],
      target: { kind: "thread-start" },
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: malformedThread.id,
        sequence: 1,
        type: "client/turn/requested",
        itemId: null,
        itemKind: null,
        scope: threadScope(),
        createdAt: 20,
        data: JSON.stringify({
          initiator: "user",
          input: [{ type: "text", text: "Malformed prompt history" }],
          target: { kind: "thread-start" },
        }),
      },
    ]);

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
        id: expect.stringMatching(/^event:/u),
        createdAt: 10,
        input: [{ type: "text", text: "Recover valid prompt history" }],
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.anything(),
        sequence: 1,
        threadId: malformedThread.id,
        type: "client/turn/requested",
      }),
      "Skipping malformed prompt history row",
    );
  });

  it("ignores lifecycle-only client turn events without stored input", () => {
    const { db, firstProject, logger } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: firstProject.id,
      providerId: "codex",
    });

    insertTurnRequestEvent({
      db,
      projectId: firstProject.id,
      threadId: thread.id,
      sequence: 1,
      createdAt: 10,
      initiator: "user",
      input: [{ type: "text", text: "Start thread" }],
      target: { kind: "thread-start" },
    });
    insertTurnLifecycleEvent({
      db,
      threadId: thread.id,
      sequence: 2,
      createdAt: 11,
      initiator: "user",
      type: "client/thread/start",
    });
    insertTurnLifecycleEvent({
      db,
      threadId: thread.id,
      sequence: 3,
      createdAt: 12,
      initiator: "user",
      type: "client/turn/start",
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
        id: expect.stringMatching(/^event:/u),
        createdAt: 10,
        input: [{ type: "text", text: "Start thread" }],
      },
    ]);
    expect(
      listThreadPromptHistory(
        { db, logger },
        {
          threadId: thread.id,
          limit: 50,
        },
      ),
    ).toEqual([]);
  });
});
