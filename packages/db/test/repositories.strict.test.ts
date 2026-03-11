import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "../src/connection.js";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import {
  ProjectRepository,
  ThreadRepository,
} from "../src/repositories.js";

interface SqliteClient {
  exec(sql: string): unknown;
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

describe("repository strict normalization", () => {
  let db: DbConnection;
  let projects: ProjectRepository;
  let threads: ThreadRepository;
  let sqlite: SqliteClient;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    threads = new ThreadRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createProjectId(): string {
    return projects.create({
      name: "test-project",
      rootPath: "/tmp/test-project",
    }).id;
  }

  it("throws for invalid persisted thread status values", () => {
    const projectId = createProjectId();
    const thread = threads.create({ projectId });
    sqlite.exec("PRAGMA ignore_check_constraints = ON");
    sqlite.exec(`UPDATE threads SET status='running' WHERE id='${thread.id}'`);

    expect(() => threads.getById(thread.id)).toThrow(
      "Invalid persisted thread status: running",
    );
  });

  it("persists and loads parent thread metadata", () => {
    const projectId = createProjectId();
    const thread = threads.create({
      projectId,
      parentThreadId: "parent-1",
    });

    expect(threads.getById(thread.id)).toMatchObject({
      id: thread.id,
      parentThreadId: "parent-1",
    });
  });

  it("persists and clears per-thread merge-base overrides without touching updatedAt", () => {
    const projectId = createProjectId();
    const thread = threads.create({ projectId });

    sqlite.exec(`UPDATE threads SET updated_at=${thread.updatedAt + 5000} WHERE id='${thread.id}'`);

    const withOverride = threads.update(
      thread.id,
      { mergeBaseBranchOverride: "release/1.0" },
      { touchUpdatedAt: false },
    );
    expect(withOverride).toMatchObject({
      id: thread.id,
      mergeBaseBranchOverride: "release/1.0",
      updatedAt: thread.updatedAt + 5000,
    });

    const clearedOverride = threads.update(
      thread.id,
      { mergeBaseBranchOverride: null },
      { touchUpdatedAt: false },
    );
    expect(clearedOverride).toMatchObject({
      id: thread.id,
      mergeBaseBranchOverride: undefined,
      updatedAt: thread.updatedAt + 5000,
    });
  });

  it("persists and loads project primary checkout pointers without touching updatedAt", () => {
    const project = projects.create({
      name: "test-project",
      rootPath: "/tmp/test-project",
    });

    sqlite.exec(`UPDATE projects SET updated_at=${project.updatedAt + 5000} WHERE id='${project.id}'`);

    const updated = projects.update(
      project.id,
      { primaryCheckoutThreadId: "thread-1" },
      { touchUpdatedAt: false },
    );

    expect(updated).toMatchObject({
      id: project.id,
      primaryCheckoutThreadId: "thread-1",
      updatedAt: project.updatedAt + 5000,
    });
  });

  it("persists and loads thread environment ownership", () => {
    const projectId = createProjectId();
    const thread = threads.create({
      projectId,
      environmentId: "worktree",
    });

    expect(threads.getById(thread.id)).toMatchObject({
      id: thread.id,
      environmentId: "worktree",
    });
  });

  it("lists only non-archived active threads with persisted environments", () => {
    const projectId = createProjectId();
    const active = threads.create({
      projectId,
      environmentId: "worktree",
      environmentRecord: {
        kind: "worktree",
        state: {},
      },
    });
    threads.update(active.id, { status: "active" });

    const idle = threads.create({
      projectId,
      environmentId: "worktree",
      environmentRecord: {
        kind: "worktree",
        state: {},
      },
    });
    threads.update(idle.id, { status: "idle" });

    const archived = threads.create({
      projectId,
      environmentId: "worktree",
      environmentRecord: {
        kind: "worktree",
        state: {},
      },
    });
    threads.update(archived.id, {
      status: "active",
      archivedAt: Date.now(),
    });

    expect(threads.listNonArchivedActiveIdsWithEnvironmentRecord()).toEqual([active.id]);
  });

  it("filters thread listings by parent thread id", () => {
    const projectId = createProjectId();
    const childThread = threads.create({
      projectId,
      parentThreadId: "parent-1",
    });
    threads.create({
      projectId,
      parentThreadId: "parent-2",
    });

    expect(threads.list({ projectId, parentThreadId: "parent-1" })).toEqual([
      expect.objectContaining({ id: childThread.id, parentThreadId: "parent-1" }),
    ]);
  });

  it("creates thread records with lastReadAt initialized", () => {
    const projectId = createProjectId();
    const thread = threads.create({ projectId });

    expect(thread.lastReadAt).toBeTypeOf("number");
    expect(thread.lastReadAt).toBeGreaterThan(0);
  });

  it("marks a thread as read without changing updatedAt", () => {
    const projectId = createProjectId();
    const thread = threads.create({ projectId });

    sqlite.exec(
      `UPDATE threads SET updated_at=${thread.updatedAt + 5000}, last_read_at=${thread.lastReadAt ?? 0} WHERE id='${thread.id}'`,
    );

    const before = threads.getById(thread.id);
    expect(before).toBeDefined();

    const marked = threads.markRead(thread.id, before!.updatedAt);
    expect(marked).toBeDefined();
    expect(marked!.lastReadAt).toBe(before!.updatedAt);
    expect(marked!.updatedAt).toBe(before!.updatedAt);
  });

  it("persists queued follow-up messages in FIFO order", () => {
    const projectId = createProjectId();
    const thread = threads.create({ projectId });

    const first = threads.enqueueQueuedMessage(thread.id, {
      input: [{ type: "text", text: "first" }],
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
    });
    const second = threads.enqueueQueuedMessage(thread.id, {
      input: [{ type: "text", text: "second" }],
      reasoningLevel: "high",
      sandboxMode: "workspace-write",
    });

    expect(threads.listQueuedMessages(thread.id).map((queued) => queued.id)).toEqual([
      first.id,
      second.id,
    ]);

    expect(threads.getById(thread.id)?.queuedMessages?.map((queued) => queued.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("deletes queued follow-up messages by id", () => {
    const projectId = createProjectId();
    const thread = threads.create({ projectId });
    const queued = threads.enqueueQueuedMessage(thread.id, {
      input: [{ type: "text", text: "queued item" }],
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
    });

    expect(threads.deleteQueuedMessage(thread.id, queued.id)).toBe(true);
    expect(threads.deleteQueuedMessage(thread.id, queued.id)).toBe(false);
    expect(threads.listQueuedMessages(thread.id)).toHaveLength(0);
  });
});
