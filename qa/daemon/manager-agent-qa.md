# Manager Agent QA

This guide covers end-to-end QA for the manager agent flow against a real standalone daemon and the real Codex provider.

Use this pass after changes to:

- manager prompting and hatching
- manager-only tools such as `message_user`
- manager CLI commands
- manager thread ownership and delegation
- manager workspace and memory behavior

## Scope

Required happy-path coverage:

- hire a manager from the CLI
- verify that the manager hatches
- complete a meet-and-greet
- tell the manager to help with coding tasks
- ask it to make a few edits
- verify that it delegates to managed threads
- verify that it notifies the user when the delegated work is complete

Additional manager-specific coverage:

- manager memory (`PREFERENCES.md`)
- manager workspace writes
- manager CLI usability for listing and inspecting managed threads

## Prerequisites

- Build the daemon and CLI:

```bash
pnpm exec turbo run build --filter=@beanbag/daemon --filter=@beanbag/cli
```

- Use a disposable repo, disposable Beanbag root, and disposable `HOME`.
- Use a real standalone daemon, not the app-integrated daemon.
- Keep the daemon log open in another shell while running the pass.
- Copy the current Codex auth/config into the disposable `HOME` before starting the daemon. This avoids shared host state while preserving provider auth.

## Setup

Create a disposable repo:

```bash
tmp_root=$(mktemp -d /tmp/bb-manager-qa-XXXXXX)
project_root="$tmp_root/repo"
beanbag_root="$tmp_root/beanbag-root"
tmp_home="$tmp_root/home"
mkdir -p "$project_root/src" "$beanbag_root" "$tmp_home/.codex"
cp ~/.codex/auth.json "$tmp_home/.codex/auth.json"
[ -f ~/.codex/config.toml ] && cp ~/.codex/config.toml "$tmp_home/.codex/config.toml"
[ -f ~/.codex/config.json ] && cp ~/.codex/config.json "$tmp_home/.codex/config.json"
cat > "$project_root/package.json" <<'EOF'
{
  "name": "bb-manager-qa",
  "private": true,
  "type": "module"
}
EOF
cat > "$project_root/src/math.js" <<'EOF'
export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}
EOF
cat > "$project_root/src/index.js" <<'EOF'
import { add, multiply } from "./math.js";

console.log("sum:", add(2, 3));
console.log("product:", multiply(4, 5));
EOF
git -C "$project_root" init -b main
git -C "$project_root" add .
GIT_AUTHOR_NAME='Beanbag Test' \
GIT_AUTHOR_EMAIL='beanbag-test@example.com' \
GIT_COMMITTER_NAME='Beanbag Test' \
GIT_COMMITTER_EMAIL='beanbag-test@example.com' \
git -C "$project_root" commit -m init
```

Start the standalone daemon:

```bash
HOME="$tmp_home" \
BEANBAG_ROOT="$beanbag_root" \
node apps/daemon/dist/index.js --port 4311
```

In another shell:

```bash
export BB_DAEMON_URL=http://127.0.0.1:4311
```

Create the project:

```bash
node apps/cli/dist/index.js project create --name qa-manager --root "$project_root" --json
```

Record the returned `<project-id>` from the JSON response.

## Happy Path Matrix

### 1. Hire the manager

```bash
node apps/cli/dist/index.js manager hire <project-id> --json
node apps/cli/dist/index.js manager show <project-id>
```

Expected:

- `manager hire` returns a manager thread id
- `manager show` returns a manager thread with `type=manager`

### 2. Verify hatching

Use the returned `<manager-id>`:

```bash
node apps/cli/dist/index.js manager status <manager-id>
node apps/cli/dist/index.js manager log <manager-id>
node apps/cli/dist/index.js thread wait <manager-id> --status idle --timeout 120
node apps/cli/dist/index.js thread output <manager-id>
```

Expected:

- the manager publishes a meet-and-greet via `message_user`
- output asks what the user wants to work on or how they like to collaborate
- the manager reaches `idle`

### 3. Meet-and-greet

```bash
node apps/cli/dist/index.js manager send <manager-id> \
  "I want you to help with coding tasks. Delegate substantive implementation by default."
node apps/cli/dist/index.js thread wait <manager-id> --status idle --timeout 120
node apps/cli/dist/index.js thread output <manager-id>
```

Expected:

- the manager acknowledges the preference
- the reply is user-facing and concise

### 4. Ask for edits

```bash
node apps/cli/dist/index.js manager send <manager-id> \
  "Please make a few edits: add a subtract function to src/math.js, create src/format.js with a small formatter, and update src/index.js to print the formatted result."
```

Expected:

- the manager responds that it is delegating the work

### 5. Verify delegation

Use manager status while the task is active:

```bash
node apps/cli/dist/index.js manager status <manager-id>
node apps/cli/dist/index.js manager threads <manager-id>
node apps/cli/dist/index.js thread list --project <project-id> --parent-thread <manager-id>
```

Expected:

- at least one managed child thread exists
- the child thread is `standard` and has `parentThreadId=<manager-id>`
- the manager remains separate from the worker thread

### 6. Verify completion notification

Wait for the child and manager to settle:

```bash
node apps/cli/dist/index.js manager threads <manager-id>
node apps/cli/dist/index.js thread wait <manager-id> --status idle --timeout 240
node apps/cli/dist/index.js manager log <manager-id>
node apps/cli/dist/index.js thread output <manager-id>
```

Expected:

- the managed thread completes
- the manager receives the completion signal
- the manager publishes a completion update to the user
- the completion update references the delegated work rather than pretending the manager did it directly

## Memory and Workspace

### 7. Manager memory

Check whether the manager chose to create `PREFERENCES.md`:

```bash
sqlite3 "$beanbag_root/beanbag.db" "select id,primary_manager_thread_id from projects;"
node apps/cli/dist/index.js thread show <manager-id>
```

Then inspect the workspace directory:

```bash
find "$beanbag_root/workspace/<manager-id>" -maxdepth 2 -type f | sort
```

Expected:

- `PREFERENCES.md` is created only if the conversation made it useful
- if created, it reflects durable user preferences, not transient task state

### 8. Manager workspace writes

Ask the manager for a written artifact:

```bash
node apps/cli/dist/index.js manager send <manager-id> \
  "Write a short markdown summary of the recent task in your workspace, then tell me where you put it."
node apps/cli/dist/index.js thread wait <manager-id> --status idle --timeout 120
node apps/cli/dist/index.js thread output <manager-id>
find "$beanbag_root/workspace/<manager-id>" -maxdepth 2 -type f | sort
```

Expected:

- the manager writes a markdown file in its workspace
- the manager tells the user about it via `message_user`

## Pass Criteria

This QA pass is green only if all of the following are true:

- the manager can be hired from the CLI
- the manager hatches on first run
- the meet-and-greet works
- the manager accepts coding-task guidance
- substantive repo edits are delegated to managed child threads
- the manager notifies the user on completion
- manager memory/workspace behavior matches the intended product contract

## Failure Notes

Record at least:

- Beanbag root path
- project root path
- manager id
- any managed child thread ids
- relevant `manager log` output
- final `thread output` for manager and worker
- whether the failure was:
  - prompt behavior
  - CLI surface gap
  - daemon/orchestration bug
  - documentation drift
