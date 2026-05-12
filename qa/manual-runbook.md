# Manual QA Runbook

This runbook covers the standalone persistent-host CLI/API smoke pass for general threads and managed worktrees. It is written against the current CLI and API surface.

## Prerequisites

Build the server, daemon, and CLI:

```bash
pnpm build
```

Verify provider CLIs are installed before running real-provider checks:

```bash
codex --help
claude --help
pi --help
jq --help
```

## Standalone Setup

Before starting, clear any leftover standalone QA processes or temp roots from a prior run:

```bash
pnpm qa:standalone:cleanup
```

Start an isolated server + daemon pair and load the exported QA environment:

```bash
eval "$(pnpm --silent qa:standalone:start --format env)"
jq . "$STATE_PATH"

bb() { node apps/cli/dist/index.js "$@"; }
```

The machine-facing contract is the exported env block. The state file at `$STATE_PATH`
is the diagnostics contract for humans and debugging.

Basic health checks:

```bash
curl -fsS "$BB_SERVER_URL/api/v1/system/config" | jq
curl -fsS "$BB_SERVER_URL/api/v1/hosts" | jq
bb status
bb provider list
```

Resolve current provider models before spawning real-provider threads:

```bash
CODEX_MODEL=$(bb provider models codex --json | jq -er '([.[] | select(.isDefault)][0].model // .[0].model)')
CLAUDE_MODEL=$(bb provider models claude-code --json | jq -er '([.[] | select(.model == "claude-haiku-4-5")][0].model // [.[] | select(.isDefault)][0].model // .[0].model)')
PI_MODELS_JSON=$(bb provider models pi --json)
# Keep Pi preference order in sync with packages/test-helpers/src/provider-models.ts.
PI_MODEL=$(printf '%s\n' "$PI_MODELS_JSON" | jq -er '
  [.[] | select(.model == "openai-codex/gpt-5.5")][0].model
  // [.[] | select(.model == "openai-codex/gpt-5.4")][0].model
  // [.[] | select(.model == "openai-codex/gpt-5.4-mini")][0].model
  // [.[] | select(.model == "openai-codex/gpt-5.3-codex")][0].model
  // [.[] | select(.model == "anthropic/claude-haiku-4-5")][0].model
  // [.[] | select(.model | startswith("anthropic/")) | select(.isDefault)][0].model
  // [.[] | select(.model | startswith("openai-codex/")) | select(.isDefault)][0].model
  // [.[] | select(.model | startswith("openai-codex/"))][0].model
  // [.[] | select(.model | startswith("anthropic/"))][0].model
  // [.[] | select(.isDefault)][0].model
  // .[0].model
')

printf 'codex: %s\nclaude-code: %s\npi: %s\n' "$CODEX_MODEL" "$CLAUDE_MODEL" "$PI_MODEL"
```

For exact-output checks, use prompts in the form `Say exactly: <EXPECTED TEXT>`.
Avoid phrasing like "reply only in chat with..." because providers can interpret that
as a behavioral constraint rather than the expected response text.

For Pi checks, prefer subscription-backed `openai-codex/...` models from Codex
subscription auth first, then `anthropic/...` models from Claude/Anthropic auth,
over generic `openai/...` API-key models.

Teardown:

```bash
pnpm qa:standalone:stop --state "$STATE_PATH"
pnpm qa:standalone:cleanup
```

## Smoke Pass

Spawn an unmanaged Codex thread and wait for it to finish:

```bash
SMOKE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --prompt "Say hello from the smoke pass" \
  --json | jq -r '.id')

bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 120
bb thread show "$SMOKE_THREAD_ID"
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
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --prompt "Create a file named smoke.txt and briefly confirm it" \
  --json | jq -r '.id')

bb thread wait "$WORKTREE_THREAD_ID" --status idle --timeout 120
WORKTREE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$WORKTREE_THREAD_ID" | jq -r '.environmentId')

bb thread show "$WORKTREE_THREAD_ID"
bb thread output "$WORKTREE_THREAD_ID"
bb thread show "$WORKTREE_THREAD_ID" --work-status
bb thread show "$WORKTREE_THREAD_ID" --git-diff --diff-target uncommitted
bb thread show "$WORKTREE_THREAD_ID" --git-diff --diff-target branch_committed
bb thread show "$WORKTREE_THREAD_ID" --git-diff --diff-target all
curl -fsS "$BB_SERVER_URL/api/v1/environments/$WORKTREE_ENV_ID" | jq
curl -fsS "$BB_SERVER_URL/api/v1/environments/$WORKTREE_ENV_ID/status" | jq
curl -fsS "$BB_SERVER_URL/api/v1/environments/$WORKTREE_ENV_ID/diff/branches" | jq
```

Verify merge-base environment metadata:

