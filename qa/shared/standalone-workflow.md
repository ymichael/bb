# Standalone QA Workflow

Use this workflow when a QA pass needs a disposable standalone server with its own BB root.

This is the shared setup and relaunch procedure for the surface-based QA docs.

## When to use

- server restart and resume checks
- env-daemon reconnect and worker-loss checks
- provider QA against a clean standalone target
- CLI and environment flows that should be exercised against a disposable server

## Rules

- use the built binaries directly:
  - `node apps/server/dist/index.js`
  - `node apps/cli/dist/index.js`
- prefer disposable repos and disposable BB roots
- for restart and relaunch checks, use the exact Node runtime that started the standalone server
- use SQLite only as a deeper debugging layer after the CLI and API surfaces

## Prerequisites

Build the stack first:

```bash
pnpm exec turbo run build \
  --filter=@bb/environment-daemon \
  --filter=@bb/server \
  --filter=@bb/cli
```

Provider setup:

- Codex: confirm `codex` is in `PATH`
- Claude Code: confirm `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set and `@bb/claude-code-bridge` is built
- Pi: confirm `pi` is in `PATH`, auth is configured, and `@bb/pi-bridge` is built

Recommended during restart and liveness QA:

```bash
tail -f "$bb_root/logs/server.log"
```

## Fast setup wrapper

```bash
node scripts/qa/start-standalone-server-qa.mjs
```

This provisions a disposable repo and BB root, starts the standalone server, creates a project, and prints:

- `serverUrl`
- `projectId`
- temp paths
- server PID
- exact Node runtime details
- `relaunchCommand`
- `cleanupCommand`

Keep the reported `nodePath`, `nodeVersion`, and `nodeAbi`. If you relaunch under a different Node ABI, native modules can fail before BB finishes booting.

When done, run the printed `cleanupCommand`.

## Manual setup

```bash
tmp_root=$(mktemp -d /tmp/bb-qa-XXXXXX)
project_root="$tmp_root/project"
bb_root="$tmp_root/bb-root"
mkdir -p "$project_root" "$bb_root"
printf 'alpha\n' > "$project_root/alpha.txt"
printf '# beta\n' > "$project_root/beta.md"
git -C "$project_root" init -b main
git -C "$project_root" add .
GIT_AUTHOR_NAME='BB Test' \
GIT_AUTHOR_EMAIL='bb-test@example.com' \
GIT_COMMITTER_NAME='BB Test' \
GIT_COMMITTER_EMAIL='bb-test@example.com' \
git -C "$project_root" commit -m init
```

Start the standalone server:

```bash
BB_ROOT="$bb_root" \
node apps/server/dist/index.js --port 4311
```

Claude Code example:

```bash
BB_ROOT="$bb_root" \
ANTHROPIC_API_KEY=... \
node apps/server/dist/index.js --port 4311
```

Target the server:

```bash
export BB_SERVER_URL=http://127.0.0.1:4311
```

Create a project:

```bash
node apps/cli/dist/index.js project create --name qa-standalone --root "$project_root"
node apps/cli/dist/index.js project list
node apps/cli/dist/index.js project files --project <project-id> alpha
```

Record the actual `<project-id>` and reuse it.

## Provider selection

Start the standalone server without a global default provider. Select a provider with `--provider <id>` on the relevant CLI commands when needed.

Examples:

```bash
ANTHROPIC_API_KEY=... pnpm qa:providers:smoke:claude-code
pnpm qa:providers:smoke:pi
```

Pi reads auth from `~/.pi/agent/auth.json`.

Claude Code and Pi do not support rename-oriented checks from older standalone matrices.

## Inspection helpers

```bash
node apps/cli/dist/index.js server health
node apps/cli/dist/index.js thread wait <thread-id> --status idle --timeout 90
node apps/cli/dist/index.js thread wait <thread-id> --event turn/started --timeout 30
node apps/cli/dist/index.js thread sessions <thread-id>
node scripts/qa/thread-summary.mjs <thread-id>
node apps/cli/dist/index.js thread status <thread-id> --recent-events 10 --event-mode raw --include-low-signal
node apps/cli/dist/index.js thread log <thread-id> --json
node apps/cli/dist/index.js thread output <thread-id>
```

Optional deeper debugging helpers:

```bash
sqlite3 "$bb_root/bb.db" \
  "select id,status,updated_at from threads order by updated_at desc;"

sqlite3 "$bb_root/bb.db" \
  "select thread_id,status,control_base_url,lease_expires_at,last_heartbeat_at from environment_agent_sessions order by created_at desc;"

sqlite3 "$bb_root/bb.db" \
  "select thread_id,type,substr(json_data,1,160) from events order by seq desc limit 20;"
```

## Environment checks

For implicit local-environment reuse, spawn two local threads and compare the environment IDs shown by:

```bash
node apps/cli/dist/index.js thread show <thread-id>
```

Matching `Environment Direct` IDs mean both threads attached to the same local environment.

For worktree primary-checkout checks, use the environment subcommands rather than thread subcommands:

```bash
node apps/cli/dist/index.js environment promote-status --project <project-id>
node apps/cli/dist/index.js environment promote <environment-id> --thread <thread-id>
node apps/cli/dist/index.js environment demote --thread <thread-id>
```

## Relaunch guidance

For restart and relaunch checks, prefer the helper:

```bash
node scripts/qa/relaunch-standalone-server-qa.mjs \
  --bb-root "$bb_root" \
  --port 4311
```

If `start-standalone-server-qa.mjs` printed a `relaunchCommand`, prefer that exact command or pass the reported `nodePath` explicitly:

```bash
node scripts/qa/relaunch-standalone-server-qa.mjs \
  --bb-root "$bb_root" \
  --port 4311 \
  --node-path "/absolute/path/to/node"
```

Avoid `bash -lc '... node ...'` unless you first confirm `command -v node` resolves to the same runtime. Different login shells can put different Node installations first in `PATH`.

After relaunch:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread log <thread-id>
```

## Main server QA

If the user wants QA against an already-running main server, avoid `server restart` unless explicitly approved.

Safe scope:

- `server health`
- `project create/list/files`
- `thread spawn/show/log/output`
- `thread tell`
- `thread stop`
- `thread archive` / `thread unarchive`
- worktree spawn/follow-up
