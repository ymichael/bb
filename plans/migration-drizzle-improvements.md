# Migration & Drizzle Improvements

## Goal

Replace the current 48 incremental migrations with a single baseline migration, and switch to Drizzle Kit-generated migrations going forward so the Drizzle schema is the single source of truth. Eliminate brittleness before v1 so users never have to drop their DBs.

## Scope

- Squash all 48 migrations into one baseline
- Ensure Drizzle Kit `generate` works correctly from the current schema
- Clean up the migration runner (`migrate.ts`)
- Validate that in-memory test DBs work with the new baseline
- Establish the workflow for future schema changes

Out of scope: Postgres support, multi-database, data migrations for existing dev DBs (pre-launch, devs start fresh).

## Implementation Steps

### Step 1: Verify schema ↔ migration parity

Before squashing, confirm the Drizzle schema (`packages/db/src/schema.ts`) matches what the 48 migrations produce.

1. Create a fresh DB by running all 48 migrations against `:memory:`
2. Dump the resulting schema (`PRAGMA table_info`, `PRAGMA foreign_key_list`, `PRAGMA index_list` for each table)
3. Run `drizzle-kit generate` from the current Drizzle schema and compare the output SQL against the dumped schema
4. Fix any drift — the Drizzle schema is the authority; if migrations diverged, the squashed baseline must match the Drizzle schema

### Step 2: Generate the baseline migration

1. **Delete all 48 migration files** in `packages/db/drizzle/` (SQL files + `meta/_journal.json` + snapshot files)
2. Run `pnpm --filter @bb/db db:generate` (or `drizzle-kit generate`) to produce a single `0000_*.sql` baseline
3. Review the generated SQL:
   - All 8 tables created with correct columns, types, defaults
   - All foreign key constraints with correct CASCADE/SET NULL actions
   - All indexes present
   - No leftover artifacts from incremental migrations (temp tables, renames)
4. If `drizzle-kit generate` doesn't produce clean output (it sometimes generates incremental-style SQL), hand-write the baseline using clean `CREATE TABLE` + `CREATE INDEX` statements derived from the schema

### Step 3: Clean up the migration runner

Current `migrate.ts` does:
- Resolve migrations folder (handles src/ vs dist/ paths)
- Disable FK constraints during migration
- Run drizzle migrate
- Re-enable FK constraints
- Check for FK violations

Simplify:
1. **Keep the FK disable/enable pattern** — this is still needed for SQLite table rebuilds in future migrations
2. **Keep the FK violation check** — good safety net
3. **Remove any migration-specific workarounds** if they exist (e.g., special handling for specific migration numbers)
4. **Verify the migrations folder resolution** still works with the new single-file layout

### Step 4: Update drizzle.config.ts

1. Ensure `out` points to `./drizzle/` (the migration output directory)
2. Ensure `schema` points to `./src/schema.ts`
3. Update any `~/.beanbag` path references to `~/.bb` (part of the rename plan)
4. Verify `drizzle-kit generate` uses this config correctly

### Step 5: Validate

1. **In-memory DB test**: `createConnection(":memory:")` + `migrate(db)` — must produce a working DB with all tables, FKs, and indexes
2. **Unit tests**: Run full `packages/db/test/` suite
3. **Daemon integration tests**: Run `apps/daemon/src/__tests__/` suite — these create in-memory DBs via test factories
4. **E2E tests**: Run the e2e suite to confirm daemon startup + migration works
5. **Fresh file DB**: Start daemon with a new `--db` path, confirm it creates a working DB from scratch
6. **FK integrity**: After migration, run `PRAGMA foreign_key_check` — must return empty

### Step 6: Establish the future workflow

Document in the db package README or a comment in schema.ts:

**To make a schema change:**
1. Edit `packages/db/src/schema.ts`
2. Run `pnpm --filter @bb/db db:generate` — Drizzle Kit generates a new migration SQL file
3. Review the generated SQL — Drizzle Kit sometimes generates suboptimal SQLite migrations (unnecessary table rebuilds). Edit if needed.
4. Run tests to validate
5. Commit both the schema change and the migration file

**Rules:**
- Never hand-write migration SQL unless Drizzle Kit output is incorrect
- Never modify the schema without generating a corresponding migration
- The Drizzle schema in `schema.ts` is the single source of truth
- Migration files are append-only (never edit a shipped migration)

## Validation

1. All existing tests pass with the single baseline migration
2. `drizzle-kit generate` produces no diff when run against a DB created by the baseline (schema and migrations are in sync)
3. Daemon starts cleanly with a fresh DB
4. `PRAGMA foreign_key_check` returns no violations
5. `PRAGMA integrity_check` returns `ok`

## Open Questions/Risks

- **Drizzle Kit SQLite quality**: Drizzle Kit's SQLite migration generation can be quirky — it sometimes generates table rebuild migrations even for simple column additions. Worth testing with a sample schema change after the squash to see if the output is acceptable. If not, we may need to hand-review generated migrations before committing (which is fine, just needs to be part of the workflow).
- **Snapshot files**: Drizzle Kit uses snapshot JSON files in `drizzle/meta/` to track schema state for diffing. After the squash, there will be one snapshot. Future `generate` calls diff against this snapshot. Make sure the snapshot is committed.
- **Dev DB reset**: After this lands, all devs need to delete their local `~/.bb/bb.db` (or `~/.beanbag/beanbag.db`) and let the daemon recreate it. This is fine pre-launch.
