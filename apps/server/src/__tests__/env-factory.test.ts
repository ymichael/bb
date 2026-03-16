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

  it("stores the requested runtime kind when reserving a managed environment", () => {
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
      requestedEnvironmentId: "docker",
    });

    expect(environmentId).toBeDefined();
    expect(environmentId && environments.getById(environmentId)).toMatchObject({
      projectId: project.id,
      managed: true,
      requestedRuntimeKind: "docker",
      descriptor: {
        type: "path",
        path: project.rootPath,
      },
    });
  });
});
