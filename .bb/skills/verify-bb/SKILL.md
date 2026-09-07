---
name: verify-bb
description: Verify BB user journeys in an isolated source dev app using dev-browser@next and the matching source CLI. Use after BB feature changes or when asked to verify or smoke-test BB. The feature map covers core UI and agent interfaces, every repository plugin, desktop, mobile, and hosted services; select the affected recipes and platform prerequisites.
---

# Verify BB

Run from the repository root. Start with [the feature map](features/README.md)
and select the affected journeys. Read `docs/debugging-and-qa.md` for the
existing launcher's contract. The launch below targets the source web app and
local host daemon. Desktop, native mobile, and hosted services have additional
setup in their feature files. A pass on one platform does not verify another.

## Coverage and selection

The feature map aims to inventory every feature discoverable in this checkout,
including disabled plugins, compatibility paths, and developer surfaces. Group
files contain individual capability recipes. Read only the relevant files for
a focused verification request; for an exhaustive audit, track every recipe.
Mark each selected recipe `passed`, `failed`, `not run`, or `blocked` with its
specific prerequisite and evidence. Group-level source coverage never upgrades
an unexecuted recipe to a pass.

Run the read-only inventory check before selecting coverage:

```bash
.bb/skills/verify-bb/scripts/inventory.py
```

Python 3 and Git are required. The check compares source declarations and
fingerprints with [INVENTORY.md](INVENTORY.md) and `inventory.json`, and requires
all recipe owners to exist. On drift, inspect the changed source, add/update
recipes and their prerequisites, then run `scripts/inventory.py --write` via
its full path above and review the diff. Never accept a new baseline merely to
silence the check. It watches CLI families, app routes/actions/settings, public
contracts/SDK, plugin sources, platform clients and server/daemon implementation.
The broad fingerprints deliberately flag implementation changes too: some
require only a recorded review, others reveal behavior missing from the map.
Literal extraction cannot resolve every dynamic registration, and source
fingerprints cannot judge recipe completeness; reconcile menus, help, schemas
and actual behavior during maintenance.

The [latest maintenance audit](MAINTENANCE.md) assessed all 348 recipes:
166 passed, 177 partial/blocked and 5 failed. The
[per-recipe ledger](validation-2026-09-05.json) records evidence and remaining
subchecks. [VALIDATION.md](VALIDATION.md) preserves the initial smoke history.
An exhaustive map is the test inventory, not a whole-product pass.

After changing the inventory helper, run its standalone fixture tests:

```bash
.bb/skills/verify-bb/scripts/test_inventory.py
```

These use temporary Git repositories and verify drift, missing ownership,
catalog consistency, and index coverage without starting BB.

## Launch

Use Node 22.19 or newer in the Node 22 line; `.nvmrc` supplies the primary
version. The initial run passed on Node 22.23.2. Node 24.18.0 crashed during
native-module setup on that run. Keep the chosen Node on PATH for launch,
source CLI calls, and cleanup. Do not bypass native-module repair or rebuild
a shared binary manually.

```bash
node --version
npm install -g dev-browser@next
dev-browser --version
dev-browser --help
scripts/bb-dev-app status
```

If Chrome is missing, run `dev-browser install`. The browser CLI accepts
Puppeteer scripts on stdin and keeps named pages between calls.

Choose an unused checkout. The launcher assigns ports and a data directory
from the checkout path. Read its status before starting: `current` restarts
processes on those ports, so do not use it on someone else's instance.
Use a fresh store, never an imported store or the user's production database.

For a new run, create a unique evidence directory and a nonempty fresh dev
directory. The marker also prevents `migrateLegacyDevData` from adopting
legacy data from the parent `.bb-dev` directory. If `mkdir` finds an existing
dev directory, stop this setup and use another unused checkout; do not delete
or adopt the existing data.

```bash
export BB_VERIFY_RUN="$(mktemp -d /tmp/bb-verification-XXXXXX)"
export BB_VERIFY_BROWSER="verify-bb-$(basename "$BB_VERIFY_RUN")"
scripts/bb-dev-app status > "$BB_VERIFY_RUN/before-launch.txt"
command -v lsof >/dev/null || exit 1
for BB_VERIFY_PORT in $(sed -nE 's/^(App|Server|Host daemon): http:\/\/[^:]+:([0-9]+)$/\2/p' "$BB_VERIFY_RUN/before-launch.txt"); do
  if lsof -nP -iTCP:"$BB_VERIFY_PORT" -sTCP:LISTEN; then
    exit 1
  fi
done
export BB_VERIFY_DATA_DIR="$(sed -n 's/^Data dir: //p' "$BB_VERIFY_RUN/before-launch.txt")"
export BB_VERIFY_APP_URL="$(sed -n 's/^App: //p' "$BB_VERIFY_RUN/before-launch.txt")"
test -n "$BB_VERIFY_DATA_DIR" && test -n "$BB_VERIFY_APP_URL" || exit 1
mkdir "$BB_VERIFY_DATA_DIR" || exit 1
printf '%s\n' "$BB_VERIFY_RUN" > "$BB_VERIFY_DATA_DIR/verify-bb-owner"
git rev-parse HEAD > "$BB_VERIFY_RUN/source-commit.txt"
scripts/bb-dev-app current > "$BB_VERIFY_RUN/launch.log" 2>&1
```

All three ports must be unoccupied before `current`, which stops listeners
before it starts the app. A stopped screen session alone is insufficient;
checkout-derived ports can collide. Run under the same OS user that owns
the dev processes so listener inspection is complete.

Run slow startup through the agent's background process facility, inspect the
log, and provide progress while it builds. Startup must finish successfully
before driving. If it fails, inspect the error and clean up that attempt.
The launcher runs install, native-module checks, and Turbo builds itself.

