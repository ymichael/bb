import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "../src/connection.js";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import {
  EnvironmentRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
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
  let environments: EnvironmentRepository;
  let attachments: ThreadEnvironmentAttachmentRepository;
  let threads: ThreadRepository;
  let sqlite: SqliteClient;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    environments = new EnvironmentRepository(db);
    attachments = new ThreadEnvironmentAttachmentRepository(db);
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

  it("persists and loads first-class environments", () => {
    const projectId = createProjectId();
    const environment = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project",
      },
      managed: false,
    });

    expect(environments.getById(environment.id)).toEqual(environment);
  });

  it("lists first-class environments by project", () => {
    const projectId = createProjectId();
    const otherProjectId = projects.create({
      name: "other-project",
      rootPath: "/tmp/other-project",
    }).id;
    const kept = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project",
      },
      managed: false,
    });
    environments.create({
      projectId: otherProjectId,
      descriptor: {
        type: "path",
        path: "/tmp/other-project",
      },
      managed: true,
    });

    expect(environments.list({ projectId })).toEqual([kept]);
  });

  it("finds first-class environments by project and descriptor", () => {
    const projectId = createProjectId();
    const descriptor = {
      type: "path" as const,
      path: "/tmp/test-project",
    };
    const environment = environments.create({
      projectId,
      descriptor,
      managed: false,
    });

    expect(
      environments.findByProjectDescriptor({
        projectId,
        descriptor,
      }),
    ).toEqual(environment);
  });

  it("updates first-class environment descriptors and managed state", () => {
    const projectId = createProjectId();
    const environment = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project",
      },
      managed: false,
    });

    const updated = environments.update(environment.id, {
      descriptor: {
        type: "path",
        path: "/tmp/test-project/.worktrees/thread-1",
      },
      managed: true,
    });

    expect(updated).toMatchObject({
      id: environment.id,
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project/.worktrees/thread-1",
      },
      managed: true,
    });
  });

  it("throws for invalid persisted environment descriptor values", () => {
    const projectId = createProjectId();
    const environment = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project",
      },
      managed: false,
    });
    sqlite.exec("PRAGMA ignore_check_constraints = ON");
    sqlite.exec(
      `UPDATE environments SET descriptor='{\"type\":\"container_path\"}' WHERE id='${environment.id}'`,
    );

    expect(() => environments.getById(environment.id)).toThrow(
      "Invalid persisted environment descriptor type: container_path",
    );
  });

  it("attaches threads to first-class environments", () => {
    const projectId = createProjectId();
    const environment = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project",
      },
      managed: false,
    });
    const thread = threads.create({ projectId });

    const attached = attachments.attachThread({
      threadId: thread.id,
      environmentId: environment.id,
    });

    expect(attached).toMatchObject({
      threadId: thread.id,
      environmentId: environment.id,
    });
    expect(attachments.getByThreadId(thread.id)).toEqual(attached);
    expect(attachments.listByEnvironmentId(environment.id)).toEqual([attached]);
  });

  it("updates thread environment attachments in place", () => {
    const projectId = createProjectId();
    const first = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project",
      },
      managed: false,
    });
    const second = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/test-project/.worktrees/thread-1",
      },
      managed: true,
    });
    const thread = threads.create({ projectId });

    const initial = attachments.attachThread({
      threadId: thread.id,
      environmentId: first.id,
    });
    const updated = attachments.attachThread({
      threadId: thread.id,
      environmentId: second.id,
    });

    expect(updated.threadId).toBe(thread.id);
    expect(updated.environmentId).toBe(second.id);
    expect(updated.createdAt).toBe(initial.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(initial.updatedAt);
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

  it("lists non-archived thread ids for targeted status sets", () => {
    const projectId = createProjectId();
    const provisioning = threads.create({ projectId });
    threads.update(provisioning.id, { status: "provisioning" });

    const provisioned = threads.create({ projectId });
    threads.update(provisioned.id, { status: "provisioned" });

    const archived = threads.create({ projectId });
    threads.update(archived.id, {
      status: "provisioned",
      archivedAt: Date.now(),
    });

    expect(
      threads.listNonArchivedIdsByStatuses(["provisioning", "provisioned"]).sort(),
    ).toEqual([provisioning.id, provisioned.id].sort());
  });

  it("lists archived thread ids using indexed environment ownership", () => {
    const projectId = createProjectId();
    const archivedWithEnvironment = threads.create({
      projectId,
      environmentId: "worktree",
      environmentRecord: {
        kind: "worktree",
        state: {},
      },
    });
    threads.update(archivedWithEnvironment.id, {
      archivedAt: Date.now(),
    });

    const archivedWithoutEnvironment = threads.create({
      projectId,
      environmentRecord: {
        kind: "worktree",
        state: {},
      },
    });
    threads.update(archivedWithoutEnvironment.id, {
      archivedAt: Date.now(),
    });

    expect(threads.listArchivedIdsWithEnvironmentRecord()).toEqual([
      archivedWithEnvironment.id,
    ]);
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
