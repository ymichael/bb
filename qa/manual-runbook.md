# Manual QA Runbook

This runbook covers the standalone persistent-host QA pass for Phase 7. It is written against the current CLI and API surface.

## Prerequisites

Build the server, daemon, and CLI:

```bash
pnpm exec turbo run build --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli
```

Verify provider auth before running real-provider checks:

```bash
test -n "$OPENAI_API_KEY"
test -n "$CLAUDE_CODE_OAUTH_TOKEN"
test -f "$HOME/.codex/auth.json"
test -f "$HOME/.pi/agent/auth.json"
test -x "$HOME/.bun/bin/codex"
test -x "/opt/homebrew/bin/pi"
command -v jq
```

## Standalone Setup

Before starting, clear any leftover standalone QA processes or temp roots from a prior run:

```bash
node scripts/qa/cleanup-standalone.mjs
```

Start an isolated server + daemon pair and capture the returned state:

```bash
START_JSON=$(node scripts/qa/start-standalone.mjs)
printf '%s\n' "$START_JSON" | jq

export BB_SERVER_URL=$(printf '%s' "$START_JSON" | jq -r '.serverUrl')
export BB_HOST_DAEMON_PORT=$(printf '%s' "$START_JSON" | jq -r '.daemonPort')
export BB_PROJECT_ID=$(printf '%s' "$START_JSON" | jq -r '.projectId')

STATE_PATH=$(printf '%s' "$START_JSON" | jq -r '.statePath')
HOST_ID=$(printf '%s' "$START_JSON" | jq -r '.hostId')
DAEMON_PID=$(printf '%s' "$START_JSON" | jq -r '.daemonPid')
SERVER_PID=$(printf '%s' "$START_JSON" | jq -r '.serverPid')
LOGS_DIR=$(printf '%s' "$START_JSON" | jq -r '.logsDir')
RESTART_DAEMON_COMMAND=$(printf '%s' "$START_JSON" | jq -r '.restartDaemonCommand')

alias bb="node apps/cli/dist/index.js"
```

Basic health checks:

```bash
curl -fsS "$BB_SERVER_URL/api/v1/system/config" | jq
curl -fsS "$BB_SERVER_URL/api/v1/hosts" | jq
bb status
bb provider list
```

Teardown:

```bash
node scripts/qa/stop-standalone.mjs --state "$STATE_PATH"
node scripts/qa/cleanup-standalone.mjs
```

## Smoke Pass

Spawn an unmanaged Codex thread and wait for it to finish:

```bash
SMOKE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --reasoning-level low \
  --service-tier fast \
  --prompt "Say hello from the smoke pass" \
  --json | jq -r '.id')

bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 120
bb thread show "$SMOKE_THREAD_ID" --recent-events 10
bb thread output "$SMOKE_THREAD_ID"
bb thread log "$SMOKE_THREAD_ID" --format json | jq '.[-10:]'
```

Send a follow-up after idle:

```bash
bb thread tell "$SMOKE_THREAD_ID" "Now say goodbye from the smoke pass"
bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 120
bb thread output "$SMOKE_THREAD_ID"
```

Create a managed worktree thread and inspect workspace status:

```bash
WORKTREE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --reasoning-level low \
  --service-tier fast \
  --new-environment worktree \
  --prompt "Create a file named smoke.txt and briefly confirm it" \
  --json | jq -r '.id')

bb thread wait "$WORKTREE_THREAD_ID" --status idle --timeout 120
WORKTREE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$WORKTREE_THREAD_ID" | jq -r '.environmentId')

bb thread show "$WORKTREE_THREAD_ID"
bb thread output "$WORKTREE_THREAD_ID"
curl -fsS "$BB_SERVER_URL/api/v1/environments/$WORKTREE_ENV_ID" | jq
curl -fsS "$BB_SERVER_URL/api/v1/environments/$WORKTREE_ENV_ID/status" | jq
curl -fsS "$BB_SERVER_URL/api/v1/environments/$WORKTREE_ENV_ID/diff/branches" | jq
```

Archive and unarchive the smoke thread:

```bash
bb thread archive "$SMOKE_THREAD_ID"
curl -fsS "$BB_SERVER_URL/api/v1/threads/$SMOKE_THREAD_ID" | jq

bb thread tell "$SMOKE_THREAD_ID" "This should fail while archived"

bb thread unarchive "$SMOKE_THREAD_ID"
bb thread tell "$SMOKE_THREAD_ID" "Say something after unarchive"
bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 120
bb thread output "$SMOKE_THREAD_ID"
```

