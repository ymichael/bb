# Standalone Daemon CLI QA

This document describes how to QA BB server and CLI flows against a real provider.

Use this guide when you want to validate user-visible behavior end-to-end, especially after changes to:

- standalone daemon startup and restart
- thread spawn, follow-up, steer, and stop flows
- worktree provisioning and recovery
- CLI commands that should work against a running daemon

For a faster representative pass, use:

```bash
pnpm qa:daemon:manual-smoke
```

That script runs a disposable standalone daemon against the real provider and exercises a smaller CLI-first matrix. Use this full guide when you need exhaustive coverage or failure triage.

## Provider selection

By default, the QA pass uses the Codex provider. To run against a different provider, set `BB_PROVIDER` and the required auth:

**Claude Code:**
```bash
BB_PROVIDER=claude-code ANTHROPIC_API_KEY=... node scripts/qa/start-standalone-daemon-qa.mjs
ANTHROPIC_API_KEY=... pnpm qa:daemon:smoke:claude-code
```

**Pi:**
```bash
BB_PROVIDER=pi node scripts/qa/start-standalone-daemon-qa.mjs --provider pi
pnpm qa:daemon:smoke:pi
```

Pi reads auth from `~/.pi/agent/auth.json` (set up via `npx @mariozechner/pi-ai login`). No env var needed.

All the test scenarios in this document apply to all providers. The only difference is the environment setup. Claude Code and Pi do not support rename, so `thread/name/set` tests should be skipped for those providers.

### Multi-provider coverage strategy

It is fine to run the full exhaustive QA pass against only one provider and then run a lighter smoke pass (`pnpm qa:daemon:smoke` or `pnpm qa:daemon:smoke:claude-code`) against the other supported providers. The daemon lifecycle, restart, and recovery behaviors are provider-agnostic — a full pass on one provider gives high confidence that the core paths work, while a smoke pass on the others confirms that the provider-specific bridge and adapter wiring is healthy.

**Multi-provider coexistence is NOT covered by single-provider passes.** When touching environment-daemon runtime code, provider bridges, or command routing, you MUST also run the multi-provider scenario below. Bugs in this area only manifest when two different providers are active in the same env-daemon simultaneously — single-provider tests will pass while multi-provider usage is completely broken.

## Rules

- Use the built binaries directly:
  - `node apps/server/dist/index.js`
  - `node apps/cli/dist/index.js`
- For restart and relaunch checks, use the exact Node binary that started the standalone daemon. Do not assume plain `node` resolves to the same runtime across shells.
- Use the real Codex provider. Do not use the fake-codex test harness for this QA pass.
- Some recovery scenarios in the automated suite are fake-provider-only because they require explicit worker-loss control hooks. Those are covered by `pnpm qa:daemon:recovery:fake`, not by the real-provider scripts.
- Prefer disposable test repositories and disposable BB roots so failures do not contaminate real projects.
- When testing a user’s already-running main daemon, do not run `bb daemon restart` unless they explicitly want that daemon restarted.
- If a test project root is temporary, keep it on disk until all worktree checks finish. Cleaning it up early will correctly fail with `project_root_missing`, which is a test setup mistake, not a daemon bug.

## Prerequisites

Build the daemon stack first:

```bash
pnpm exec turbo run build \
  --filter=@bb/environment-daemon \
  --filter=@bb/server \
  --filter=@bb/cli
```

For Codex: confirm `codex` is available in `PATH` and can be used by the daemon.

