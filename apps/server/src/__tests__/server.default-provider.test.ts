import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  migrate,
  ProjectRepository,
  ThreadRepository,
  EventRepository,
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
  EnvironmentDaemonSessionRepository,
  EnvironmentDaemonCursorRepository,
  EnvironmentDaemonCommandRepository,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import { createServer } from "../server.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

describe("createServer default provider", () => {
  let sqlite: SqliteClient | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("uses BB_DEFAULT_PROVIDER from the runtime env when seeding the default provider", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);

    const { threadManager, close } = createServer({
      projectRepo: new ProjectRepository(db),
      environmentRepo: new EnvironmentRepository(db),
      threadEnvironmentAttachmentRepo: new ThreadEnvironmentAttachmentRepository(db),
      threadRepo: new ThreadRepository(db),
      eventRepo: new EventRepository(db),
      environmentDaemonSessionRepo: new EnvironmentDaemonSessionRepository(db),
      environmentDaemonCursorRepo: new EnvironmentDaemonCursorRepository(db),
      environmentDaemonCommandRepo: new EnvironmentDaemonCommandRepository(db),
      runtimeEnv: {
        ...process.env,
        BB_DEFAULT_PROVIDER: "pi",
      },
      dbPath: ":memory:",
      serverLogFilePath: "/tmp/bb-server-default-provider.log",
    });

    await expect(threadManager.getProviderInfo()).resolves.toMatchObject({ id: "pi" });
    close();
  });
});
