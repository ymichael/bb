import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("__sqliteReadQueueTest", true);
import { createConnection, type DbConnection } from "../src/connection.js";
import { upsertHost } from "../src/data/hosts.js";
import { createProject } from "../src/data/projects.js";
import {
  createThread,
  listThreadsWithPendingInteractionState,
  listThreadsWithPendingInteractionStateForProjects,
} from "../src/data/threads.js";
import { migrate } from "../src/migrate.js";
import { noopNotifier } from "../src/notifier.js";
import {
  isSqliteReadWorkerActive,
  listThreadsWithPendingInteractionStateForProjectsOffThread,
  listThreadsWithPendingInteractionStateOffThread,
  startSqliteReadWorker,
  stopSqliteReadWorker,
} from "../src/sqlite-read-queue.js";

const tempDirs: string[] = [];
const connections: DbConnection[] = [];

afterEach(async () => {
  await stopSqliteReadWorker();
  while (connections.length > 0) {
    connections.pop()?.$client.close();
  }
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function createFileDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "bb-sqlite-read-queue-"));
  tempDirs.push(directory);
  const source = join(directory, "bb.db");
  const db = createConnection(source);
  connections.push(db);
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, source, thread };
}

describe("sqlite read queue", () => {
  it("keeps in-memory reads on the calling connection", async () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    startSqliteReadWorker({ source: ":memory:" });

    expect(isSqliteReadWorkerActive()).toBe(false);
    await expect(
      listThreadsWithPendingInteractionStateOffThread(db, {}),
    ).resolves.toEqual(listThreadsWithPendingInteractionState(db, {}));
  });

  it("returns the same thread list from a file-backed worker as the serving connection", async () => {
    const { db, project, source, thread } = createFileDatabase();
    startSqliteReadWorker({ source });

    expect(isSqliteReadWorkerActive()).toBe(true);

    const fromWorker = await listThreadsWithPendingInteractionStateOffThread(
      db,
      { projectId: project.id },
    );
    const fromServing = listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
    });
    const fromProjectsWorker =
      await listThreadsWithPendingInteractionStateForProjectsOffThread(db, {
        archived: false,
        projectIds: [project.id],
      });
    const fromProjectsServing =
      listThreadsWithPendingInteractionStateForProjects(db, {
        archived: false,
        projectIds: [project.id],
      });

    expect(fromWorker.map((row) => row.id)).toEqual([thread.id]);
    expect(fromWorker).toEqual(fromServing);
    expect(fromProjectsWorker).toEqual(fromProjectsServing);
  });
});
