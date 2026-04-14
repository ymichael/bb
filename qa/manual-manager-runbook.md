# Manual Manager Runbook

This runbook covers the CLI-oriented manual QA pass for manager threads. It is
focused on the manager product contract, not the general thread/worktree smoke
coverage in [qa/manual-runbook.md](/Users/michael/.codex/worktrees/dc39/bb/qa/manual-runbook.md).

## Scope

Manager providers under test:

- `codex` with `gpt-5.4` / `medium`
- `pi` with `anthropic/claude-opus-4-6` / `medium`
- Pi fallback: `openai/gpt-5.4` / `medium`

Worker providers under test:

- `codex` with `gpt-5.3-codex` / `medium`
- `claude-code` with `claude-sonnet-4-6` / `medium`
- `pi` with `anthropic/claude-sonnet-4-6`
- Pi fallback: `openai/gpt-5.4`

Core behaviors under test:

- hire -> immediate hatch -> meet-and-greet
- delegation to child threads
- kickoff and completion user updates via `message_user`
- no polling loops while waiting for child completion
- automated manager system messages for welcome, child completion, assignment,
  and unassignment
- multiple child threads and provider routing preferences
- archive judgment for quick research vs still-useful implementation threads
- same-environment implementation + review workflows
- `ASYNC.md` schedule creation and sync

## Prerequisites

Build the server, host daemon, CLI, and templates:

```bash
pnpm exec turbo run build --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli --filter=@bb/templates
```

Verify the provider CLIs are installed before using them:

```bash
codex --help
claude --help
pi --help
jq --help
sqlite3 --version
```

## Standalone Setup

Clear leftover QA processes:

```bash
pnpm qa:standalone:cleanup
```

Start an isolated server + daemon pair and load the exported QA environment:

```bash
eval "$(pnpm --silent qa:standalone:start --format env)"
alias bb="node apps/cli/dist/index.js"

BB_ROOT=$(jq -r '.daemon.dataDir' "$STATE_PATH")
SERVER_DB=$(jq -r '.paths.serverDataDir' "$STATE_PATH")/bb.db

printf 'state: %s\nproject: %s\nrepo: %s\nbb root: %s\n' \
  "$STATE_PATH" "$BB_PROJECT_ID" "$PROJECT_ROOT" "$BB_ROOT"
```

Basic health checks:

```bash
curl -fsS "$BB_SERVER_URL/api/v1/system/config" | jq
curl -fsS "$BB_SERVER_URL/api/v1/hosts" | jq
bb status
bb provider list
```

## Seed Manager QA Fixtures

The standalone helper creates a tiny repo. Add a small backend/frontend fixture
so provider-routing and same-environment review flows have something concrete to
work with:

```bash
mkdir -p "$PROJECT_ROOT/src"

cat > "$PROJECT_ROOT/src/server.js" <<'EOF'
export function normalizePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return 3000;
  }
  return port;
}

export function startServer(rawPort) {
  const port = normalizePort(rawPort);
  return `listening on ${port}`;
}
EOF

cat > "$PROJECT_ROOT/src/dashboard.js" <<'EOF'
export function dashboardMessage(userName) {
  return `Welcome, ${userName}!`;
}

export function dashboardButtonLabel() {
  return "Open dashboard";
}
EOF

cat > "$PROJECT_ROOT/src/dashboard.css" <<'EOF'
.dashboard {
  padding: 8px;
  color: #1a1a1a;
}

.dashboard-button {
  border: 1px solid #1a1a1a;
  background: white;
}
EOF

cat > "$PROJECT_ROOT/README.md" <<'EOF'
# Standalone QA Project

This repo is used for manager CLI QA.
EOF

git -C "$PROJECT_ROOT" add .
git -C "$PROJECT_ROOT" commit -m "Add manager QA fixtures"
```

## Evidence Shortcuts

Use these throughout the pass:

```bash
bb manager list --project "$BB_PROJECT_ID" --json | jq
bb manager status "$MANAGER_ID"
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$MANAGER_ID" --json | jq
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$MANAGER_ID" --archived --json | jq
bb thread log "$MANAGER_ID" --format verbose
bb thread log "$MANAGER_ID" --json --limit 200 | jq
bb thread show "$THREAD_ID" --json | jq
bb thread output "$THREAD_ID"
sqlite3 "$SERVER_DB" "select thread_id,name,cron,timezone,next_fire_at from manager_thread_nudges order by thread_id,name;"
find "$BB_ROOT/thread-storage" -maxdepth 2 -type f | sort
```

## Scenario 1: Codex Hire And Hatch

Hire the manager:

```bash
CODEX_MANAGER_ID=$(bb manager hire "$BB_PROJECT_ID" \
  --provider codex \
  --model gpt-5.4 \
  --reasoning-level medium \
  --json | jq -r '.id')

bb manager list --project "$BB_PROJECT_ID"
bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 240
bb manager status "$CODEX_MANAGER_ID"
bb thread output "$CODEX_MANAGER_ID"
bb thread log "$CODEX_MANAGER_ID" --format verbose
```

Expected:

