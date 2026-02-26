# Beanbag

Beanbag is a local-first coding-agent workspace. A local daemon runs
provider adapters, persists threads/events in SQLite, and serves both a web UI
and a CLI.

## Monorepo Layout

```text
apps/
  daemon/   Hono REST + WebSocket server, provider runtime orchestration
  web/      React + Vite frontend
  cli/      bb CLI for daemon/thread operations
packages/
  core/     Shared contracts/types/schemas + event -> UI message projection
  ui-core/  Reusable ADE UI primitives (layout, timeline, prompt shell, panels)
  db/       Drizzle schema, migrations, repositories (SQLite)
```

## Quick Start

```bash
pnpm install
pnpm dev
```

Endpoints:

- Web UI: `http://localhost:5173`
- API base: `http://localhost:3333/api/v1`
- WebSocket: `ws://localhost:3333/ws`

`apps/web` dev server proxies `/api` and `/ws` to daemon `:3333`.

## CLI and Daemon Run Modes

Development (source + watch):

```bash
pnpm install
pnpm dev

# run CLI from source in dev
pnpm bb:dev --help
pnpm bb:dev status
```

Production (built `dist`):

```bash
pnpm build

# run built daemon and built CLI
pnpm daemon --help
pnpm bb --help
```

Notes:

- `dist/` output is generated for `@beanbag/agent-core`, `@beanbag/agent-server`, `@beanbag/ui-core`, `@beanbag/db`, `@beanbag/daemon`, and `@beanbag/cli`.
- `pnpm dev` starts the daemon on `:3333`.
- CLI uses `BB_DAEMON_URL` when set, otherwise defaults to `http://localhost:3333`.

## Build, Typecheck, Test

Workspace:

```bash
pnpm build
pnpm typecheck
pnpm test
```

UI consistency checklist for frontend changes:

- Reuse shared primitives (`PageShell`, `DetailCard`/`DetailRow`, `CollapsibleHeader`, status pills).
- Keep the canonical message rendering path (`ConversationEntry` + `ConversationWorkingIndicator`).
- Use `ui-text-*` typography utilities instead of arbitrary `text-[Npx]` classes.
- Keep light/dark typography tokens aligned unless a divergence is intentionally documented.

## Union Handling

When working with string domains:

- `closed_internal`: Beanbag-owned values. Use exhaustive `switch` handling and `assertNever`.
- `open_external`: provider/runtime-owned values. Keep tolerant fallback branches with a comment that unknown values are intentional.

`assertNever` is exported from `@beanbag/agent-core`.

## Thread Lifecycle

Persisted status model:

`created -> provisioning -> idle|active|provisioning_failed`

Transition rules are centralized in
`apps/daemon/src/thread-status-machine.ts`.

- `spawn`: creates a DB thread, then provisions async.
- `tell`: sends `turn/start` or `turn/steer` (`mode=auto|start|steer`).
- `archive`: stops process/runtime and sets `archivedAt`.
- daemon boot: reconciles persisted active/provisioning threads.

## CLI Context Env

Thread execution context is exposed to agent shells as:

- `BB_PROJECT_ID`
- `BB_THREAD_ID`
- `BB_ENVIRONMENT_ID`
- `BB_DAEMON_URL` (optional daemon endpoint override; default is `http://localhost:3333`)

`bb` is also kept on `PATH` for agent shell commands.

CLI commands that need project context accept `--project`, or fall back to
`BB_PROJECT_ID` when the flag is omitted.

Creation defaults:

- `bb thread spawn` defaults parent-thread context to `BB_THREAD_ID` (opt out with `--no-context-parent-thread`).

Status output defaults:

- `bb status` prints `Project` and `Thread` ids from the current context.
- `bb thread status` is concise by default (no recent-event block unless requested).

Status event flags:

- `bb thread status --recent-events <n> [--event-mode summary|raw] [--include-low-signal]`

Show command context fallback:

- `bb thread show [id]` defaults to `BB_THREAD_ID` when `id` is omitted.

Provider and environment selection:

- `BEANBAG_PROVIDER` selects the active provider adapter (`codex`, `pi-mono`, `claude-code`).
- `BEANBAG_ENVIRONMENT` selects the execution environment adapter (`local`, `worktree`).
- `GET /api/v1/system/providers` and `GET /api/v1/system/environments` expose adapter catalogs.

## Typed Codex Event Schema

`packages/core` derives thread event types from generated Codex app-server
TypeScript schemas in:

- `packages/core/src/generated/codex-app-server/schema/`
- `packages/core/src/generated/codex-app-server/index.ts`

Regenerate:

```bash
pnpm --filter @beanbag/agent-core gen:codex-event-types
```

## Database and Local State

Default daemon DB:

```text
~/.beanbag/beanbag.db
```

CLI daemon PID file:

```text
~/.beanbag/agent-server.pid
```

Drizzle Studio:

```bash
pnpm drizzle-studio
```

`packages/db/drizzle.config.ts` uses `BEANBAG_DB_PATH` when set; otherwise
`~/.beanbag/beanbag.db`.
