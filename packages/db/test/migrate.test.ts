import { describe, expect, it, vi } from "vitest";
import {
  createConnection,
  migrate,
  type DbConnection,
  type MigrationWarningLogger,
} from "../src/index.js";

type InsertMigrationParameters = [string, number];
type TableNameParameters = [string];

interface IndexNameRow {
  name: string;
}

interface MigrationCreatedAtRow {
  createdAt: number;
}

interface ReadIndexNamesArgs {
  db: DbConnection;
  tableName: string;
}

const baselineWhen = 1778891867195;
const publishedTerminalSessionUserInputWhen = 1779139400000;
const closedSessionPruneIndexesWhen = 1779139400001;
const threadDynamicContextFileStatesWhen = 1779139400002;

function closeConnection(db: DbConnection): void {
  db.$client.close();
}

function readIndexNames(args: ReadIndexNamesArgs): string[] {
  return args.db.$client
    .prepare<TableNameParameters, IndexNameRow>(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = ?
        ORDER BY name
      `,
    )
    .all(args.tableName)
    .map((row) => row.name);
}

describe("migrate", () => {
  it("warns when applied migration timestamps are in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(closedSessionPruneIndexesWhen + 10_000);

    const db = createConnection(":memory:");
    const logger = {
      warn: vi.fn(),
    } satisfies MigrationWarningLogger;

    try {
      migrate(db, { logger });
      expect(logger.warn).not.toHaveBeenCalled();

      const futureCreatedAt = Date.now() + 60_000;
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("future-migration-hash", futureCreatedAt);

      migrate(db, { logger });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        {
          migrations: [
            {
              createdAt: futureCreatedAt,
              hash: "future-migration-hash",
            },
          ],
          now: expect.any(Number),
        },
        "Applied database migrations have future timestamps",
      );
    } finally {
      closeConnection(db);
      vi.useRealTimers();
    }
  });

  it("applies 0002 after a database already applied main's 0001 timestamp", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);

      db.$client.prepare("DROP INDEX host_daemon_commands_session_idx").run();
      db.$client
        .prepare("DROP INDEX host_daemon_sessions_closed_prune_idx")
        .run();
      db.$client
        .prepare("DROP INDEX thread_dynamic_context_file_states_thread_file_idx")
        .run();
      db.$client.prepare("DROP TABLE thread_dynamic_context_file_states").run();
      db.$client.prepare("DELETE FROM __drizzle_migrations").run();
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("baseline-hash", baselineWhen);
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("main-0001-hash", publishedTerminalSessionUserInputWhen);

      expect(
        readIndexNames({ db, tableName: "host_daemon_commands" }),
      ).not.toContain("host_daemon_commands_session_idx");
      expect(
        readIndexNames({ db, tableName: "host_daemon_sessions" }),
      ).not.toContain("host_daemon_sessions_closed_prune_idx");

      migrate(db);

      expect(
        readIndexNames({ db, tableName: "host_daemon_commands" }),
      ).toContain("host_daemon_commands_session_idx");
      expect(
        readIndexNames({ db, tableName: "host_daemon_sessions" }),
      ).toContain("host_daemon_sessions_closed_prune_idx");

      const migrationCreatedAts = db.$client
        .prepare<[], MigrationCreatedAtRow>(
          `
            SELECT created_at AS createdAt
            FROM __drizzle_migrations
            ORDER BY created_at
          `,
        )
        .all()
        .map((row) => row.createdAt);
      expect(migrationCreatedAts).toContain(closedSessionPruneIndexesWhen);
      expect(migrationCreatedAts).toContain(
        threadDynamicContextFileStatesWhen,
      );
    } finally {
      closeConnection(db);
    }
  });
});