- the hired thread is type `manager`
- the manager starts immediately and reaches `idle`
- the first visible manager message is a meet-and-greet sent without any user
  prompt
- the welcome behavior is visible in the manager log

## Scenario 2: Preference Intake And Simple Delegation

Give the manager durable routing and workflow preferences:

```bash
bb thread tell "$CODEX_MANAGER_ID" \
  "Call me Michael. Use codex for backend-heavy tasks and claude-code for frontend-heavy tasks. Our normal workflow is: use claude-code to write code, then use a different agent to review it in the same environment in an unbiased way, then forward the review output back to the original agent to triage and fix bugs."

bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 240
bb thread output "$CODEX_MANAGER_ID"
```

Ask for a backend-heavy task:

```bash
bb thread tell "$CODEX_MANAGER_ID" \
  "Please make a backend-focused change in src/server.js: keep normalizePort as the one place that validates the raw port, make startServer handle missing input more cleanly, and keep the change small and reviewable."

bb manager status "$CODEX_MANAGER_ID"
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$CODEX_MANAGER_ID" --json | jq
bb thread log "$CODEX_MANAGER_ID" --format verbose
bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 480
bb thread output "$CODEX_MANAGER_ID"
bb thread log "$CODEX_MANAGER_ID" --json --limit 200 | jq
```

Expected:

- the manager creates at least one managed child thread
- the child thread is linked with `parentThreadId=<manager-id>`
- the manager sends a short kickoff update after delegation
- the manager later sends a completion update after the child completes
- the manager does not pretend it directly made the repo edits itself

## Scenario 3: No Polling And Child Completion Signaling

Inspect the manager log from Scenario 2 and verify that completion was not
detected via repetitive CLI polling:

```bash
bb thread log "$CODEX_MANAGER_ID" --json --limit 200 > /tmp/codex-manager-log.json
jq '.[-80:]' /tmp/codex-manager-log.json
rg -n "bb thread show|bb thread list|bb thread log" /tmp/codex-manager-log.json
```

Expected:

- the manager reacts to a completion signal instead of spamming repeated
  `bb thread show`, `bb thread list`, or `bb thread log` loops
- the log shows a managed-thread completion event or equivalent system message
  before the final completion update

## Scenario 4: Multiple Threads And Provider Routing

Give the manager independent backend and frontend work in one request:

```bash
bb thread tell "$CODEX_MANAGER_ID" \
  "Please do two independent tasks in parallel. First, make a backend-focused cleanup in src/server.js. Second, make a frontend-focused UX cleanup in src/dashboard.js and src/dashboard.css. Use the routing preferences I gave you."

bb manager status "$CODEX_MANAGER_ID"
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$CODEX_MANAGER_ID" --json | jq
bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 600
bb thread output "$CODEX_MANAGER_ID"
```

Inspect the child threads:

```bash
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$CODEX_MANAGER_ID" --json > /tmp/codex-manager-children.json
jq '.[] | {id, title, status}' /tmp/codex-manager-children.json
```

Expected:

- the manager creates more than one child thread
- the child threads have clear, distinct titles
- the manager reports progress/completion per task instead of collapsing
  everything into a single worker
- provider routing follows the stated preference when possible

If the thread JSON includes provider fields, confirm that the backend-oriented
child used `codex` and the frontend-oriented child used `claude-code`. If not,
use the child-thread logs as supporting evidence.

## Scenario 5: Same-Environment Review Workflow

Ask the manager to run the user’s preferred code -> review -> triage workflow:

```bash
bb thread tell "$CODEX_MANAGER_ID" \
  "Please make one more backend change in src/server.js, then have a different agent review it in the same environment, send actionable feedback back to the implementation thread, and let me know when it is ready for a manual test pass."

bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 600
bb thread output "$CODEX_MANAGER_ID"
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$CODEX_MANAGER_ID" --json > /tmp/codex-manager-review-flow.json
jq '.[] | {id, title, status, environmentId}' /tmp/codex-manager-review-flow.json
```

Expected:

- the manager creates an implementation thread and a separate review thread
- the review thread reuses the implementation environment
- the manager forwards review findings back to the implementation thread when
  there is actionable feedback
- the manager notifies the user when the work is ready for manual testing

## Scenario 6: Ownership Transfer, Assigned Message, And Unassigned Message

Start a standalone unassigned thread:

```bash
UNASSIGNED_THREAD_ID=$(bb thread spawn \
  --project "$BB_PROJECT_ID" \
  --provider codex \
  --model gpt-5.3-codex \
  --reasoning-level medium \
  --title "Standalone prototype" \
  --prompt "Prototype a small improvement to README.md and src/dashboard.js. Work carefully and explain what you changed." \
  --json | jq -r '.id')

bb thread show "$UNASSIGNED_THREAD_ID"
```

Ask the manager to take it over and monitor it:

```bash
bb thread tell "$CODEX_MANAGER_ID" \
  "Can you monitor @thread:$UNASSIGNED_THREAD_ID for me, make sure we review its code with a separate agent when done, and let me know when it is ready for a manual test pass?"

bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 600
bb thread output "$CODEX_MANAGER_ID"
bb thread log "$CODEX_MANAGER_ID" --format verbose
```

