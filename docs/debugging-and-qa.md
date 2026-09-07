# Debugging And QA

- `pnpm dev` prints the active frontend URL, server API URL, host daemon port, data dir, and logs dir. Do not assume fixed dev ports.
- `pnpm start:worktree` builds production artifacts and serves the optimized app bundle from the checkout-specific dev server URL, while keeping the same dev data directory and deterministic server/host-daemon ports. It has no Vite dev server or hot reload.
- `pnpm start:worktree-remote` is the trusted-network variant of `pnpm start:worktree`; it binds that server to all IPv4 interfaces.
- The packaged app defaults to server/frontend `:38886`, host daemon `:38887`, data dir `~/.bb/`, and logs under `~/.bb/logs/`.
- Entity IDs in URLs (`proj_*`, `thr_*`) are primary keys. Query them directly against the active data dir: `sqlite3 <data>/bb.db "SELECT * FROM threads WHERE id = 'thr_xxx';"`.
- API routes are under `/api/v1/`, for example `GET /api/v1/threads/:id`.
- Use `curl` against the server API to isolate frontend issues from server behavior.
- Use the CLI to inspect state: `pnpm bb thread show <id>`, `pnpm bb project list`, `pnpm bb status`. From source, use `pnpm bb:dev`.

## Local Dev QA Launcher

Use `scripts/bb-dev-app` when validating changes in the desktop dev app or helping QA from this checkout:

- `pnpm dev:status` runs `scripts/bb-dev-app status` to print the active branch, Node runtime, dev URLs, data dir, and logs.
- `scripts/bb-dev-app current` restarts the dev server on the current branch.
- `scripts/bb-dev-app main` fetches `origin/main`, fast-forwards `main`, and launches the dev server from this checkout.
- `scripts/bb-dev-app branch <branch>` switches to a local branch, or creates it from `origin/<branch>`, then launches the dev server.
- `pnpm dev:stop` runs `scripts/bb-dev-app stop` to stop the launcher-managed dev server and desktop.
- `scripts/bb-dev-app logs dev` and `scripts/bb-dev-app logs desktop` follow logs.

By default the launcher starts only the dev server (web frontend, server, host daemon) and prints the URL without opening a browser. Pass `--open` to open the browser after startup. Pass `--desktop` (e.g. `scripts/bb-dev-app current --desktop`) to also launch the Electron desktop shell — only do this when the user is testing a desktop-only change.

The launcher uses the Node executable from the caller's `PATH`. It does not select another installed Node version. The `.nvmrc` file pins the primary development runtime to Node 22.19.0. Node 24 and Node 26 remain compatibility targets. Desktop development requires Node 22.19 or newer in the Node 22 release line.

A bb connect shared-port URL is a different browser origin from localhost. If
QA through that URL needs the browser-local host daemon, restart the dev app
with the share origin configured after exposing its app port:

```bash
BB_APP_URL=https://<handle>--<app-port>.getbb.app scripts/bb-dev-app current
```

The port remains stable for the checkout, so the existing share continues to
work after the restart. The host daemon intentionally rejects remote origins
that are not configured; otherwise any webpage could drive its local editor
API.

Branch switches intentionally keep dirty work in this checkout; git will stop if a local file would be overwritten. Set `BB_DEV_APP_STASH_DIRTY=1` for a one-off launch that stashes first.