```bash
MERGE_BASE_BRANCH=$(curl -fsS "$BB_SERVER_URL/api/v1/environments/$WORKTREE_ENV_ID" | jq -er '.defaultBranch // "main"')

bb environment update "$WORKTREE_ENV_ID" --merge-base-branch "$MERGE_BASE_BRANCH"
bb environment show "$WORKTREE_ENV_ID" --json | jq -e --arg branch "$MERGE_BASE_BRANCH" '.mergeBaseBranch == $branch'
bb thread show "$WORKTREE_THREAD_ID" --work-status --git-diff --diff-target all

bb environment update "$WORKTREE_ENV_ID" --clear-merge-base-branch
bb environment show "$WORKTREE_ENV_ID" --json | jq -e '.mergeBaseBranch == null'
```

Archive and unarchive the smoke thread:

```bash
bb thread archive "$SMOKE_THREAD_ID"
curl -fsS "$BB_SERVER_URL/api/v1/threads/$SMOKE_THREAD_ID" | jq

if bb thread tell "$SMOKE_THREAD_ID" "This should fail while archived"; then
  echo "expected archived thread tell to fail"
  false
else
  echo "archived thread tell was blocked"
fi

bb thread unarchive "$SMOKE_THREAD_ID"
bb thread tell "$SMOKE_THREAD_ID" "Say something after unarchive"
bb thread wait "$SMOKE_THREAD_ID" --status idle --timeout 120
bb thread output "$SMOKE_THREAD_ID"
```

Verify archive safety for a dirty managed worktree:

```bash
DIRTY_ARCHIVE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --prompt "Say exactly: dirty archive setup" \
  --json | jq -r '.id')

bb thread wait "$DIRTY_ARCHIVE_THREAD_ID" --status idle --timeout 120
DIRTY_ARCHIVE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$DIRTY_ARCHIVE_THREAD_ID" | jq -r '.environmentId')
DIRTY_ARCHIVE_ENV_PATH=$(curl -fsS "$BB_SERVER_URL/api/v1/environments/$DIRTY_ARCHIVE_ENV_ID" | jq -er '.path')
printf 'dirty archive safety\n' > "$DIRTY_ARCHIVE_ENV_PATH/dirty-archive.txt"
bb thread show "$DIRTY_ARCHIVE_THREAD_ID" --work-status

if bb thread archive "$DIRTY_ARCHIVE_THREAD_ID"; then
  echo "expected dirty managed worktree archive to require --force"
  false
else
  echo "dirty managed worktree archive was blocked without --force"
fi

bb thread archive "$DIRTY_ARCHIVE_THREAD_ID" --force
curl -fsS "$BB_SERVER_URL/api/v1/threads/$DIRTY_ARCHIVE_THREAD_ID" | jq
```

Expected result:

- The unmanaged thread reaches `idle`, shows output, and accepts a follow-up.
- The worktree thread reaches `idle`, the environment reports `isWorktree: true`, and workspace status/diff routes return data for uncommitted, branch-committed, and combined targets.
- Environment merge-base metadata can be set, reflected by `bb environment show`, used by thread status/diff output, and cleared.
- Archiving blocks `bb thread tell`; unarchiving restores normal operation.
- Dirty isolated managed worktree archive is blocked without `--force` and succeeds with `--force`.

## Multi-Thread and Shared Environment

Create thread A and capture its environment:

```bash
THREAD_A_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --prompt "Say exactly: THREAD A HELLO" \
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
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --prompt "Say exactly: THREAD B WORLD" \
  --json | jq -r '.id')

bb thread wait "$THREAD_B_ID" --status idle --timeout 120
THREAD_B_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$THREAD_B_ID" | jq -r '.environmentId')

printf 'thread A env: %s\nthread B env: %s\n' "$THREAD_A_ENV_ID" "$THREAD_B_ENV_ID"
bb thread output "$THREAD_B_ID"
```

Alternate follow-ups across the two sibling threads:

```bash
bb thread tell "$THREAD_A_ID" "Say exactly: FOLLOW UP A"
bb thread wait "$THREAD_A_ID" --status idle --timeout 120

bb thread tell "$THREAD_B_ID" "Say exactly: FOLLOW UP B"
bb thread wait "$THREAD_B_ID" --status idle --timeout 120

bb thread output "$THREAD_A_ID"
bb thread output "$THREAD_B_ID"
bb thread log "$THREAD_A_ID" --format json | jq '.[-8:]'
bb thread log "$THREAD_B_ID" --format json | jq '.[-8:]'
```

Archive thread A and verify thread B still works:

```bash
bb thread archive "$THREAD_A_ID"
bb thread tell "$THREAD_B_ID" "Say exactly: STILL WORKING"
bb thread wait "$THREAD_B_ID" --status idle --timeout 120
bb thread output "$THREAD_B_ID"
bb thread unarchive "$THREAD_A_ID"
```

