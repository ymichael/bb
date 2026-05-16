import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repairMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0013_rebuild_pending_interactions.sql",
);

function repairMigrationHash(): string {
  return createHash("sha256")
    .update(readFileSync(repairMigrationPath))
    .digest("hex");
}

describe("migration repairs", () => {
  it("repairs drifted pending_interactions tables while preserving rows", () => {
    const db = createConnection(":memory:");
    migrate(db);

    db.$client
      .prepare(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_repair', 'Repair', 1, 1)",
      )
      .run();
    db.$client
      .prepare(
        "INSERT INTO threads (id, project_id, provider_id, status, latest_attention_at, created_at, updated_at) VALUES ('thr_repair', 'proj_repair', 'codex', 'idle', 1, 1, 1)",
      )
      .run();
    db.$client
      .prepare(
        `INSERT INTO pending_interactions (
          id,
          thread_id,
          turn_id,
          provider_id,
          provider_thread_id,
          provider_request_id,
          session_id,
          status,
          payload,
          created_at,
          updated_at
        ) VALUES (
          'pi_existing',
          'thr_repair',
          'turn_existing',
          'codex',
          'provider_thread_existing',
          'provider_request_existing',
          'session_existing',
          'pending',
          '{}',
          1,
          1
        )`,
      )
      .run();

    db.$client
      .prepare(
        "ALTER TABLE pending_interactions ADD COLUMN environment_id text NOT NULL DEFAULT 'env_drift'",
      )
      .run();
    const deletedMigration = db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE hash = ?")
      .run(repairMigrationHash());
    expect(deletedMigration.changes).toBe(1);

    migrate(db);

    const columnNames = db.$client
      .prepare("SELECT name FROM pragma_table_info('pending_interactions')")
      .pluck()
      .all();
    expect(columnNames).not.toContain("environment_id");
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "thread_id",
        "turn_id",
        "provider_id",
        "provider_thread_id",
        "provider_request_id",
        "session_id",
        "resolving_command_id",
        "status",
        "payload",
        "resolution",
        "status_reason",
        "created_at",
        "resolved_at",
        "updated_at",
      ]),
    );

    expect(
      db.$client
        .prepare("SELECT thread_id FROM pending_interactions WHERE id = ?")
        .pluck()
        .get("pi_existing"),
    ).toBe("thr_repair");

    const foreignKeys = db.$client
      .prepare(
        `SELECT "from" AS "from", "table" AS "table", "to" AS "to", on_update AS onUpdate, on_delete AS onDelete
        FROM pragma_foreign_key_list('pending_interactions')`,
      )
      .all();
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        {
          from: "thread_id",
          table: "threads",
          to: "id",
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
        },
        {
          from: "resolving_command_id",
          table: "host_daemon_commands",
          to: "id",
          onUpdate: "NO ACTION",
          onDelete: "SET NULL",
        },
      ]),
    );

    const indexes = db.$client
      .prepare(
        `SELECT name, "unique" AS "unique"
        FROM pragma_index_list('pending_interactions')`,
      )
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        { name: "pending_interactions_provider_request_idx", unique: 1 },
        { name: "pending_interactions_thread_created_idx", unique: 0 },
        { name: "pending_interactions_thread_status_created_idx", unique: 0 },
        { name: "pending_interactions_status_created_idx", unique: 0 },
        { name: "pending_interactions_resolving_command_idx", unique: 0 },
      ]),
    );
    expect(
      db.$client
        .prepare(
          "SELECT name FROM pragma_index_info('pending_interactions_provider_request_idx') ORDER BY seqno",
        )
        .pluck()
        .all(),
    ).toEqual([
      "session_id",
      "provider_id",
      "provider_thread_id",
      "provider_request_id",
    ]);

    db.$client
      .prepare(
        `INSERT INTO pending_interactions (
          id,
          thread_id,
          turn_id,
          provider_id,
          provider_thread_id,
          provider_request_id,
          session_id,
          status,
          payload,
          created_at,
          updated_at
        ) VALUES (
          'pi_new',
          'thr_repair',
          'turn_new',
          'codex',
          'provider_thread_new',
          'provider_request_new',
          'session_new',
          'pending',
          '{}',
          2,
          2
        )`,
      )
      .run();
    expect(
      db.$client
        .prepare("SELECT COUNT(*) FROM pending_interactions")
        .pluck()
        .get(),
    ).toBe(2);

    db.$client.close();
  });
});
