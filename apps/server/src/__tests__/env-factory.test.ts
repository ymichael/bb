import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, migrate, EnvironmentRepository, ProjectRepository, ThreadEnvironmentAttachmentRepository, ThreadRepository, type DbConnection } from "@bb/db";
import { EnvironmentFactory } from "../env-factory.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

describe("EnvironmentFactory", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let threads: ThreadRepository;
  let environments: EnvironmentRepository;
  let attachments: ThreadEnvironmentAttachmentRepository;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    threads = new ThreadRepository(db);
    environments = new EnvironmentRepository(db);
    attachments = new ThreadEnvironmentAttachmentRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("stores authoritative properties when reserving a managed environment", () => {
    const project = projects.create({
      name: "factory-project",
      rootPath: "/tmp/factory-project",
    });
    const thread = threads.create({ projectId: project.id });
    const factory = new EnvironmentFactory(environments, attachments);

    const environmentId = factory.reserveThreadEnvironment({
      threadId: thread.id,
      projectId: project.id,
      projectRootPath: project.rootPath,
      environmentCreationArgs: {
        kind: "docker",
      },
    });

    expect(environmentId).toBeDefined();
    expect(environmentId && environments.getById(environmentId)).toMatchObject({
      projectId: project.id,
      managed: true,
      properties: {
        provisioningSystemKind: "docker-worktree",
        location: "docker",
        workspaceKind: "arbitrary_path",
      },
    });
    expect(environmentId && environments.getById(environmentId)?.descriptor).toBeUndefined();
  });

  it("creates a thread_environment_attachment row when reserving", () => {
    const project = projects.create({
      name: "factory-attach-project",
      rootPath: "/tmp/factory-attach-project",
    });
    const thread = threads.create({ projectId: project.id });
    const factory = new EnvironmentFactory(environments, attachments);

    const environmentId = factory.reserveThreadEnvironment({
      threadId: thread.id,
      projectId: project.id,
      projectRootPath: project.rootPath,
      environmentCreationArgs: {
        kind: "worktree",
      },
    });

    expect(environmentId).toBeDefined();
    const attachment = attachments.getByThreadId(thread.id);
    expect(attachment).toMatchObject({
      threadId: thread.id,
      environmentId,
    });
  });

  it("creates a distinct managed environment for each reservation request", () => {
    const project = projects.create({
      name: "factory-shared-project",
      rootPath: "/tmp/factory-shared-project",
    });
    const thread1 = threads.create({ projectId: project.id });
    const thread2 = threads.create({ projectId: project.id });
    const factory = new EnvironmentFactory(environments, attachments);

    const envId1 = factory.reserveThreadEnvironment({
      threadId: thread1.id,
      projectId: project.id,
      projectRootPath: project.rootPath,
      environmentCreationArgs: {
        kind: "worktree",
      },
    });

    const envId2 = factory.reserveThreadEnvironment({
      threadId: thread2.id,
      projectId: project.id,
      projectRootPath: project.rootPath,
      environmentCreationArgs: {
        kind: "worktree",
      },
    });

    expect(envId1).toBeDefined();
    expect(envId2).toBeDefined();
    expect(envId1).not.toBe(envId2);
    expect(attachments.getByThreadId(thread1.id)).toMatchObject({
      threadId: thread1.id,
      environmentId: envId1,
    });
    expect(attachments.getByThreadId(thread2.id)).toMatchObject({
      threadId: thread2.id,
      environmentId: envId2,
    });
  });
});
