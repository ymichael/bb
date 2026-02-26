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
});