For Claude Code: confirm `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set and the `@bb/claude-code-bridge` package is built (`pnpm --filter @bb/claude-code-bridge build`).

For Pi: confirm `pi` is in `PATH` and auth is configured (`npx @mariozechner/pi-ai login`). The `@bb/pi-bridge` package must be built (`pnpm --filter @bb/pi-bridge build`).

Recommended during restart/liveness QA:

- keep one shell tailing the daemon log:

```bash
tail -f "$bb_root/logs/daemon.log"
```

- keep a separate persistent shell or terminal tab for daemon relaunches; avoid backgrounding the relaunched daemon from a one-shot shell command

## Standalone Daemon QA

This path validates the standalone daemon process directly, with its own BB root.

Run the cases in order and record pass/fail for each one. Do not stop the whole pass after the
first failure unless the daemon is completely unusable. The goal is to learn which recovery paths
still work, not just which case fails first.

### 1. Prepare a disposable project

Fast setup wrapper:

```bash
node scripts/qa/start-standalone-daemon-qa.mjs
```

That creates a disposable repo + BB root, starts the standalone daemon, creates a project, and prints the resulting `daemonUrl`, `projectId`, paths, daemon PID, exact Node runtime details, a ready-to-run `relaunchCommand`, and a `cleanupCommand` as JSON.

Keep the reported `nodePath`, `nodeVersion`, and `nodeAbi` with your QA notes. If you later relaunch the daemon under a different Node ABI, native modules such as `better-sqlite3` can fail before BB finishes booting.

When you finish the pass, run the reported `cleanupCommand` to stop the detached daemon and remove the disposable temp root.

Manual setup:

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

### 2. Start the standalone daemon

```bash
BB_ROOT="$bb_root" \
node apps/server/dist/index.js --port 4311
```

For Claude Code, also set the provider:

```bash
BB_ROOT="$bb_root" \
BB_PROVIDER=claude-code \
ANTHROPIC_API_KEY=... \
node apps/server/dist/index.js --port 4311
```

In another shell, target that daemon:

```bash
export BB_DAEMON_URL=http://127.0.0.1:4311
```

Sanity check:

```bash
node apps/cli/dist/index.js daemon health
```

### 3. Create a project

```bash
node apps/cli/dist/index.js project create --name qa-standalone --root "$project_root"
node apps/cli/dist/index.js project list
node apps/cli/dist/index.js project files --project <project-id> alpha
```

Record the real `<project-id>` returned by `project create` and reuse it in later commands. Do not
assume it is `project-1`.

### 3a. CLI inspection helpers

Keep these handy during the pass:

```bash
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

Use SQLite only when the CLI/API surfaces are insufficient and you need to confirm the daemon’s persisted view directly.

### 3b. Provider verification

After spawning a thread and letting it reach `idle`, verify that the thread record and its events carry the correct `providerId` matching the configured provider:

```bash
node apps/cli/dist/index.js thread show <thread-id>
```

Expected: the `providerId` field matches the configured `BB_PROVIDER` (e.g. `codex`, `claude-code`, or `pi`).

Inspect raw events to confirm provider event envelopes carry the correct provider:

```bash
node apps/cli/dist/index.js thread status <thread-id> --recent-events 10 --event-mode raw
```

Expected: any provider event envelope in the event data should contain `"providerId":"<expected-provider>"`.

### 4. Validate direct/local flows

Required matrix:

- `local` start thread
- `local` follow-up
- `local` two immediate follow-ups in a row
- `local` steer
- `local` stop then follow-up
- `local` restart while active -> surviving env-agent reconnect
- `local` restart while active -> missing env-agent becomes \`error\`
- `local` follow-up after restart failure
- `local` immediate follow-up after idle completion
- `local` restart while idle -> follow-up starts a fresh env-agent cleanly

Spawn:

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --prompt 'Reply with exactly LOCAL-START and finish.'
```

Follow-up:

```bash
node apps/cli/dist/index.js thread tell <thread-id> \
  'Reply with exactly LOCAL-FOLLOWUP and finish.'
```

Steer:

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --prompt 'Read every file carefully, think for a while, and produce a long structured summary.'

Wait until `thread wait <thread-id> --event turn/started --timeout 30` succeeds, then steer:

node apps/cli/dist/index.js thread steer <thread-id> \
  'Stop the previous plan. Reply with exactly LOCAL-STEER and finish.'
```

Stop then follow-up:

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --prompt 'Spend time inspecting files before answering; do not finish quickly.'

node apps/cli/dist/index.js thread stop <thread-id>
node apps/cli/dist/index.js thread tell <thread-id> \
  'Reply with exactly LOCAL-POST-STOP and finish.'
```

