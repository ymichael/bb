# Beanbag

Beanbag is a local-first coding-agent workspace. A local daemon runs
`codex app-server`, persists threads/events in SQLite, and serves both a web UI
and a CLI.

## Monorepo Layout

```text
apps/
  daemon/   Hono REST + WebSocket server, provider runtime orchestration
  web/      React + Vite frontend
  cli/      bb CLI for daemon/thread operations
packages/
  core/     Shared types/schemas + event -> UI message projection
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

## Build, Typecheck, Test

Workspace:

```bash
pnpm build
pnpm typecheck
pnpm test
```

## Thread Lifecycle

Persisted status model:

`created -> provisioning -> idle|active|provisioning_failed`

Transition rules are centralized in
`apps/daemon/src/thread-status-machine.ts` (XState-based).

- `spawn`: creates a DB thread, then provisions async.
- `tell`: sends `turn/start` or `turn/steer` (`mode=auto|start|steer`).
- `archive`: stops process/runtime and sets `archivedAt`.
- daemon boot: reconciles persisted active/provisioning threads.

## Typed Codex Event Schema

`packages/core` derives thread event types from generated Codex app-server
TypeScript schemas in:

- `packages/core/src/generated/codex-app-server/schema/`
- `packages/core/src/generated/codex-app-server/index.ts`

Regenerate:

```bash
pnpm --filter @beanbag/core gen:codex-event-types
```

## Database and Local State

Default daemon DB:

```text
~/.beanbag/beanbag.db
```

CLI daemon PID file:

```text
~/.beanbag/daemon.pid
```

Drizzle Studio:

```bash
pnpm drizzle-studio
```

`packages/db/drizzle.config.ts` uses `BEANBAG_DB_PATH` when set; otherwise
`~/.beanbag/beanbag.db`.