Record the variables above in your run notes so later shell calls retain the
same targets. Never rely on variables surviving separate agent shell calls.
When resuming this run, require its marker to contain the exact run directory
and verify the processes still belong to this checkout.

## Doctor

```bash
scripts/bb-dev-app status
eval "$(scripts/bb-dev-app env)"
unset BB_CLI BB_CLI_REEXEC
curl -fsS "$BB_SERVER_URL/health"
curl -fsS "http://127.0.0.1:$BB_HOST_DAEMON_PORT/health"
curl -fsS "$BB_SERVER_URL/api/v1/hosts"
node apps/cli/dist/index.js project list --json
```

The server health returns `{"ok":true}` (possibly with `launchId`); daemon
health returns `ok`. Require the intended host to be `connected`. Inspect
`lsof -nP -iTCP:<port> -sTCP:LISTEN` for each port reported by status, then
check its PID's command and working directory with `ps` and `lsof -p <pid>`.
A responding port alone does not establish instance ownership. Record the
current source commit and whether the tree is dirty with the launch evidence.

`scripts/bb-dev-app env` deliberately clears the parent thread context,
including `BB_THREAD_STORAGE`. Save the evidence location before evaluating
it. It targets the dev server and daemon. In that isolated shell, unset both
`BB_CLI` and `BB_CLI_REEXEC`, then use `node apps/cli/dist/index.js` for CLI
checks. The launcher builds this entry point through Turbo. If a separate build
is needed, run `pnpm exec turbo run build --filter=@bb/cli` first.

The source entry point otherwise reexecutes an inherited `BB_CLI`, silently
using the installed client against the dev server. During maintenance,
`pnpm --silent bb:dev` also changed literal newlines in arguments into
backslash-plus-n bytes. Direct Node invocation with quoted arguments preserved
the bytes. Check the returned content and revision, not only the exit code.
Keep these environment changes inside the test shell or wrapper; use bare
`bb` outside it for coordination with the parent BB thread.

Commands such as workflows require thread context. After evaluating the dev
environment, set `BB_THREAD_ID`, `BB_PROJECT_ID`, and `BB_ENVIRONMENT_ID` only
from synthetic entities created in that instance. Never restore the parent's
production context. A wrapper that changes directory must invoke the built
CLI by its absolute checkout path; scaffold commands should run in an owned
fixture directory.

Run doctor after any unexpected behavior. Also check the browser URL and the
feature's prerequisite. Provider login is required only for actual agent
turns; inspect it through the UI or source CLI, never by printing credentials.

## Drive

```bash
dev-browser --headless -b "$BB_VERIFY_BROWSER" -e "const p = await browser.getPage('bb'); await p.goto('$BB_VERIFY_APP_URL'); console.log(await p.snapshot({interactive:true}));"
```

For later steps use `dev-browser --headless -b "$BB_VERIFY_BROWSER"` with a
quoted heredoc, get page `bb`, and follow the feature recipe. Read a fresh
snapshot before using its `ref/eN` selector. References are observations,
not durable selectors; never copy their numbers from another run. Prefer
the stable selectors documented in each recipe. Wait for the expected route,
control, or state after an action rather than repeatedly clicking. For a rich
composer, enter multiline text with Shift+Enter; literal newlines passed to
`dev-browser fill()` can behave like submit keys. Wait for the draft persistence
debounce before checking stored content.

Persistent menus can retain closed DOM nodes. Scope menu selectors to the
visible open menu and wait for its exit transition before the next action.
Headless Chromium can report `(hover: hover)` as false even with mouse input.
For queued-message actions, click the row's Reorder button to establish
focus-within, then verify the action accepts pointer input before clicking.

Do not run concurrent scripts against this page. Separate browser profiles
isolate cookies and local preferences, but `thread open` and pane controls can
reach other clients connected to the same server. Serialize these commands
across workers, observe the intended client, and reset each profile to its own
fixture URL afterward. Browser scripts have no
`process.env`; substitute the resolved run paths in screenshot arguments, or
use `p.shot()` and copy its returned file into the evidence directory.

## Evidence

Save before/action/after screenshots, compact text observations, selected API
fields, and command results under `$BB_VERIFY_RUN`. Read the screenshots.
Keep raw evidence local: provider pickers and logs can expose private model
names and host paths. Review and redact before committing or sharing it.

Prove the interaction through actual browser input. API reads and the source
CLI verify side effects; they do not replace clicking the UI. Read persisted
state after reload. Report source-only and blocked checks separately from
live passes. Never treat a returned prompt or a thread title as an assistant
response. Record the exact provider used privately, without hardcoding it
into this skill.

## Cleanup

Restore settings through the UI and leave synthetic threads idle. Capture
logs and evidence before stopping. Verify the ownership marker and inspect
the checkout's listeners again before invoking the launcher stop command.

```bash
test "$(cat "$BB_VERIFY_DATA_DIR/verify-bb-owner")" = "$BB_VERIFY_RUN" || exit 1
dev-browser stop "$BB_VERIFY_BROWSER"
scripts/bb-dev-app stop
scripts/bb-dev-app status > "$BB_VERIFY_RUN/after-stop.txt"
test -s "$BB_VERIFY_RUN/source-commit.txt"
```

Check that the three previously recorded ports have no listeners and the
named browser is absent from `dev-browser browsers`. Check every evidence
file you intend to cite still exists. Remove only this run's marked dev data
and synthetic fixture after confirming processes stopped; preserve the run
directory and its evidence. Failed attempts need the same ownership checks.
Never stop all browser profiles or kill processes by executable name.

Use `maintain-verification-skill` to audit the map after relevant app changes.
The initial observed results and limits are in [VALIDATION.md](VALIDATION.md).