Run a mixed-provider pass in separate environments:

```bash
CLAUDE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider claude-code \
  --model "$CLAUDE_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --prompt "Say exactly: CLAUDE THREAD" \
  --json | jq -r '.id')

PI_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider pi \
  --model "$PI_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --prompt "Say exactly: PI THREAD" \
  --json | jq -r '.id')

bb thread wait "$CLAUDE_THREAD_ID" --status idle --timeout 120
bb thread wait "$PI_THREAD_ID" --status idle --timeout 180
CLAUDE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$CLAUDE_THREAD_ID" | jq -r '.environmentId')
PI_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$PI_THREAD_ID" | jq -r '.environmentId')

printf 'claude env: %s\npi env: %s\n' "$CLAUDE_ENV_ID" "$PI_ENV_ID"
bb thread output "$CLAUDE_THREAD_ID"
bb thread output "$PI_THREAD_ID"
```

Promote and demote a managed worktree.

Promotion requires both the managed worktree and the primary checkout to be clean. The primary checkout is `$PROJECT_ROOT`, the local project source, not the operator's current shell directory. Commit the worktree change before promoting, and verify `$PROJECT_ROOT` is clean:

```bash
PROMOTE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --prompt "Write a file named promote.txt" \
  --json | jq -r '.id')

bb thread wait "$PROMOTE_THREAD_ID" --status idle --timeout 120
PROMOTE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$PROMOTE_THREAD_ID" | jq -r '.environmentId')
PROMOTE_ENV_JSON=$(curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROMOTE_ENV_ID")
PROMOTE_BRANCH=$(printf '%s\n' "$PROMOTE_ENV_JSON" | jq -er '.branchName')
PROMOTE_DEFAULT_BRANCH=$(printf '%s\n' "$PROMOTE_ENV_JSON" | jq -er '.defaultBranch')
PROJECT_SOURCE_ID=$(bb project show "$BB_PROJECT_ID" --json | jq -er '
  ([.sources[] | select(.type == "local_path" and .isDefault)][0]
    // [.sources[] | select(.type == "local_path")][0]).id
')

curl -fsS "$BB_SERVER_URL/api/v1/projects/$BB_PROJECT_ID/sources/$PROJECT_SOURCE_ID/status" \
  | jq -e '.workspace.workingTree.hasUncommittedChanges == false'
curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROMOTE_ENV_ID/status" | jq
bb environment commit "$PROMOTE_ENV_ID"
curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROMOTE_ENV_ID/promotion" \
  | jq -e '.state.isPromoted == false and .actions.promote.unavailableReasons == []'

bb environment promote "$PROMOTE_ENV_ID"
curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROMOTE_ENV_ID/promotion" \
  | jq -e '.state.isPromoted == true and .actions.demote.unavailableReasons == []'
curl -fsS "$BB_SERVER_URL/api/v1/projects/$BB_PROJECT_ID/sources/$PROJECT_SOURCE_ID/status" \
  | jq -e --arg branch "$PROMOTE_BRANCH" '.workspace.branch.currentBranch == $branch'

bb environment demote "$PROMOTE_ENV_ID"
curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROMOTE_ENV_ID/promotion" \
  | jq -e '.state.isPromoted == false and (.actions.demote.unavailableReasons | index("not_promoted")) != null'
curl -fsS "$BB_SERVER_URL/api/v1/projects/$BB_PROJECT_ID/sources/$PROJECT_SOURCE_ID/status" \
  | jq -e --arg branch "$PROMOTE_DEFAULT_BRANCH" '.workspace.branch.currentBranch == $branch'
```

Expected result:

- Thread A and B share the same environment ID via implicit same-path reuse.
- Alternating follow-ups complete and return the requested exact outputs.
- Archiving one sibling does not break the other.
- Mixed-provider threads succeed without event cross-contamination.
- Promotion availability reports no promote blockers before promote, promoted state and no demote blockers after promote, then unpromoted state after demote.
- The project source status route shows the primary checkout branch change during promote/demote.

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
bb thread show "$SMOKE_THREAD_ID"

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

Use the resolved model for each provider:

- `codex`: `--model "$CODEX_MODEL"`
- `claude-code`: `--model "$CLAUDE_MODEL"`
- `pi`: `--model "$PI_MODEL"`

```bash
PROVIDER_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider <provider-id> \
  --model <provider-model> \
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
bb thread show "$PROVIDER_THREAD_ID"
bb thread log "$PROVIDER_THREAD_ID" --format json | jq '.[-10:]'
```

For workspace interaction, repeat on a worktree thread:

