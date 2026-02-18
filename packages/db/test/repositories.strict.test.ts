import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "../src/connection.js";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import {
  ProjectRepository,
  TaskRepository,
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
  let tasks: TaskRepository;
  let threads: ThreadRepository;
  let sqlite: SqliteClient;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    tasks = new TaskRepository(db);
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

  it("throws for invalid persisted thread role values", () => {
    const projectId = createProjectId();
    const task = tasks.create({
      projectId,
      title: "Task",
    });
    const thread = threads.create({
      projectId,
      taskId: task.id,
      taskRole: "worker",
    });
    sqlite.exec(`UPDATE threads SET task_role='lead' WHERE id='${thread.id}'`);

    expect(() => threads.getById(thread.id)).toThrow(
      "Invalid persisted task thread role: lead",
    );
  });

  it("persists and loads thread agent role metadata", () => {
    const projectId = createProjectId();
    const thread = threads.create({
      projectId,
      agentRoleId: "agent/generic",
    });

    expect(threads.getById(thread.id)).toMatchObject({
      id: thread.id,
      agentRoleId: "agent/generic",
    });
  });

  it("filters thread listings by agent role id", () => {
    const projectId = createProjectId();
    const genericThread = threads.create({
      projectId,
      agentRoleId: "agent/generic",
    });
    threads.create({
      projectId,
      agentRoleId: "agent/other",
    });

    expect(threads.list({ projectId, agentRoleId: "agent/generic" })).toEqual([
      expect.objectContaining({ id: genericThread.id, agentRoleId: "agent/generic" }),
    ]);
  });

  it("throws for invalid persisted task status values", () => {
    const projectId = createProjectId();
    const task = tasks.create({
      projectId,
      title: "Task",
    });
    sqlite.exec(`UPDATE tasks SET status='todo' WHERE id='${task.id}'`);

    expect(() => tasks.getById(task.id)).toThrow(
      "Invalid persisted task status: todo",
    );
  });

  it("includes description in task.created event payload when provided", () => {
    const projectId = createProjectId();
    const task = tasks.create({
      projectId,
      title: "Task",
      description: "Implements feature flags",
    });

    const createdEvent = tasks
      .listEvents(task.id)
      .find((event) => event.type === "task.created");
    expect(createdEvent).toMatchObject({
      type: "task.created",
      data: {
        projectId,
        title: "Task",
        description: "Implements feature flags",
      },
    });
  });

  it("throws for invalid persisted task close reason values", () => {
    const projectId = createProjectId();
    const task = tasks.create({
      projectId,
      title: "Task",
    });
    sqlite.exec(`UPDATE tasks SET close_reason='done' WHERE id='${task.id}'`);

    expect(() => tasks.getById(task.id)).toThrow(
      "Invalid persisted task close reason: done",
    );
  });

  it("throws for invalid persisted task dependency type values", () => {
    const projectId = createProjectId();
    const task = tasks.create({
      projectId,
      title: "Task",
    });
    const blocker = tasks.create({
      projectId,
      title: "Blocker",
    });
    sqlite.exec(
      "INSERT INTO task_dependencies (task_id, depends_on_task_id, type, created_at) " +
        `VALUES ('${task.id}', '${blocker.id}', 'unknown', 1)`,
    );

    expect(() => tasks.listDependencies(task.id)).toThrow(
      "Invalid persisted task dependency type: unknown",
    );
  });

  it("throws for invalid persisted task event type values", () => {
    const projectId = createProjectId();
    const task = tasks.create({
      projectId,
      title: "Task",
    });
    sqlite.exec(
      "INSERT INTO task_events (id, task_id, seq, type, data, created_at) " +
        `VALUES ('evt-invalid', '${task.id}', 999, 'task.chat.message_sent', '{}', 1)`,
    );

    expect(() => tasks.listEvents(task.id)).toThrow(
      "Invalid persisted task event type: task.chat.message_sent",
    );
  });
});
