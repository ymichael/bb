# Rename .beanbag to .bb + Concept Renames

## Goal

Eliminate all `beanbag` / `BEANBAG_` naming from the codebase in favor of `bb` / `BB_`, and rename confusingly-named packages while we're touching everything. No backward compatibility, no fallbacks — clean break before v1 launch.

## Scope

- Package names: `@beanbag/*` → `@bb/*`
- Package/directory renames: `daemon` → `server`, `environment-agent` → `environment-daemon`
- Env vars: all `BEANBAG_*` → `BB_*`
- Home directory: `~/.beanbag` → `~/.bb`
- Internal variable/function names referencing "beanbag"
- Documentation, scripts, configs, tests

Also included (low marginal cost while touching everything):
- Package rename: `agent-core` → `core` (it's the shared foundation, "agent" prefix adds nothing)
- API route standardization: resolve `env-daemon` vs `environment-agent` inconsistency
- DB table renames: `environment_agent_*` → `environment_daemon_*` (coordinated with migration squash plan)
- User-facing string cleanup: remove internal jargon from CLI output
- Log/artifact path renames: `daemon.log` → `server.log`, PID file rename

Kept as-is (naming has clear lineage):
- `agent-server` package name — matches Codex "app-server" convention, name is accurate
- `AgentServer` class — same reasoning, no rename needed

Out of scope: npm publishing (not published yet), external API contracts (none exist).

## Implementation Steps

### Phase 1: Package names (`@beanbag/*` → `@bb/*`)

This must be atomic — all packages rename together or nothing works.

1. **Rename all 13 `package.json` `name` fields** from `@beanbag/<pkg>` to `@bb/<pkg>`, applying directory renames at the same time (see Phase 1b)
   - `apps/app`, `apps/cli`, `apps/daemon` → `apps/server`
   - `packages/agent-core` → `packages/core`, `packages/agent-server`, `packages/claude-code-bridge`, `packages/db`, `packages/environment`, `packages/environment-agent` → `packages/environment-daemon`, `packages/pi-bridge`, `packages/templates`, `packages/tsconfig`, `packages/ui-core`
2. **Rename root `package.json`** from `"beanbag"` to `"bb"`
3. **Update all `workspace:*` dependency declarations** in every `package.json`
4. **Update all TypeScript imports** across ~215 source/test files (`@beanbag/foo` → `@bb/foo`, `@beanbag/daemon` → `@bb/server`, `@beanbag/agent-core` → `@bb/core`, `@beanbag/environment-agent` → `@bb/environment-daemon`)
5. **Update tsconfig `paths`** in all `tsconfig.json` files (apps + packages)
6. **Update vitest workspace aliases** in `vitest.workspace-aliases.ts` and per-app `vitest.config.ts` files
7. **Update `turbo.json`** if any explicit `@beanbag/` references exist in task filters
8. **Delete `pnpm-lock.yaml`**, run `pnpm install` to regenerate
9. **Run `pnpm exec turbo run typecheck`** — must pass clean

### Phase 1b: Directory renames (`daemon` → `server`, `environment-agent` → `environment-daemon`)

Do these as part of Phase 1 (same atomic rename pass) since they affect the same package.json / import graph.

**`apps/daemon/` → `apps/server/`**

Rationale: "Daemon" is an implementation detail. "Server" is what users and the CLI interact with. `bb server start` reads better than `bb daemon start`.

1. `git mv apps/daemon apps/server`
2. Package name: `@bb/daemon` → `@bb/server`
3. Update all imports of `@beanbag/daemon` / `@bb/daemon` → `@bb/server`
4. Update turbo filters: `--filter=@bb/daemon` → `--filter=@bb/server`
5. Update `pnpm-workspace.yaml` if it lists explicit paths
6. Update any `apps/daemon` path references in tsconfig, vitest, scripts
7. Update CLI user-facing strings: any "daemon" language in help text, error messages → "server"
8. Update the dev supervisor script path: `apps/daemon/scripts/` → `apps/server/scripts/`

**`packages/environment-agent/` → `packages/environment-daemon/`**

Rationale: This is a long-running process that manages environments, not an AI agent. "Environment daemon" avoids confusion with the AI agents that are bb's core product.

1. `git mv packages/environment-agent packages/environment-daemon`
2. Package name: `@bb/environment-agent` → `@bb/environment-daemon`
3. Update all imports of `@beanbag/environment-agent` / `@bb/environment-agent` → `@bb/environment-daemon`
4. Update internal type/variable names if they reference "environment agent" in a confusing way (use judgment — some are fine, e.g. `EnvironmentAgentSession` in the DB schema refers to the protocol, not the package)
5. Update turbo filters, tsconfig paths, vitest configs

**`packages/agent-core/` → `packages/core/`**

Rationale: "Agent" prefix adds nothing — this is the shared types/contracts/schemas package that everything depends on. `@bb/core` is clearer and shorter.

1. `git mv packages/agent-core packages/core`
2. Package name: `@bb/agent-core` → `@bb/core`
3. Update all imports of `@beanbag/agent-core` → `@bb/core`
4. Update turbo filters, tsconfig paths, vitest configs

**Env var prefix update** (folded into Phase 2):
- `BEANBAG_ENVIRONMENT_AGENT_*` → `BB_ENV_DAEMON_*` (shorter, matches new package name)
- This is a natural fit since Phase 2 is already renaming all `BEANBAG_*` vars

### Phase 1c: API route standardization

There's an inconsistency in thread routes — most use `/env-daemon/` but one uses `/environment-agent/`. Standardize now.

1. **Audit all routes in `apps/server/src/routes/threads.ts`** for env-daemon/environment-agent references
2. **Standardize to `/env-daemon/`** for all environment daemon routes (short, matches the new package name's abbreviation)
3. **Update the CLI client** (`apps/cli/`) — any Hono client calls that reference these routes
4. **Update the web app** (`apps/app/`) — any API calls to these routes
5. **Update QA docs** that reference specific route paths

### Phase 1d: DB table/column renames (coordinate with migration squash)

Since the migration squash plan (`migration-drizzle-improvements.md`) is already creating a fresh baseline, rename these tables at zero cost:

1. **In `packages/db/src/schema.ts`**, rename:
   - `environmentAgentSessions` → `environmentDaemonSessions` (table: `environment_daemon_sessions`)
   - `environmentAgentCursors` → `environmentDaemonCursors` (table: `environment_daemon_cursors`)
   - `environmentAgentCommands` → `environmentDaemonCommands` (table: `environment_daemon_commands`)
2. **Update all repository/query code** that references these table names
3. **Update all TypeScript types** derived from these tables (`EnvironmentAgentSession` → `EnvironmentDaemonSession`, etc.)
4. The squashed baseline migration will naturally use the new table names — no extra migration needed

### Phase 2: Environment variables (`BEANBAG_*` → `BB_*`)

17 unique `BEANBAG_*` vars to rename across ~51 files.

1. **Core config vars** — rename and update all references:
   - `BEANBAG_ROOT` → `BB_ROOT` (already exists, remove fallback)
   - `BEANBAG_DB_PATH` → `BB_DB_PATH`
   - `BEANBAG_ENVIRONMENT` → `BB_ENVIRONMENT`
   - `BEANBAG_WORKTREE_ROOT` → `BB_WORKTREE_ROOT`
   - `BEANBAG_PROVIDER` → remove entirely (already superseded by `BB_E2E_PROVIDER`)
   - `BEANBAG_DEBUG_PERF` → `BB_DEBUG_PERF`

2. **Environment daemon vars** — rename the 13 `BEANBAG_ENVIRONMENT_AGENT_*` and `BEANBAG_ENV_AGENT_*` vars to use the shorter `BB_ENV_DAEMON_*` prefix (matches the `environment-daemon` package rename):
   - `BEANBAG_ENV_AGENT_LEASE_TTL_MS` → `BB_ENV_DAEMON_LEASE_TTL_MS`
   - `BEANBAG_ENV_AGENT_HEARTBEAT_INTERVAL_MS` → `BB_ENV_DAEMON_HEARTBEAT_INTERVAL_MS`
   - `BEANBAG_ENV_AGENT_COMMAND_LONG_POLL_TIMEOUT_MS` → `BB_ENV_DAEMON_COMMAND_LONG_POLL_TIMEOUT_MS`
   - `BEANBAG_ENV_AGENT_COMMAND_LONG_POLL_INTERVAL_MS` → `BB_ENV_DAEMON_COMMAND_LONG_POLL_INTERVAL_MS`
   - `BEANBAG_ENV_AGENT_LEASE_SWEEP_INTERVAL_MS` → `BB_ENV_DAEMON_LEASE_SWEEP_INTERVAL_MS`
   - `BEANBAG_ENV_AGENT_STARTUP_RECOVERY_REQUEST_TIMEOUT_MS` → `BB_ENV_DAEMON_STARTUP_RECOVERY_REQUEST_TIMEOUT_MS`
   - `BEANBAG_ENVIRONMENT_AGENT_BASE_URL` → `BB_ENV_DAEMON_BASE_URL`
   - `BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN` → `BB_ENV_DAEMON_AUTH_TOKEN`
   - (and remaining `BEANBAG_ENVIRONMENT_AGENT_*` vars → `BB_ENV_DAEMON_*`)

3. **Test/dev vars**:
   - `BEANBAG_FAKE_CODEX_*` → `BB_FAKE_CODEX_*`
   - `BEANBAG_SUPERVISED_RESTART` → `BB_SUPERVISED_RESTART`
   - `BEANBAG_TEST_TMP_ROOT` → `BB_TEST_TMP_ROOT`
   - `BEANBAG_MANAGED_ARTIFACT_SWEEP_INTERVAL_MS` → `BB_MANAGED_ARTIFACT_SWEEP_INTERVAL_MS`

4. **Provider command vars**:
   - `BEANBAG_CLAUDE_PROVIDER_COMMAND` → `BB_CLAUDE_PROVIDER_COMMAND`
   - `BEANBAG_PI_PROVIDER_COMMAND` → `BB_PI_PROVIDER_COMMAND`

5. **Docker vars**:
   - `BEANBAG_DOCKER_DAEMON_HOST` → `BB_DOCKER_DAEMON_HOST`
   - `BEANBAG_DOCKER_IMAGE` → `BB_DOCKER_IMAGE`
   - `BEANBAG_GIT_COMMAND` → `BB_GIT_COMMAND`

6. **Delete all fallback/dual-support logic** in:
   - `packages/agent-core/src/storage-paths.ts` — remove `BEANBAG_ROOT` fallback, remove deprecation warning
   - `packages/agent-server/src/provider-registry.ts` — remove `BEANBAG_PROVIDER` fallback

### Phase 3: Home directory path (`~/.beanbag` → `~/.bb`)

1. **Update `storage-paths.ts`** line 30: `resolve(homedir(), ".beanbag")` → `resolve(homedir(), ".bb")`
2. **Update `drizzle.config.ts`** default path fallback
3. **Update `.env.example`** — all path references and comments
4. **Update `.env`** if it has any hardcoded paths

### Phase 4: Internal naming cleanup

1. **Rename functions/variables** that reference "beanbag":
   - `resolveBeanbagRoot()` → `resolveBbRoot()` (or `resolveRoot()`)
   - `resolveBeanbagPath()` → `resolveBbPath()` (or `resolvePath()`)
   - `BEANBAG_ROOT_ENV` constant → remove (already have `BB_ROOT_ENV`)
   - Any `beanbagRoot` local variables in scripts
2. **Rename internal references to "daemon" where user-facing**:
   - CLI help text / command names that say "daemon" → "server"
   - Log messages, error messages visible to users
   - PID file: `agent-server.pid` → `bb-server.pid`
   - Log path: `logs/daemon.log` → `logs/server.log`
   - Leave internal code identifiers (class names, function names) as-is unless they're confusing — this is a naming cleanup, not a rewrite
3. **Clean up user-facing CLI output**:
   - Replace "env-daemon" in CLI help text and console output with user-friendly terms (e.g., "environment sessions" not "env-daemon sessions")
   - Route names stay technical (`/env-daemon/`), but user-facing descriptions should be approachable
   - Audit `apps/cli/src/commands/thread.ts` for any "env-daemon" in description strings or console.log output
4. **Update QA scripts** (`scripts/qa/*.mjs`) — internal variable names + env var references
5. **Update dev scripts** (`apps/server/scripts/dev-supervisor.mjs`)

### Phase 5: Documentation & config files

1. **README.md** — all path/env var references
2. **ARCHITECTURE.md** — env var references
3. **QA docs** (`qa/daemon/*.md`, `qa/artifacts/README.md`)
4. **Plans** that reference `.beanbag` paths (can update or leave as historical)
5. **`.env.example`** — full pass on all comments and values
6. **`.github/workflows/ci.yml`** — check for any env var references
7. **AGENTS.md** — check for any references

## Validation

1. `pnpm install` succeeds (lockfile regenerates cleanly)
2. `pnpm exec turbo run typecheck` passes across all packages
3. `pnpm exec turbo run test` passes (all unit + integration tests)
4. Manual smoke: start server, confirm it creates `~/.bb/` (not `~/.beanbag/`)
5. Grep for any remaining `beanbag` (case-insensitive) — should be zero hits outside git history and plans
6. Grep for any remaining `BEANBAG_` — should be zero hits
7. Verify CLI `bb server start` / `bb server stop` works (if commands were renamed)

## Open Questions/Risks

- **Existing `~/.beanbag/` on dev machines**: Since this is pre-launch, devs just need to `mv ~/.beanbag ~/.bb` or start fresh. No automated migration needed.
- **Package scope `@bb`**: Short and clean, but verify it's not taken on npm if we ever publish. Alternative: keep `@beanbag` for npm scope only but use `bb` everywhere else. Decision: use `@bb` — we can always change the npm scope later since we're not published.
- **DB table/column renames**: Covered in Phase 1d. Must coordinate with the migration squash plan — do the schema rename in `schema.ts` first, then squash migrations to get the new table names in the baseline.
- **Git branch naming**: After this lands, the default branch prefixes in worktree environments may reference old naming. Check `worktree-environment.ts` for branch name generation.
- **Execution order with migration plan**: This rename plan and the migration squash plan are interdependent. Recommended order: (1) do the rename pass (Phases 1-5), (2) then squash migrations with the new table names already in schema.ts. This way the baseline migration reflects the final naming.