Then explicitly remove ownership and inspect the manager again:

```bash
bb thread update "$UNASSIGNED_THREAD_ID" --clear-parent-thread
bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 240
bb thread log "$CODEX_MANAGER_ID" --format verbose
```

Expected:

- the manager receives and reacts to the assignment event
- the manager understands the goal and follow-on review requirement
- after `--clear-parent-thread`, the manager receives the unassignment event
- the manager stops treating the thread as active managed work after unassign

## Scenario 7: Archive Judgment

Ask for quick research that should become an archive candidate while keeping
useful implementation threads available:

```bash
bb thread tell "$CODEX_MANAGER_ID" \
  "Please do a quick research-only pass on the codebase structure, answer briefly, and clean up any no-longer-needed helper threads. Keep implementation threads around if they are still useful for follow-up."

bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 480
bb thread output "$CODEX_MANAGER_ID"
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$CODEX_MANAGER_ID" --json | jq
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$CODEX_MANAGER_ID" --archived --json | jq
```

Expected:

- at least one quick research/helper thread is archived once it is no longer
  useful
- still-useful implementation or review threads remain unarchived
- the manager does not archive active or likely-to-be-reused implementation
  threads prematurely

## Scenario 8: `ASYNC.md` Scheduling

Ask for reminder-style scheduled work:

```bash
bb thread tell "$CODEX_MANAGER_ID" "Remind me in 10 minutes to re-check the backend change."
bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 240

bb thread tell "$CODEX_MANAGER_ID" "Also remind me tomorrow at 8am to review the current manager threads."
bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 240

bb thread tell "$CODEX_MANAGER_ID" "Also add a daily 9am reminder to summarize active manager work."
bb thread wait "$CODEX_MANAGER_ID" --status idle --timeout 240
```

Inspect the file and synced nudges:

```bash
MANAGER_STORAGE_DIR="$BB_ROOT/thread-storage/$CODEX_MANAGER_ID"
sed -n '1,220p' "$MANAGER_STORAGE_DIR/ASYNC.md"
sqlite3 "$SERVER_DB" "select thread_id,name,cron,timezone from manager_thread_nudges where thread_id = '$CODEX_MANAGER_ID' order by name;"
bb thread log "$CODEX_MANAGER_ID" --format verbose
```

Expected:

- the manager writes `ASYNC.md` in its thread storage
- the file contains named schedules with aligned sections
- manager-thread nudges are synced for the manager after it goes idle
- the manager treats reminder requests as scheduling work, not as transient chat

## Scenario 9: Pi Manager Smoke

Run a smaller provider regression with Pi as the manager:

```bash
PI_MANAGER_ID=$(bb manager hire "$BB_PROJECT_ID" \
  --provider pi \
  --model anthropic/claude-opus-4-6 \
  --reasoning-level medium \
  --json | jq -r '.id')

bb thread wait "$PI_MANAGER_ID" --status idle --timeout 240
bb thread output "$PI_MANAGER_ID"
```

Give the Pi manager a simple delegated task:

```bash
bb thread tell "$PI_MANAGER_ID" \
  "Please make a small backend cleanup in src/server.js by delegating it, tell me when work starts, and tell me again when it is done."

bb manager status "$PI_MANAGER_ID"
bb thread list --project "$BB_PROJECT_ID" --parent-thread "$PI_MANAGER_ID" --json | jq
bb thread wait "$PI_MANAGER_ID" --status idle --timeout 480
bb thread output "$PI_MANAGER_ID"
bb thread log "$PI_MANAGER_ID" --format verbose
```

Expected:

- the Pi manager also hatches immediately
- the Pi manager delegates to a child thread instead of doing the work directly
- the Pi manager sends kickoff and completion updates

If Pi Anthropic is unstable or unavailable, rerun this scenario with:

```bash
bb manager hire "$BB_PROJECT_ID" \
  --provider pi \
  --model openai/gpt-5.4 \
  --reasoning-level medium \
  --json
```

Record the fallback in the pass log if used.

## Pass Criteria

This run is green only if all of the following are true:

- both `codex` and `pi` managers can be hired from the CLI
- the hired manager hatches immediately and initiates a meet-and-greet without
  prompting
- substantive work is delegated to child threads
- kickoff and completion updates are sent via the visible manager channel
- the manager does not rely on repeated polling loops to discover child
  completion
- assignment and unassignment behavior works for a monitored thread
- multi-thread delegation works
- same-environment review workflows work
- `ASYNC.md` scheduling results in synced nudges
- archive behavior reflects likely future value instead of archiving everything

## Failure Notes

Record at least:

- `$STATE_PATH`
- `$PROJECT_ROOT`
- `$BB_ROOT`
- manager IDs
- child thread IDs
- any archived child thread IDs
- relevant snippets from `bb thread log <manager-id>`
- the final manager outputs
- any scheduling rows from `manager_thread_nudges`

## Teardown

```bash
pnpm qa:standalone:stop --state "$STATE_PATH"
pnpm qa:standalone:cleanup
```