```bash
PROVIDER_WORKTREE_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider <provider-id> \
  --model <provider-model> \
  --reasoning-level low \
  --new-environment worktree \
  --prompt "Create hello.txt containing hello world" \
  --json | jq -r '.id')

bb thread wait "$PROVIDER_WORKTREE_THREAD_ID" --status idle --timeout 120
PROVIDER_WORKTREE_ENV_ID=$(curl -fsS "$BB_SERVER_URL/api/v1/threads/$PROVIDER_WORKTREE_THREAD_ID" | jq -r '.environmentId')

bb thread output "$PROVIDER_WORKTREE_THREAD_ID"
curl -fsS "$BB_SERVER_URL/api/v1/environments/$PROVIDER_WORKTREE_ENV_ID/status" | jq
```

Run a pending-interaction pass with permission-restricted turns:

```bash
APPROVAL_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --permission-mode readonly \
  --prompt "Run this exact shell command: printf 'APPROVED' > approval-smoke.txt. If approval is needed, request approval. After the command finishes, reply with exactly DONE." \
  --json | jq -r '.id')

APPROVAL_INTERACTION_ID=
for _ in {1..60}; do
  APPROVAL_INTERACTION_ID=$(bb thread interactions list "$APPROVAL_THREAD_ID" --json | jq -r '.[0].id // empty')
  if [ -n "$APPROVAL_INTERACTION_ID" ]; then
    break
  fi
  sleep 2
done
test -n "$APPROVAL_INTERACTION_ID"

bb thread interactions show "$APPROVAL_INTERACTION_ID" "$APPROVAL_THREAD_ID"

if bb thread tell "$APPROVAL_THREAD_ID" "This should be blocked while an interaction is pending"; then
  echo "expected tell to be blocked while the interaction is pending"
  false
else
  echo "tell was blocked while the interaction was pending"
fi

bb thread interactions approve "$APPROVAL_INTERACTION_ID" "$APPROVAL_THREAD_ID"
bb thread wait "$APPROVAL_THREAD_ID" --status idle --timeout 180
bb thread output "$APPROVAL_THREAD_ID"
bb thread interactions list "$APPROVAL_THREAD_ID" --json | jq
```

Verify denial handling with a separate interaction:

```bash
DENY_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --model "$CODEX_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --permission-mode readonly \
  --prompt "Run this exact shell command: printf 'DENIED' > denied-smoke.txt. If approval is denied, reply with exactly DENIED." \
  --json | jq -r '.id')

DENY_INTERACTION_ID=
for _ in {1..60}; do
  DENY_INTERACTION_ID=$(bb thread interactions list "$DENY_THREAD_ID" --json | jq -r '.[0].id // empty')
  if [ -n "$DENY_INTERACTION_ID" ]; then
    break
  fi
  sleep 2
done
test -n "$DENY_INTERACTION_ID"

bb thread interactions show "$DENY_INTERACTION_ID" "$DENY_THREAD_ID"
bb thread interactions deny "$DENY_INTERACTION_ID" "$DENY_THREAD_ID"
if bb thread wait "$DENY_THREAD_ID" --status idle --timeout 180; then
  bb thread output "$DENY_THREAD_ID"
else
  bb thread show "$DENY_THREAD_ID"
fi
bb thread log "$DENY_THREAD_ID" --format json | jq '.[-12:]'
```

For `claude-code`, also verify grant semantics with a permission-grant interaction:

```bash
GRANT_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider claude-code \
  --model "$CLAUDE_MODEL" \
  --reasoning-level low \
  --new-environment worktree \
  --permission-mode workspace-write \
  --prompt "Use the Read tool to read /etc/hosts, then reply with exactly the first non-empty line from the file and nothing else." \
  --json | jq -r '.id')

GRANT_INTERACTION_ID=
for _ in {1..60}; do
  GRANT_INTERACTION_ID=$(bb thread interactions list "$GRANT_THREAD_ID" --json | jq -r '.[0].id // empty')
  if [ -n "$GRANT_INTERACTION_ID" ]; then
    break
  fi
  sleep 2
done
test -n "$GRANT_INTERACTION_ID"

bb thread interactions show "$GRANT_INTERACTION_ID" "$GRANT_THREAD_ID"
bb thread interactions grant "$GRANT_INTERACTION_ID" "$GRANT_THREAD_ID" --scope turn
bb thread wait "$GRANT_THREAD_ID" --status idle --timeout 180
bb thread output "$GRANT_THREAD_ID"
```

Expected result:

- Permission-restricted turns surface pending interactions through `bb thread interactions list/show`.
- `bb thread tell` is rejected while the thread is awaiting user interaction.
- `approve`, `deny`, and `grant` resolve their matching interaction kinds.
- Approved/granted threads continue to `idle`; denied threads either reply with the denial handling text or clearly record the denied approval in the log.

## Recording Results

Record each pass with:

- Date and operator
- Standalone state path
- Provider(s) used
- Thread IDs and environment IDs
- Whether smoke, multi-thread, and recovery passed
- Any unexpected output, missing events, or log findings