Expected result:

- The unmanaged thread reaches `idle`, shows output, and accepts a follow-up.
- The worktree thread reaches `idle`, the environment reports `isWorktree: true`, and workspace status/diff routes return data.
- Archiving blocks `bb thread tell`; unarchiving restores normal operation.

## Multi-Thread and Shared Environment

Create thread A and capture its environment:

```bash
THREAD_A_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --reasoning-level low \
  --service-tier fast \
  --prompt "Reply only in chat with the exact text THREAD A HELLO. Do not modify any files." \
  --json | jq -r '.id')

bb thread wait "$THREAD_A_ID" --status idle --timeout 120
THREAD_A_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$THREAD_A_ID" | jq -r '.environmentId')
bb thread output "$THREAD_A_ID"
```

Create thread B in the same project source path and let the server reuse the ready direct-workspace environment implicitly:

```bash
THREAD_B_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --reasoning-level low \
  --service-tier fast \
  --prompt "Reply only in chat with the exact text THREAD B WORLD. Do not modify any files." \
  --json | jq -r '.id')

bb thread wait "$THREAD_B_ID" --status idle --timeout 120
THREAD_B_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$THREAD_B_ID" | jq -r '.environmentId')

printf 'thread A env: %s\nthread B env: %s\n' "$THREAD_A_ENV_ID" "$THREAD_B_ENV_ID"
bb thread output "$THREAD_B_ID"
```

Alternate follow-ups across the two sibling threads:

```bash
bb thread tell "$THREAD_A_ID" "Reply only in chat with FOLLOW UP A. Do not modify files."
bb thread wait "$THREAD_A_ID" --status idle --timeout 120

bb thread tell "$THREAD_B_ID" "Reply only in chat with FOLLOW UP B. Do not modify files."
bb thread wait "$THREAD_B_ID" --status idle --timeout 120

bb thread output "$THREAD_A_ID"
bb thread output "$THREAD_B_ID"
bb thread log "$THREAD_A_ID" --format json | jq '.[-8:]'
bb thread log "$THREAD_B_ID" --format json | jq '.[-8:]'
```

Archive thread A and verify thread B still works:

```bash
bb thread archive "$THREAD_A_ID"
bb thread tell "$THREAD_B_ID" "Reply only in chat with STILL WORKING. Do not modify files."
bb thread wait "$THREAD_B_ID" --status idle --timeout 120
bb thread output "$THREAD_B_ID"
bb thread unarchive "$THREAD_A_ID"
```

Run a mixed-provider pass in separate environments:

```bash
CLAUDE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider claude-code \
  --reasoning-level low \
  --model claude-haiku-4-5 \
  --new-environment worktree \
  --prompt "Reply only in chat with CLAUDE THREAD. Do not modify files." \
  --json | jq -r '.id')

PI_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider pi \
  --reasoning-level low \
  --model openai/codex-mini \
  --new-environment worktree \
  --prompt "Reply only in chat with PI THREAD. Do not modify files." \
  --json | jq -r '.id')

bb thread wait "$CLAUDE_THREAD_ID" --status idle --timeout 120
bb thread wait "$PI_THREAD_ID" --status idle --timeout 120
CLAUDE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$CLAUDE_THREAD_ID" | jq -r '.environmentId')
PI_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$PI_THREAD_ID" | jq -r '.environmentId')

printf 'claude env: %s\npi env: %s\n' "$CLAUDE_ENV_ID" "$PI_ENV_ID"
bb thread output "$CLAUDE_THREAD_ID"
bb thread output "$PI_THREAD_ID"
```

Promote and demote a managed worktree.

Promotion requires both the managed worktree and the primary checkout to be clean. Commit the worktree change before promoting, and run this step from a clean primary checkout:

```bash
PROMOTE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --reasoning-level low \
  --service-tier fast \
  --new-environment worktree \
  --prompt "Write a file named promote.txt" \
  --json | jq -r '.id')

bb thread wait "$PROMOTE_THREAD_ID" --status idle --timeout 120
PROMOTE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$PROMOTE_THREAD_ID" | jq -r '.environmentId')

curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROMOTE_ENV_ID/status" | jq
bb environment commit "$PROMOTE_ENV_ID" --message "Manual QA promote step"
bb environment promote "$PROMOTE_ENV_ID"
bb environment demote "$PROMOTE_ENV_ID"
```