For CLI QA against the dev instance, run `eval "$(scripts/bb-dev-app env)"` first. This sets `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, and `BB_PROJECT_ID=proj_personal` so `pnpm bb:dev ...` does not accidentally target the packaged app.

Test agents with:

```bash
eval "$(scripts/bb-dev-app env)"
pnpm bb:dev thread spawn --project proj_personal --provider codex --permission-mode accept-edits --title "Smoke test" --prompt "Reply only with ok." --json
```

## Desktop Browser CDP Prototype

Run the isolated Electron compatibility fixture through Turbo:

```bash
pnpm exec turbo run smoke:browser-cdp --filter=@bb/desktop > /tmp/browser-cdp-smoke.log 2>&1
```

The harness currently requires Linux x64, `xvfb-run`, and network access to
GitHub releases. It downloads checksum-pinned DevBrowser 1.0.0-rc.2 and
agent-browser 0.36.0 into a fresh temporary directory, bundles the fixture,
and drives real `WebContentsView` tabs through the production CDP bridge and
native adapter. It uses a local fixture website and a separate Electron
profile, without starting a BB core or reading an existing BB store.

The command prints its artifact directory, including screenshots, protocol
method traces, and the result summary. Connection credentials are redacted
from the diagnostic output. Desktop startup now registers the native broker;
`bb browser` and `bb.sdk.experimental_desktopBrowsers` expose its public API.
This fixture also exercises service-created hidden automation tabs and leases.
The fixture verifies simultaneous control of a hidden thread and another
thread, in addition to both clients’ main-page workflows. It verifies trusted
snapshot-reference clicks in same-origin and nested iframes, scrolling,
selector clicks in a cross-origin iframe with a native child CDP session,
and pointer input in a hidden thread’s iframe. Site isolation is enabled
for the fixture. Unmodified RC2 omits cross-origin iframe contents from
snapshots; use the local-build mode below for the implemented cross-origin
ref support. Popup control remains untested.

To validate a modified DevBrowser build, run:

```bash
pnpm exec turbo run smoke:browser-cdp --filter=@bb/desktop -- --dev-browser /absolute/path/to/dev-browser > /tmp/browser-cdp-local-smoke.log 2>&1
```

The `--dev-browser` option copies that binary into the artifact directory,
records its SHA256 and local-build provenance, and adds required cross-origin
snapshot-ref tests. These reject old refs after same-URL reloads, origin
changes, frame removal, and parent navigation, even after a fresh snapshot
has allocated new refs. It checks both the stale-ref error and absence of
click side effects. Frame origin changes are driven through the parent
iframe’s `src`: Puppeteer’s `Frame.goto()` can lose its session on a renderer
swap, including in ordinary Chrome. The default command continues to test the unmodified
release. Run the task with `-- --help` for usage.

The native adapter uses one viewport capture before pointer input following
attachment or navigation, so input does not race the renderer’s readiness.
Concurrent pointer commands share that capture and preserve their order.
Attachment enables Chromium focus emulation and temporarily disables background
throttling, restoring the original throttling state on detach. While a CDP
screenshot is pending, bounded native captures request frames without revealing
the view; they stop at completion or a five-second deadline. The original CDP
screenshot parameters are preserved.
The image is discarded locally; pending input is rejected if navigation
or a replacement controller invalidates it. A failed capture can be retried,
and detaching one virtual session cancels its pending input while other
sessions remain usable.

After library cleanup and writing the result, the runner allows five seconds
for Electron to quit. If it remains alive, the runner terminates its fixture
process group and records `forcedExit: true`. A successful smoke command with
that flag proves the listed browser checks, not graceful Electron shutdown.

## Desktop Browser Broker Integration

```bash
pnpm exec turbo run smoke:browser-broker --filter=@bb/desktop -- --dev-browser /absolute/path/to/dev-browser > /tmp/browser-broker-smoke.log 2>&1
```

This isolated fixture uses an in-memory migrated test server, the actual SDK
and CLI, an authenticated host broker, the desktop broker client, and real
Electron tabs. The test harness supplies the server-to-host RPC responder;
it does not start a full enrolled daemon or prove remote-machine transport.
It verifies private connection-file permissions, ownership, browser input,
capture, revocation, and connection generations. The default downloads the
checksum-pinned release; the optional binary path records local provenance.
No existing BB store or browser profile is used.

## Record Provider Bridge Traffic

Export `BB_PROVIDER_BRIDGE_RECORD_DIR` before you start the dev app and every
provider bridge records its runtime and provider wires as NDJSON:

```bash
BB_PROVIDER_BRIDGE_RECORD_DIR=$HOME/.bb/provider-recordings/raw scripts/bb-dev-app current
eval "$(scripts/bb-dev-app env)"
pnpm bb:dev thread spawn --project proj_personal --provider codex --prompt "Run git status." --json
ls ~/.bb/provider-recordings/raw/codex/
```

The layout is `<dir>/<providerId>/<threadId>/<direction>.ndjson`, plus a
`_process` scope for lines that belong to no thread. See
[provider-bridge-protocol.md](provider-bridge-protocol.md), "Record mode",
for the entry format. Raw recordings can contain secrets and absolute paths.
Run `node scripts/provider-recordings/redact.mjs <raw-dir> <out-dir>` before
you share one, and never commit a raw recording.

To compare two checkouts' bridges on the committed recordings, run
`pnpm parity --old <checkout> --new . [--provider <id>] [--cell <name>]`.
Each leg replays every cell through its own bridge, assembler, and timeline
projection; the run prints a PASS/FAIL line per cell with event and row
counts and exits non-zero on any diff outside
`packages/provider-bridge-protocol/recordings/parity-allowlist.json`.

## Performance Fixture Database

Use `pnpm seed:perf` to fill a dev database with a large, realistic fixture:
many projects, ~1,200 threads, and ~400k event rows with production-like
payloads. Use it to reproduce performance problems that only appear at scale.

- Start the dev app once first (`scripts/bb-dev-app current`), then stop it and
  seed. The fixture then attaches to the real local host, so agents still run.
- By default the command seeds this checkout's dev data dir. Pass
  `--data-dir <path>` for another target. The command refuses to touch `~/.bb`.
- Scale flags: `--projects`, `--threads`, `--events`, `--seed`. `--reset`
  deletes the database file first. Without `--reset` the fixture appends.
- Example: `pnpm seed:perf -- --reset --events 400000`.

## Provider Corpus

The provider corpus is a private set of real production threads (307 threads,
330,626 event rows, extracted from a personal `~/.bb/bb.db`). It is the
regression oracle for the provider-plugin migration: every layer must project
the same rows and build timelines at the same speed. The corpus contains real
prompts, code, and paths, so it is **never committed**; `.gitignore` blocks
every `provider-corpus/` directory except the in-repo harness and scripts.

- Location: `~/.bb/provider-corpus/` by default. Tests read it through
  `BB_PROVIDER_CORPUS_DIR` and skip when the variable is unset or the directory
  has no `manifest.json`, so CI and fresh checkouts stay green.
- Layout: `manifest.json` (thread selection and reasons), `profile.json`,
  `threads/<provider>/<threadId>/{meta.json,events.ndjson}`, and the generated
  `snapshots/` directory described below.
- Reader: `@bb/test-helpers` exports `corpusAvailable()`,
  `listCorpusThreads({ provider?, reasons? })`, and `loadCorpusThread(id)`.
  Event rows decode through the same `parseStoredThreadEvent` the server uses.

Gates under `apps/server/test/provider-corpus/`:

- `row-snapshots.test.ts` loads each thread into in-memory SQLite and projects
  every timeline page the way `GET /threads/:id/timeline` does (default and
  nested variants), then compares the rows with
  `snapshots/rows/<provider>/<threadId>.json`.
- `timeline-perf.test.ts` measures the 10 largest threads per provider (latest
  page and full page walk, five builds each, calibrated against a synthetic
  thread built in the same run) and compares with `snapshots/perf-baseline.json`.
  The CI micro-benchmark in the same file needs no corpus.

Run them:

```bash
scripts/provider-corpus/snapshot-rows.sh compare   # default mode, fails on diffs
scripts/provider-corpus/snapshot-rows.sh write     # refresh the baseline
```

The script wraps `pnpm exec turbo run test:provider-corpus --filter=@bb/server`
with `BB_PROVIDER_CORPUS_SNAPSHOT=write|compare`. Turbo strips undeclared
variables, so use that task (not the package `test` task) when you set the
corpus variables. Each run writes `snapshots/rows-last-run.json` and
`snapshots/perf-last-run.md` with totals and the perf table.

Compare mode fails on any row diff that `snapshots/allowlist.json` does not
cover. An entry names a scope, a path, and the PR that made the change:

```json
[
  {
    "threadId": "thr_abc123",
    "path": "/variants/*/pages/*/rows/*/output",
    "pr": "#1234",
    "reason": "…"
  },
  {
    "provider": "codex",
    "path": "/variants/default/pages/**/planSteps",
    "pr": "#1235",
    "reason": "…"
  },
  { "*": true, "path": "/variants/**/maxSeq", "pr": "#1236", "reason": "…" }
]
```

`path` is a JSON pointer over the snapshot, or a glob where `*` matches one
segment and `**` any number. The run prints the entries it used; an entry that
covers nothing fails the run because it is stale.

`snapshots/rows` is the baseline minted on `main` and shared by every
workstream, so never run `write` against it from a feature branch. A PR that
intentionally changes rows carries its own allowlist in the repository
(`apps/server/test/provider-corpus/allowlists/<ws>.json`, same schema, merged
after the shared file) and compares with
`BB_PROVIDER_CORPUS_ALLOWLIST=<that file>`. A snapshot of the branch's own
rows goes to a shadow directory: `BB_PROVIDER_CORPUS_SNAPSHOT_DIR=<dir>`
redirects both `write` and `compare`. Re-mint `snapshots/rows` from `main`
after such a PR merges and delete the allowlist file it carried.

A pointer allowlist cannot describe a change that adds or removes rows: every
later sibling shifts and the diff reports the whole turn. For such a change,
carry a row-class file instead
(`apps/server/test/provider-corpus/allowlists/<ws>-row-classes.json`) and set
`BB_PROVIDER_CORPUS_ROW_CLASSES=<that file>` on the compare run. The gate then
matches rows by identity (`callId`, `itemId`, `interactionId`, turn id, or row
id), buckets every change into the first class whose matcher fits, and fails
on a change no class claims or an entry that claims nothing (judged per
entry, so a dead matcher cannot hide behind a sibling with the same name). A
class names a `reason` and one matcher: `added`, `removed`, `moved` (the row left one
nesting level for another), `resegmented` (a turn shows a different number of
visible segments), `reshaped` (`from`/`to` kinds, optionally the other
`fields` the reshape may touch), or `changed` with the `fields` it may touch;
each narrows by `kind`, `workKind`, `role`, and `nested`. Turn bounds that follow a changed child fall into the built-in
`container-bounds` class. The run prints the count per class and records them
in `rows-last-run.json`. To iterate on the classes without re-projecting the
corpus, mint the branch's rows once into a shadow directory and classify the
two directories offline:

```bash
pnpm exec tsx scripts/provider-corpus/classify-row-diff.ts \
  ~/.bb/provider-corpus/snapshots/rows ~/.bb/provider-corpus/snapshots/rows.<ws> \
  --classes apps/server/test/provider-corpus/allowlists/<ws>-row-classes.json --verbose