Useful checks while waiting:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread wait <thread-id> --status idle --timeout 90
node apps/cli/dist/index.js thread sessions <thread-id>
find "$bb_root/environment-agents" -maxdepth 3 -type f | sort
```

Expected result:

- thread eventually reaches `idle`
- `thread output` contains the exact requested token
- `thread log` shows the expected `turn/started` and `turn/completed` events
- `thread show` and raw `thread status` agree on the terminal state
- the thread row in SQLite matches the CLI status
- while the local thread is active, a managed env-agent state file appears under `$bb_root/environment-agents`
- after the local thread returns to `idle`, that local env-agent state file is removed within a short delay

### 5. Validate worktree flows

Required matrix:

- `worktree` start thread
- `worktree` follow-up
- `worktree` two immediate follow-ups in a row
- `worktree` stop then follow-up
- `worktree` restart while active -> surviving env-agent reconnect
- `worktree` restart while active -> missing env-agent becomes \`error\`
- `worktree` follow-up after restart failure
- `worktree` archive/unarchive
- `worktree` restart recovery
- `worktree` follow-up after restart recovery
- `worktree` promote/demote
- `worktree` immediate follow-up after idle completion
- `worktree` restart while idle -> follow-up starts a fresh env-agent cleanly

Spawn a worktree thread:

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --environment worktree \
  --prompt 'Reply with exactly WORKTREE-START and finish.'
```

Follow-up:

```bash
node apps/cli/dist/index.js thread tell <thread-id> \
  'Reply with exactly WORKTREE-FOLLOWUP and finish.'
```

Stop then follow-up:

```bash
node apps/cli/dist/index.js thread tell <thread-id> \
  'Spend time inspecting the files before answering; do not finish quickly.'

node apps/cli/dist/index.js thread stop <thread-id>
node apps/cli/dist/index.js thread tell <thread-id> \
  'Reply with exactly WORKTREE-POST-STOP and finish.'
```

Promote/demote checks:

```bash
node apps/cli/dist/index.js thread promote-status --project <project-id>
node apps/cli/dist/index.js thread promote <thread-id>
node apps/cli/dist/index.js thread promote-status --project <project-id>
node apps/cli/dist/index.js thread demote <thread-id>
node apps/cli/dist/index.js thread promote-status --project <project-id>
```

Extra worktree checks:

- confirm the worktree path still exists before restart cases begin
- after promote/demote, confirm `thread promote-status` matches the underlying git checkout state

Archive/unarchive checks:

Wait until the worktree thread is back to `idle`, then:

```bash
node apps/cli/dist/index.js thread archive <thread-id>
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread tell <thread-id> \
  'Reply with exactly SHOULD-NOT-RUN and finish.'
```

Expected while archived:

- `thread show` prints an `Archived:` timestamp
- `thread tell` fails with `HTTP 409`

Then unarchive and confirm follow-up works again:

```bash
node apps/cli/dist/index.js thread unarchive <thread-id>
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread tell <thread-id> \
  'Reply with exactly WORKTREE-POST-UNARCHIVE and finish.'
```

Expected after unarchive:

- `thread show` no longer prints `Archived:`
- `thread output` eventually contains `WORKTREE-POST-UNARCHIVE`

### 6. Validate standalone restart behavior

Only do this on the standalone daemon you started for testing.

Required matrix:

- blocked restart while local thread is active
- forced restart while local thread is active
- local thread stays `active` if the env-agent checks back in
- local thread becomes `error` if the env-agent does not check back in
- local thread accepts a follow-up after restart failure
- local idle thread follow-up after restart starts a fresh env-agent and closes the prior idle session cleanly
- blocked restart while worktree thread is active
- forced restart while worktree thread is active
- worktree thread stays `active` if the env-agent checks back in
- worktree thread becomes `error` if the env-agent does not check back in
- worktree thread accepts a follow-up after restart failure
- worktree idle thread follow-up after restart starts a fresh env-agent and closes the prior idle session cleanly
- active-thread restart failure emits `system/error` with `provider_unavailable`
- follow-up after restart failure clears `error` back to a healthy terminal state
- restart during `provisioned` or just before first real `turn/started`
- queued follow-up present while the env-agent is lost
- archive/unarchive after worker-loss recovery
- late old env-agent traffic after replacement does not change thread state