Expected result:

- Thread A and B share the same environment ID via implicit same-path reuse.
- Alternating follow-ups complete and their outputs remain distinct.
- Archiving one sibling does not break the other.
- Mixed-provider threads succeed without event cross-contamination.
- Promote/demote succeeds on the managed worktree environment.

## Recovery

Graceful daemon restart:

```bash
kill -TERM "$DAEMON_PID"
curl -fsS "$BB_SERVER_URL/api/v1/system/config" | jq
curl -fsS "$BB_SERVER_URL/api/v1/hosts" | jq

eval "$RESTART_DAEMON_COMMAND"
DAEMON_PID=$!

curl -fsS "$BB_SERVER_URL/api/v1/hosts" | jq
bb thread tell "$SMOKE_THREAD_ID" "Check recovery after daemon restart"
bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 120
bb thread output "$SMOKE_THREAD_ID"
```

Kill the daemon during active work:

```bash
bb thread tell "$SMOKE_THREAD_ID" "Write 80 detailed bullet points about the history of computing."
bb thread wait "$SMOKE_THREAD_ID" --status active --timeout 30

kill -TERM "$DAEMON_PID"
bb thread show "$SMOKE_THREAD_ID" --recent-events 10

eval "$RESTART_DAEMON_COMMAND"
DAEMON_PID=$!

THREAD_STATE=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$SMOKE_THREAD_ID" | jq -r '.status')

if [ "$THREAD_STATE" = "active" ]; then
  bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 180
else
  bb thread tell "$SMOKE_THREAD_ID" "Say exactly: recovery ok"
  bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 120
fi

bb thread output "$SMOKE_THREAD_ID"
bb thread log "$SMOKE_THREAD_ID" --format json | jq '.[-12:]'
```

Inspect logs and state:

```bash
tail -n 200 "$LOGS_DIR/server.log"
tail -n 200 "$LOGS_DIR/host-daemon.log"
curl -fsS "$BB_SERVER_URL/api/v1/threads/$SMOKE_THREAD_ID" | jq
```

Expected result:

- The server stays up while the daemon is restarted.
- Threads remain inspectable during and after daemon loss.
- After an interruption mid-turn, the thread either resumes active work and settles to `idle`, or reaches `idle`/`error` and accepts a short new turn after restart.

## Provider-Specific Pass

Repeat this section for `codex`, `claude-code`, and `pi`:

```bash
PROVIDER_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider <provider-id> \
  --reasoning-level low \
  --prompt "Say exactly: hello world" \
  --json | jq -r '.id')

bb thread wait "$PROVIDER_THREAD_ID" --status idle --timeout 120
bb thread output "$PROVIDER_THREAD_ID"

bb thread tell "$PROVIDER_THREAD_ID" "Repeat the previous answer in uppercase"
bb thread wait "$PROVIDER_THREAD_ID" --status idle --timeout 120
bb thread output "$PROVIDER_THREAD_ID"

bb thread tell "$PROVIDER_THREAD_ID" "Write a very long essay about computing history"
bb thread wait "$PROVIDER_THREAD_ID" --status active --timeout 30
bb thread stop "$PROVIDER_THREAD_ID"
bb thread wait "$PROVIDER_THREAD_ID" --status idle --timeout 120
bb thread show "$PROVIDER_THREAD_ID" --recent-events 10
```

For workspace interaction, repeat on a worktree thread:

```bash
PROVIDER_WORKTREE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider <provider-id> \
  --reasoning-level low \
  --new-environment worktree \
  --prompt "Create hello.txt containing hello world" \
  --json | jq -r '.id')

bb thread wait "$PROVIDER_WORKTREE_THREAD_ID" --status idle --timeout 120
PROVIDER_WORKTREE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$PROVIDER_WORKTREE_THREAD_ID" | jq -r '.environmentId')

bb thread output "$PROVIDER_WORKTREE_THREAD_ID"
curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROVIDER_WORKTREE_ENV_ID/status" | jq
```

## Recording Results

Record each pass with:

- Date and operator
- Standalone state path
- Provider(s) used
- Thread IDs and environment IDs
- Whether smoke, multi-thread, and recovery passed
- Any unexpected output, missing events, or log findings