```

Perf compare mode passes when each thread's normalized cost is within 10% of
the baseline (or within 5 ms of intrinsic cost for the small latest-page
builds) and the median event size is within 15%. The normalized cost is the
minimum build time over five samples divided by the minimum time of a fixed
CPU workload (JSON codec and sorting over a deterministic document) run once
per sample right before the builds. The workload shares no code with the
timeline, so a uniform timeline regression still moves the ratio, while
machine speed and steady load cancel. Each thread gets up to three attempts so
a burst of load does not fail the run (write mode keeps the median attempt);
raw p50/p95 are printed for information. The
baseline records the gate settings and compare mode refuses a baseline
written with different ones. Run the gate on a machine whose load average is
below its core count: when the machine is oversubscribed the table header
says so and even paired ratios drift by 10–20%.

## Local Cloud

Run the Cloud dashboard and Connect worker against one local D1 database:

```bash
pnpm cloud:dev
```

The command applies migrations and prints the dashboard URL. Create a local
email/password account, claim a handle, create a pairing code, and run the
displayed `bb connect` command against a bb started with `pnpm dev`. The same
worktree-specific local origin serves the dashboard at `bb.localhost` and
routes `<handle>.bb.localhost` through the Connect worker. Email/password auth
is enabled only for this loopback workflow; production remains GitHub-only.
`pnpm dev` automatically sets `BB_DEV_CONNECT_BASE_URL` to that worktree's
local Cloud origin. While the bb is unpaired, Settings → Installed plugins → Connect
therefore opens the local dashboard and a pasted code redeems locally. An
explicit `bb connect --server ...` or `--base-url ...` still wins, so the dev bb
can still pair with getbb.app.
Local machine enrollment follows the same origin: local `http:` server URLs
produce `ws:` machine tunnels and `http:` share URLs, while non-local machine
enrollment remains HTTPS-only.

Ctrl-C stops the local services. Local D1 state is kept under
`.wrangler/cloud-dev`.

## Provider-literal ratchet (G1)

`node scripts/check-provider-literal-ratchet.mjs` counts provider-_id_ literals
(`"codex"`, `"claude-code"`, `"acp-…"`, `providerId === "…"`, `isAcpProviderId`, …)
in core (everything outside `plugins/provider-*` and `examples/`) and compares a
per-file count against `scripts/provider-literal-baseline.json`. The count may
only go down. Adding a provider-id branch to core fails CI. When you remove
literals, regenerate the baseline with `--write` and commit it so the reduction
is recorded. `--list` prints every hit. When the baseline reaches zero, delete
it and the guard. This is guardrail G1 of the provider-plugin migration
(the provider-plugin API design (docs/provider-plugin-api.md, added by the v3 contract PR; overview at https://get-bb.github.io/reports/design/provider-plugin-api.html)).

## Linux AppImage Node runtime

The AppImage launcher probes user namespaces and injects `--no-sandbox` when
they are unavailable. Electron running as Node rejects that Chromium flag.
The owned runtime supplies it after Node's `--` argument separator: AppRun sees
the explicit flag and skips injection, while Node treats it as a script
argument. The bridge subprocess receives only its script path. The AppImage
lifecycle smoke exercises this launch and verifies that its runtime mount
survives closing the GUI.