For both environments, start a thread and wait until `thread status --recent-events ... --event-mode raw`
shows a real `turn/started` event, then in another shell:

```bash
node apps/cli/dist/index.js daemon restart
```

Expected when active work exists:

- exit status non-zero
- stderr explains shutdown is blocked by active threads

Then force restart:

```bash
node apps/cli/dist/index.js daemon restart --force
```

### 7. Validate shared environment / multi-thread behavior

This is the canonical manual pass for the new first-class environment model. Do not skip it after
changes to environment attachments, env-daemon session ownership, shared runtime reuse, restart
recovery, or thread archive/delete behavior.

Required matrix:

- spawn a managed worktree thread and capture its first-class `environmentId`
- spawn a second thread attached to that same `environmentId`
- confirm both threads report the same attached environment
- confirm `thread sessions` on both threads shows the same active env-daemon session
- run follow-ups on both threads at the same time
- archive one thread while the sibling remains attached
- confirm the archived thread rejects `tell`
- confirm the sibling still accepts follow-ups on the same shared environment
- restart the daemon while the shared environment exists
- confirm a sibling follow-up after restart reuses or recreates the env-daemon cleanly and returns to `idle`

**Implicit shared environment** (critical — covers the `reserveThreadEnvironment` attachment path):

- spawn two threads from the project main view **without** selecting a specific environment
  (both will be assigned to the project's local environment during provisioning)
- confirm both threads have the same `environmentId` in `thread show`
- confirm both threads appear in `thread_environment_attachments` (query the DB or check
  `thread sessions` shows a shared active session)
- run follow-ups on both threads and confirm events flow correctly for both
- if either thread's events cause a 500 on the env-daemon session messages endpoint, the
  `thread_environment_attachments` row is missing — this is a regression

Suggested flow:

1. Spawn the first worktree thread and wait for `idle`:

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --environment worktree \
  --prompt 'Reply with exactly SHARED-ONE and finish.'
```

2. Inspect the thread and record its attached environment id:

```bash
node apps/cli/dist/index.js thread show <thread-1>
node apps/cli/dist/index.js thread sessions <thread-1>
```

Use the attached environment id from `thread show` as `<environment-id>`.

3. Spawn a second thread directly into that environment:

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --environment <environment-id> \
  --prompt 'Reply with exactly SHARED-TWO and finish.'
```

4. Confirm both threads point at the same environment and same active env-daemon session:

```bash
node apps/cli/dist/index.js thread show <thread-1>
node apps/cli/dist/index.js thread show <thread-2>
node apps/cli/dist/index.js thread sessions <thread-1>
node apps/cli/dist/index.js thread sessions <thread-2>
```

Expected:

- both `thread show` outputs reference the same attached environment id
- both `thread sessions` outputs include the same active session id

5. Run follow-ups on both threads without waiting between them:

```bash
node apps/cli/dist/index.js thread tell <thread-1> \
  'Reply with exactly SHARED-FOLLOWUP-ONE and finish.'
node apps/cli/dist/index.js thread tell <thread-2> \
  'Reply with exactly SHARED-FOLLOWUP-TWO and finish.'
```

Wait for both to return to `idle`, then verify:

```bash
node apps/cli/dist/index.js thread output <thread-1>
node apps/cli/dist/index.js thread output <thread-2>
```

6. Archive the first thread and confirm the sibling survives:

```bash
node apps/cli/dist/index.js thread archive <thread-1>
node apps/cli/dist/index.js thread tell <thread-1> \
  'Reply with exactly SHOULD-NOT-RUN and finish.'
node apps/cli/dist/index.js thread tell <thread-2> \
  'Reply with exactly SHARED-SIBLING-SURVIVES and finish.'
```

Expected:

- archived `thread-1` rejects `tell` with `HTTP 409`
- `thread-2` still reaches `idle`
- `thread-2` still shows the same attached environment id

7. Restart the daemon and verify shared-thread recovery:

```bash
node apps/cli/dist/index.js daemon restart --force
```

Relaunch the standalone daemon using the same Node binary and `BB_ROOT`, wait for health,
then run:

```bash
node apps/cli/dist/index.js thread tell <thread-2> \
  'Reply with exactly SHARED-POST-RESTART and finish.'
node apps/cli/dist/index.js thread wait <thread-2> --status idle --timeout 180
node apps/cli/dist/index.js thread output <thread-2>
```

Expected:

- the follow-up succeeds after restart
- `thread-2` returns to `idle`
- output contains `SHARED-POST-RESTART`
- `thread show <thread-2>` still references the same attached environment id unless the environment was intentionally reprovisioned

Expected:

- CLI reports shutdown requested
- daemon exits cleanly
- after relaunching the daemon on the same `BB_ROOT`, the daemon nudges the previously active env-agent
- if the same env-agent checks back in and flushes its buffered state, the thread continues normally
- if the env-agent does not check back in before the liveness deadline, the daemon marks the thread `error`
- `thread tell <thread-id> 'Reply with exactly ... and finish.'` succeeds after the thread reaches either a healthy resumed state or `error`
- after relaunching the daemon on the same `BB_ROOT`, the interrupted thread eventually returns to `idle`
- the interrupted turn may resume or complete before the thread returns to `idle`; that is acceptable as long as recovery finishes cleanly
- `thread tell <thread-id> 'Reply with exactly ... and finish.'` succeeds after relaunch

Relaunch:

```bash
node scripts/qa/relaunch-standalone-daemon-qa.mjs \
  --bb-root "$bb_root" \
  --port 4311
```

If you used `start-standalone-daemon-qa.mjs`, prefer its printed `relaunchCommand` or pass the reported `nodePath` explicitly:

```bash
node scripts/qa/relaunch-standalone-daemon-qa.mjs \
  --bb-root "$bb_root" \
  --port 4311 \
  --node-path "/absolute/path/to/node"
```

Avoid `bash -lc '... node ...'` for this step unless you first verify that `command -v node` resolves to the same runtime as the setup output. Different login shells can put different Node installations first in `PATH`, which can break native modules and create a false QA failure.

Then re-check:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread log <thread-id>
```

Daemon-log expectations after relaunch:

- surviving-worker case:
  - startup log reports at least one env-agent was poked
  - the original session eventually resumes traffic
- missing-worker case:
  - startup log reports at least one session is awaiting heartbeat timeout handling
  - later, the thread transitions to `error` without needing any manual cleanup

Additional idle-thread follow-up checks for both `local` and `worktree`:

1. Start a thread and let it complete to `idle`.
2. Immediately send a follow-up before doing any restart.
3. Verify that the follow-up succeeds without any transient `agent_shutdown` / session-closed failure.
4. Start another thread and let it complete to `idle`.
5. Record the last active env-agent control endpoint from the BB DB:

```bash
sqlite3 "$bb_root/bb.db" \
  "select control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at desc limit 1;"
```

Also record the current session count and all session rows:

```bash
sqlite3 "$bb_root/bb.db" \
  "select count(*) from environment_agent_sessions where thread_id='<thread-id>';"

sqlite3 "$bb_root/bb.db" \
  "select id,status,control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at;"
```

6. Force-restart the daemon and relaunch it on the same `BB_ROOT`.
7. Send a follow-up to the now-idle thread.
8. Verify that the daemon starts a fresh env-agent session cleanly:

```bash
sqlite3 "$bb_root/bb.db" \
  "select count(*) from environment_agent_sessions where thread_id='<thread-id>';"

sqlite3 "$bb_root/bb.db" \
  "select id,status,close_reason,control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at;"
```

Expected result:

- the follow-up succeeds
- the thread returns to `idle`
- the immediate follow-up before restart does not fail with `agent_shutdown`
- after restart, the session count increases by exactly one for the fresh follow-up session
- the previously idle session is closed or expires rather than remaining the live worker for the new follow-up
- the daemon does not leave multiple live sessions competing for the same idle thread
- by the time the follow-up settles back to `idle`, there may be zero active session rows because BB intentionally retires the worker again; check for duplicate active rows during the run, not after final idle

Additional rapid-repeat follow-up check for both `local` and `worktree`:

1. Start a thread and wait for it to complete to `idle`.
2. Send one follow-up immediately after `idle`.
3. As soon as it returns to `idle`, send a second follow-up immediately.
4. Confirm each turn completes successfully and inspect session rows:

```bash
sqlite3 "$bb_root/bb.db" \
  "select id,status,close_reason,control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at;"
```

Expected result:

- neither follow-up fails with `agent_shutdown`
- the thread reaches `idle` after each follow-up
- session rows may grow, but there is never more than one active session for the thread at a time

Recommended provisioning-boundary restart check:

1. Spawn a fresh thread.
2. Restart the daemon after `provisioned` work has begun but before the first real provider `turn/started` arrives.
3. Relaunch the daemon and inspect:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread log <thread-id>
sqlite3 "$bb_root/bb.db" \
  "select id,status from threads where id='<thread-id>';"
```

Expected result:

- the thread either continues into `active`/`idle` normally or lands in `provisioning_failed`
- it must not silently jump straight to `idle` without a real turn
- there must not be duplicate live env-agent sessions for the thread

Recommended queued-follow-up worker-loss check:

1. Start a long-running turn and wait for `turn/started`.
2. Queue a follow-up while that turn is still active.
3. Force-restart the daemon and hard-kill the env-agent.
4. Relaunch the daemon and wait for the active thread to become `error`.
5. Send a manual follow-up and then inspect the queue and events.

Expected result:

- the active turn becomes `error` with `provider_unavailable`
- the queued follow-up is not silently lost or executed against the dead session
- after recovery, the thread converges back to a healthy terminal state

Recommended archive/unarchive recovery check:

1. Drive a thread into `error` via the missing-worker restart path.
2. Archive the thread.
3. Verify the environment/worktree is cleaned up as expected.
4. Unarchive the thread.
5. Send a follow-up.

Expected result:

- archive succeeds without leaving duplicate session state behind
- unarchive does not resurrect stale env-agent sessions
- follow-up after unarchive still works

Recommended late-old-agent noise check:

1. Run a forced restart where the old env-agent does not reconnect successfully.
2. Watch daemon logs for late 404s from the old env-agent.
3. While that noise is happening, inspect the thread repeatedly.

Expected result:

- late old-agent `session/open` or `session/messages` 404s may appear in logs
- thread status, events, and output do not regress or mutate because of that stale traffic
- only the current accepted session can move the thread forward

Missing-worker restart check:

1. Start a long-running turn, wait for a real `turn/started`, then record its `control_base_url`.
2. Force-restart the daemon.
3. Kill the env-agent process or otherwise make that `control_base_url` unreachable before relaunching the daemon.
4. Relaunch the daemon on the same `BB_ROOT`.
5. Wait through the liveness deadline, then verify:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread log <thread-id>
sqlite3 "$bb_root/bb.db" \
  "select status from threads where id='<thread-id>';"
```

Expected result:

- the thread becomes `error`
- the log contains `system/error`
- the latest error event includes `provider_unavailable`
- the thread does not silently become `idle`

Follow-up-after-error check:

1. After the thread reaches `error`, immediately run:

```bash
node apps/cli/dist/index.js thread tell <thread-id> \
  'Reply with exactly AFTER-ERROR and finish.'
```

2. Poll both CLI and SQLite until the thread settles.

Expected result:

- the follow-up is accepted without manual repair
- the thread may briefly still read as `error`, but it must converge to a healthy terminal state
- final CLI status and SQLite thread status agree
- `thread output` contains the requested token

Recommended explicit provisioning-interruption check:

1. Spawn a fresh thread.
2. Restart the daemon while the thread is still `provisioning` or `provisioned` and before the first real `turn/started`.
3. Relaunch the daemon and observe the result.

Expected result:

- no duplicate env-agent is created during retry/recovery
- the thread either continues into `active` or lands in `provisioning_failed`
- it must not jump directly to `idle` without a real successful turn

### 8. Validate multi-provider coexistence

**This is a critical scenario.** Bugs in the env-daemon runtime's multi-child
management only appear when two different providers are active in the same
environment simultaneously. Single-provider tests will pass while multi-provider
usage is completely broken. Past bugs in this area include:

- RPC commands routed to the wrong provider child (thread hangs forever)
- RPC responses written to the wrong provider's stdin (tool calls hang)
- Double-initialization rejected by the provider ("Already initialized")
- One provider child exiting spuriously rejects another child's in-flight requests

Prerequisites: at least two providers must be available (e.g. codex + pi, or
codex + claude-code). The daemon must be started without `BB_PROVIDER` so it
uses the default and can accept explicit `providerId` per thread.

**Basic multi-provider flow:**

1. Spawn a thread with provider A (e.g. codex) in the project's local environment:

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --provider codex \
  --prompt 'Reply with exactly CODEX-HELLO and finish.'
node apps/cli/dist/index.js thread wait <thread-a> --status idle --timeout 120
node apps/cli/dist/index.js thread output <thread-a>
```

2. Spawn a second thread with provider B (e.g. pi) in the same project (same local environment):

```bash
node apps/cli/dist/index.js thread spawn \
  --project <project-id> \
  --provider pi \
  --prompt 'Reply with exactly PI-HELLO and finish.'
node apps/cli/dist/index.js thread wait <thread-b> --status idle --timeout 120
node apps/cli/dist/index.js thread output <thread-b>
```

3. Send follow-ups to both threads (tests that the correct provider child handles each):

```bash
node apps/cli/dist/index.js thread tell <thread-a> \
  'Reply with exactly CODEX-FOLLOWUP and finish.'
node apps/cli/dist/index.js thread tell <thread-b> \
  'Reply with exactly PI-FOLLOWUP and finish.'
node apps/cli/dist/index.js thread wait <thread-a> --status idle --timeout 120
node apps/cli/dist/index.js thread wait <thread-b> --status idle --timeout 120
node apps/cli/dist/index.js thread output <thread-a>
node apps/cli/dist/index.js thread output <thread-b>
```

Expected:

- both threads reach `idle` (not stuck `active`, not `provisioning_failed`)
- `thread show <thread-a>` has `providerId: codex`
- `thread show <thread-b>` has `providerId: pi`
- both threads share the same `environmentId` (local environment)
- follow-up output for thread-a comes from codex, not pi
- follow-up output for thread-b comes from pi, not codex
- no "Already initialized" errors in the daemon log
- no provider rpc errors or timeouts in the event stream

**What to look for if it fails:**

- Thread stuck `active` with `turn/started` but no `turn/completed` → command routing bug: RPC commands going to wrong child
- `provisioning_failed` with "Already initialized" → `providerInitializedPid` not tracked per-child
- `provisioning_failed` with "Timed out waiting for active environment-agent session" → env-daemon failed to spawn or connect
- Thread output contains response from the wrong provider → stdin writes going to wrong child

## Main Daemon QA

Use this when the user already has the main daemon running and wants direct QA against it.

### Safe scope

- OK:
  - `daemon health`
  - `project create/list/files`
  - `thread spawn/show/status/log/output`
  - `thread tell`
  - `thread steer`
  - `thread stop`
  - `thread archive` / `thread unarchive`
  - worktree spawn/follow-up
- Avoid unless explicitly approved:
  - `daemon restart`

### Procedure

1. Create a disposable git repo under `/tmp`.
2. Register it with `bb project create`.
3. Run the same local/worktree thread flows as above, including archive/unarchive coverage.
4. Leave the disposable project on disk until all worktree checks are complete.
5. Inspect failures with:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread log <thread-id>
node apps/cli/dist/index.js daemon health
```

When a result looks suspicious, also inspect:

```bash
sqlite3 "$bb_root/bb.db" \
  "select id,status,control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at;"
```

## Interpreting Failures

- `provisioning_failed` with `project_root_missing`:
  - The test project directory was deleted or moved.
  - Fix the test setup before blaming the daemon.

- `thread steer` returns `HTTP 409`:
  - The thread has no active turn yet.
  - Wait for an actual provider `turn/started` event, not just a transient thread status of `active`.

- Restart appears to work, but the thread stays `active` without reconnect progress or a transition to `error`:
  - This is a real liveness/recovery bug candidate.
  - Check whether the thread log shows daemon restart, missing env-agent check-ins, or a stuck reconnect path.

- `thread tell` after `thread stop` fails with missing session state:
  - This is a real recovery bug candidate.
  - Capture `thread show`, `thread log`, and daemon logs before retrying.

- A follow-up fails with `Environment-agent session ... closed (...) while command execution was in progress`:
  - This is a real session retirement / cleanup race.
  - Capture session rows from SQLite and the daemon log around the failing `tell`.

- Session rows look “wrong” after a successful follow-up:
  - Do not assume a healthy thread must still have an active env-agent session after final `idle`.
  - The real invariant is that there must not be duplicate active sessions competing for the same thread.

- local thread reaches `idle`, but its env-agent state file or process still exists after a short delay:
  - This is a real local cleanup bug candidate.
  - Capture `thread show`, `thread log`, `find "$bb_root/environment-agents" -maxdepth 3 -type f`, and `ps` output before cleaning it up manually.

## QA Tiers

Use the tier names **light**, **extended**, or **full** when requesting a QA pass. Each tier includes all items from the tiers above it.

### Light QA pass

~5 minutes per provider. Catches bridge wiring, event translation, and basic turn lifecycle bugs. Run this on every PR for all providers.

- standalone daemon health
- project create, list, files
- local start
- local follow-up
- local steer after confirmed `turn/started`
- worktree start
- worktree follow-up
- provider verification (`providerId` in thread show + raw event envelopes)

### Extended QA pass

~15 minutes per provider. Catches session cleanup races, archive state bugs, and promote/demote correctness. Run this when changing lifecycle, state management, or session handling code.

Everything in **light**, plus:

- local stop then follow-up
- local two immediate follow-ups in a row
- worktree stop then follow-up
- worktree two immediate follow-ups in a row
- worktree promote-status, promote, demote
- worktree archive removes the managed worktree and clears env-agent state
- archived thread is visibly marked as archived in thread inspection output
- worktree unarchive then follow-up
- **multi-provider coexistence** (see scenario below) — spawn threads with two different providers in the same project/environment and confirm both work

### Full QA pass

~30 minutes. Run against one real provider + the fake recovery suite. Run this before shipping big daemon or environment-agent changes.

Everything in **extended**, plus:

- local blocked restart
- local forced restart with surviving env-agent reconnect or thread `error`
- local follow-up after restart failure
- local idle thread follow-up after restart starts fresh env-agent cleanly
- worktree blocked restart
- worktree forced restart with surviving env-agent reconnect or thread `error`
- worktree follow-up after restart failure
- worktree idle thread follow-up after restart starts fresh env-agent cleanly
- active-thread restart failure emits `system/error` with `provider_unavailable`
- provisioning-boundary restart check
- queued follow-up during worker loss
- archive/unarchive after worker-loss recovery
- late old-agent noise rejection
- shared environment multi-thread spawn, sibling follow-up, archive sibling, restart recovery
- `pnpm qa:daemon:recovery:fake` (8 automated fake-provider tests)

## Cleanup

For standalone runs:

```bash
rm -rf "$tmp_root"
```

For main-daemon runs:

- keep the temp project around until worktree checks are done
- after QA completes, remove the temp repo manually
