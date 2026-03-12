# Standalone Daemon CLI QA

This document describes how to QA Beanbag daemon and CLI flows against the real Codex provider.

Use this guide when you want to validate user-visible behavior end-to-end, especially after changes to:

- standalone daemon startup and restart
- thread spawn, follow-up, steer, and stop flows
- worktree provisioning and recovery
- CLI commands that should work against a running daemon

## Rules

- Use the built binaries directly:
  - `node apps/daemon/dist/index.js`
  - `node apps/cli/dist/index.js`
- Use the real Codex provider. Do not use the fake-codex test harness for this QA pass.
- Prefer disposable test repositories and disposable Beanbag roots so failures do not contaminate real projects.
- When testing a user’s already-running main daemon, do not run `bb daemon restart` unless they explicitly want that daemon restarted.
- If a test project root is temporary, keep it on disk until all worktree checks finish. Cleaning it up early will correctly fail with `project_root_missing`, which is a test setup mistake, not a daemon bug.

## Prerequisites

Build the CLI and daemon first:

```bash
pnpm exec turbo run build --filter=@beanbag/daemon --filter=@beanbag/cli
```

Confirm Codex is available in `PATH` and can be used by the daemon.

Optional but strongly recommended during restart/liveness QA:

- keep `sqlite3` available so you can inspect `threads`, `events`, and `environment_agent_sessions`
- keep one shell tailing the daemon log:

```bash
tail -f "$beanbag_root/logs/daemon.log"
```

## Standalone Daemon QA

This path validates the standalone daemon process directly, with its own Beanbag root.

Run the cases in order and record pass/fail for each one. Do not stop the whole pass after the
first failure unless the daemon is completely unusable. The goal is to learn which recovery paths
still work, not just which case fails first.

### 1. Prepare a disposable project

```bash
tmp_root=$(mktemp -d /tmp/beanbag-qa-XXXXXX)
project_root="$tmp_root/project"
beanbag_root="$tmp_root/beanbag-root"
mkdir -p "$project_root" "$beanbag_root"
printf 'alpha\n' > "$project_root/alpha.txt"
printf '# beta\n' > "$project_root/beta.md"
git -C "$project_root" init -b main
git -C "$project_root" add .
GIT_AUTHOR_NAME='Beanbag Test' \
GIT_AUTHOR_EMAIL='beanbag-test@example.com' \
GIT_COMMITTER_NAME='Beanbag Test' \
GIT_COMMITTER_EMAIL='beanbag-test@example.com' \
git -C "$project_root" commit -m init
```

### 2. Start the standalone daemon

```bash
BEANBAG_ROOT="$beanbag_root" \
node apps/daemon/dist/index.js --port 4311
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

Record the project id once and reuse it in every command below. Avoid copying `project_1` from examples or old logs.

### 3a. DB inspection helpers

Keep these handy during the pass:

```bash
sqlite3 "$beanbag_root/beanbag.db" \
  "select id,status,updated_at from threads order by updated_at desc;"

sqlite3 "$beanbag_root/beanbag.db" \
  "select thread_id,status,control_base_url,lease_expires_at,last_heartbeat_at from environment_agent_sessions order by created_at desc;"

sqlite3 "$beanbag_root/beanbag.db" \
  "select thread_id,type,substr(json_data,1,160) from events order by seq desc limit 20;"
```

Use them to confirm the daemon’s persisted view, not just CLI rendering.

### 4. Validate direct/local flows

Required matrix:

- `local` start thread
- `local` follow-up
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

Wait until `thread status --recent-events ... --event-mode raw` shows a real `turn/started`
provider event for the new turn, then steer:

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
node apps/cli/dist/index.js thread status <thread-id> --recent-events 10 --event-mode raw --include-low-signal
node apps/cli/dist/index.js thread log <thread-id>
node apps/cli/dist/index.js thread output <thread-id>
```

Expected result:

- thread eventually reaches `idle`
- `thread output` contains the exact requested token
- `thread log` shows the expected `turn/started` and `turn/completed` events
- `thread show` and raw `thread status` agree on the terminal state
- the thread row in SQLite matches the CLI status

### 5. Validate worktree flows

Required matrix:

- `worktree` start thread
- `worktree` follow-up
- `worktree` stop then follow-up
- `worktree` restart while active -> surviving env-agent reconnect
- `worktree` restart while active -> missing env-agent becomes \`error\`
- `worktree` follow-up after restart failure
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

Expected:

- CLI reports shutdown requested
- daemon exits cleanly
- after relaunching the daemon on the same `BEANBAG_ROOT`, the daemon nudges the previously active env-agent
- if the same env-agent checks back in and flushes its buffered state, the thread continues normally
- if the env-agent does not check back in before the liveness deadline, the daemon marks the thread `error`
- `thread tell <thread-id> 'Reply with exactly ... and finish.'` succeeds after the thread reaches either a healthy resumed state or `error`

Relaunch:

```bash
BEANBAG_ROOT="$beanbag_root" \
node apps/daemon/dist/index.js --port 4311
```

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
5. Record the last active env-agent control endpoint from the Beanbag DB:

```bash
sqlite3 "$beanbag_root/beanbag.db" \
  "select control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at desc limit 1;"
```

Also record the current session count and all session rows:

```bash
sqlite3 "$beanbag_root/beanbag.db" \
  "select count(*) from environment_agent_sessions where thread_id='<thread-id>';"

sqlite3 "$beanbag_root/beanbag.db" \
  "select id,status,control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at;"
```

6. Force-restart the daemon and relaunch it on the same `BEANBAG_ROOT`.
7. Send a follow-up to the now-idle thread.
8. Verify that the daemon starts a fresh env-agent session cleanly:

```bash
sqlite3 "$beanbag_root/beanbag.db" \
  "select count(*) from environment_agent_sessions where thread_id='<thread-id>';"

sqlite3 "$beanbag_root/beanbag.db" \
  "select id,status,close_reason,control_base_url from environment_agent_sessions where thread_id='<thread-id>' order by created_at;"
```

Expected result:

- the follow-up succeeds
- the thread returns to `idle`
- the immediate follow-up before restart does not fail with `agent_shutdown`
- after restart, the session count increases by exactly one for the fresh follow-up session
- the previously idle session is closed or expires rather than remaining the live worker for the new follow-up
- the daemon does not leave multiple live sessions competing for the same idle thread
- by the time the follow-up settles back to `idle`, there may be zero active session rows because Beanbag intentionally retires the worker again; check for duplicate active rows during the run, not after final idle

Missing-worker restart check:

1. Start a long-running turn, wait for a real `turn/started`, then record its `control_base_url`.
2. Force-restart the daemon.
3. Kill the env-agent process or otherwise make that `control_base_url` unreachable before relaunching the daemon.
4. Relaunch the daemon on the same `BEANBAG_ROOT`.
5. Wait through the liveness deadline, then verify:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread log <thread-id>
sqlite3 "$beanbag_root/beanbag.db" \
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
  - worktree spawn/follow-up
- Avoid unless explicitly approved:
  - `daemon restart`

### Procedure

1. Create a disposable git repo under `/tmp`.
2. Register it with `bb project create`.
3. Run the same local/worktree thread flows as above.
4. Leave the disposable project on disk until all worktree checks are complete.
5. Inspect failures with:

```bash
node apps/cli/dist/index.js thread show <thread-id>
node apps/cli/dist/index.js thread log <thread-id>
node apps/cli/dist/index.js daemon health
```

When a result looks suspicious, also inspect:

```bash
sqlite3 "$beanbag_root/beanbag.db" \
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

## QA Checklist

Use this as the minimum direct-binary pass with the real provider:

- standalone daemon health
- project create, list, files
- local start
- local follow-up
- local steer after confirmed `turn/started`
- local stop then follow-up
- local blocked restart
- local forced restart with surviving env-agent reconnect or thread `error`
- local follow-up after restart failure
- worktree start
- worktree follow-up
- worktree stop then follow-up
- worktree promote-status, promote, demote
- worktree archive removes the managed worktree and clears env-agent state
- archived thread is visibly marked as archived in thread inspection output
- worktree blocked restart
- worktree forced restart with surviving env-agent reconnect or thread `error`
- worktree follow-up after restart failure

## Cleanup

For standalone runs:

```bash
rm -rf "$tmp_root"
```

For main-daemon runs:

- keep the temp project around until worktree checks are done
- after QA completes, remove the temp repo manually
