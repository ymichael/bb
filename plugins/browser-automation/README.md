# Browser Automation for BB

Thread-owned browser scripts, desktop attachment, and local headless Chrome
on enrolled hosts. Requires the public
`bb.sdk.experimental_desktopBrowsers` API (SDK 0.4.48 or newer).

Browser Automation is optional and disabled by default. Enable it in plugin
settings when you want to use it.

The plugin was scaffolded with `bb plugin new browser-automation`. It has server, host,
CLI, RPC, and a bundled skill. Agents use the CLI through the skill. Screenshot
commands return temporary JPEG file paths and the browser host ID. Screenshot cards, streaming previews, and a screenshot sidebar viewer are not included. Cloud provisioning and arbitrary CDP endpoints are excluded.

## Runtime installation and provenance

The DevBrowser runtime is installed automatically on the **selected browser
host** the first time a session is opened there. Nothing is installed on the
server or on the invoking agent's machine, and the user's global npm
installation is never touched. `runtime-pin.ts` pins one exact npm release:

| Field        | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| package      | `dev-browser@1.0.0-rc.3` from `registry.npmjs.org`                  |
| repository   | [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser) |
| tag / commit | `v1.0.0-rc.3` at `a25e7672e199153b2f5b52a841a62436a28d925f`         |
| linux-x64    | `390dd08f8321807bca2e1e060ec031511adb0af002e871dfde3b1f6c8feac914`  |
| linux-arm64  | `8a1d7c80c3bede69809996848526b5ed43cf6f0965d87f99e4349b775f76042e`  |
| darwin-x64   | `76f70f6e8a48c5caf546003e09d9daa4a0cb756d191c4f7fc3c300c2e2935522`  |
| darwin-arm64 | `d68887f7df149915811bf362b208377c2d0d7d500297d4d5977dab129db5b5eb`  |

The digests are the SHA-256 values published in that release's `SHA256SUMS`.
The pin never follows the `next` or `latest` dist-tags and never falls back to
another version. Windows has no upstream artifact and is refused.

On the browser host the installer (`installer.ts`, run inside the plugin host
worker) performs these steps under
`<plugin host dataDir>/runtime/npm/`, a directory owned by the plugin:

1. Locate `npm` on the host worker's `PATH`; a missing npm is a clear error
   naming the host requirement. npm 9.5 or newer is required for attestation
   checks.
2. `npm install --ignore-scripts` of the exact version from the pinned
   registry (passed explicitly, so a host `.npmrc` mirror cannot substitute
   it) into a private staging directory with a plugin-owned npm cache. The
   package's own postinstall is never run, and the resolved tarball URL must
   come from the pinned registry.
3. `npm audit signatures --json` must exit zero with no invalid or missing
   signatures. The SLSA provenance attestation is then fetched from the
   registry: its subject digest must equal the installed tarball integrity and
   its workflow must name the pinned repository at tag `v<version>`.
4. Download `dev-browser-<platform>` and `SHA256SUMS` from the GitHub release
   for that tag into the package's `bin/dev-browser-bin`, the location the
   package's own shim expects. The stream digest must equal the pinned
   digest, and `SHA256SUMS` must agree, before the file is used.
5. Run `dev-browser-bin --version` and require the pinned version, write
   `verified.json`, and atomically rename the staging directory to
   `runtime/npm/dev-browser@<version>/`.

Warm starts read `verified.json`, re-hash the binary, and use it without npm or
network access; a tampered or missing binary triggers a fresh install. A lock
file, created atomically with the installer's PID, serializes concurrent
installs across worker processes; in-process callers share one job. Locks
whose owner process is gone are reclaimed only after re-checking their
identity, and staging directories are scoped per package version. An interrupted or failed install removes its staging directory
and leaves no partial runtime; the next open retries. When no session is
waiting on an install for 15 seconds, the install is cancelled.

Because a first install can exceed the 30-second host RPC deadline, the server
polls the host's `prepare` RPC, which long-polls the shared install job and
reports progress, before calling `open`.

### No fallback

A platform without a recorded digest fails with an explicit error; the plugin
never falls back to another version, a `PATH` binary, or the older pre-release
integration build. The `smoke` task takes an explicitly provided binary and
labels it `developer-artifact`; that source exists only for fixtures and is
never chosen automatically. The upstream MIT license is preserved in
`DEVBROWSER-LICENSE`.

### Bumping the pin

1. Wait for the upstream tag workflow to publish both the npm version and the
   GitHub release; merging alone publishes nothing.
2. Fetch `https://github.com/SawyerHood/dev-browser/releases/download/v<version>/SHA256SUMS`
   and copy the four digests into `runtimeRelease.artifacts`.
3. Confirm `npm view dev-browser@<version> gitHead` matches the tag commit.
4. Run `pnpm exec turbo run smoke:install --filter=bb-plugin-browser-automation` on a
   Linux and a macOS host.

Headless sessions need Chrome/Chromium on that host. The plugin checks
`<plugin host dataDir>/runtime/chrome`, the standard macOS Chrome path, then
`google-chrome`, `google-chrome-stable`, `chromium`, and `chromium-browser` on
PATH. The `runtime/chrome` entry can be a symlink to an installed executable.
Normal operation never passes `--no-sandbox`. Chrome must be able to launch with
its sandbox on the enrolled host.

## CLI and agent workflow

Choose both the backend and its host explicitly. There is no silent fallback or
profile migration. Find desktop instances through BB's core desktop-browser
CLI/SDK discovery. The selected instance's generation is resolved on opening.

```sh
bb browser-automation open --backend local --headless --machine <host-id> --json
bb browser-automation open --backend desktop --machine <desktop-host-id> --desktop <instance-id> --json
bb browser-automation list --json
bb browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); await p.snapshot()' --json
bb browser-automation run <session-id> --script-file ./check.js --script-host <invoking-host-id> --timeout-ms 30000 --json
bb browser-automation pages <session-id> --json
bb browser-automation screenshot <session-id> --page main --json
bb browser-automation stop <session-id> --json
bb browser-automation close <session-id> --json
```

Outside a thread, supply `--thread <thread-id>`. Calls from an existing thread
cannot override its ownership. `--script-file` requires `--script-host <host-id>` naming the source host
explicitly and is read through `bb.sdk.files`, then transferred as script text to the
browser host. Relative paths use the invoking CLI working directory. Browser
file reads/writes still occur on the browser's host; scripts are not run in the
workspace directory.

Desktop sessions create a tab in a dedicated automation profile. Acquiring control
opens and focuses its browser panel. New pages created through the controller
are also revealed and selected. Pass
`--tab <tab-id>` only for an explicit handoff of an existing tab. This grants the
existing profile's browsing authority, including its authenticated cookies;
release preserves that tab and login. Plugin-created tabs in its dedicated
profile are disposed by `close`. `stop` releases control and preserves desktop
tabs, including plugin-created ones, until close or cleanup.

Local sessions own a Chrome process and a separate profile. Each session owns a
fresh `DEV_BROWSER_HOME` and socket under the worker's temporary directory.
Pages and cookies persist between runs in that session. `stop`, timeout, or
cancellation terminates that local session; open another session to resume.
`close` disposes its processes and session directory. Desktop handoff tabs
remain open. Sessions expire after 30 minutes, with five-minute idle cleanup;
active scripts do not count as idle. Archiving, deleting, or failing a thread
closes its sessions; normal idle turns preserve them. Externally invoked CLI
runs remain subject to the same per-run timeout and absolute session expiry. Run timeouts default to 30 seconds and are
bounded to 1–120 seconds. Runs are serialized per session.

DevBrowser scripts are trusted code, not a security sandbox. Script output is
bounded to 512 KB before parsing and 160,000 text characters after parsing.
Up to four JPEGs fit within a combined 500 KB budget. Image file paths
must resolve inside that session's capture directory; oversized files and
escaping symlinks fail. CLI `run` and `screenshot` JSON returns `hostId` plus
`images: [{path, mimeType, width, height}]`, without inline image bytes. Paths
are in the browser session's temporary directory on the selected host. Agents
read them directly on that machine, or use `bb file read <path> --host <host-id>
--json` to fetch a remote image and decode its base64 content to a local temporary
JPEG. The bundled skill includes a copy-pasteable command. Read or copy captures
before closing the session; cleanup removes them. Endpoints and connection
credentials are removed from structured script text and never included in
session records or CLI session results.

The CLI uses the same validated operation handlers as RPC. The
RPC contract in `contracts.ts` exposes `open`, `list`, `run`, `pages`,
`screenshot`, `stop`, and `close`.
RPC inputs include `threadId`; session operations also include `sessionId`.
`open.selection` is `{backend:"local",hostId}` or
`{backend:"desktop",hostId,instanceId,tabId?}`. A tab ID is an explicit handoff.
Agents discover the commands through the skill and CLI help.

The host supervises Chrome and the DevBrowser daemon as separate children. Each
child owns a process group. Closing the worker pipe also stops those groups, so
a worker crash does not leave browsers running. Stop sends TERM then KILL after
1.5 seconds. The plugin does not discover or kill processes from PID files.
Server metadata persists ownership and cleanup needs; restart reconciles active
sessions and revokes their desktop leases. Unreachable desktop cleanup remains
recorded for reconciliation on a later plugin load. Desktop lease loss is
observed using the public SDK subscription; core revokes the CDP endpoint
immediately, and the plugin stops its worker session when notified.

## Validation

From the BB checkout, use Turbo:

```sh
pnpm exec turbo run test typecheck build --filter=bb-plugin-browser-automation
DEV_BROWSER_SMOKE_BINARY=/absolute/path/to/verified/dev-browser \
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke --filter=bb-plugin-browser-automation
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke:install --filter=bb-plugin-browser-automation
```

`installer.test.ts` drives the installer against a fake `npm` and a local
release server: exact-version install, provenance rejection, digest and
`SHA256SUMS` mismatches, warm reuse without npm or network, tampered-binary
reinstall, concurrent callers, stale locks, and cancellation cleanup.

`smoke:install` performs a real cold install of the pinned release from
npm and GitHub into a disposable data directory, then a warm resolve with no
npm on `PATH`, then drives real headless Chrome through the installed binary,
including a cross-origin iframe snapshot and a JPEG screenshot. It prints the
binary path, its SHA-256, and timings.

`smoke` takes an explicit binary and creates disposable directories and runs
real Chrome, without starting a BB core or using an existing browser profile.
It verifies named pages, navigation, clicking, JPEG bytes, serialization,
independent session cancellation, a synchronous infinite-loop timeout,
reopening, stop, and preservation of an attached browser and its page state.
On an isolated CI host that cannot use Chrome's sandbox, the smoke-only
`DEV_BROWSER_SMOKE_NO_SANDBOX=1` adds a temporary Chrome wrapper for either
smoke. That setting is never read by the plugin runtime.

Build with a current BB CLI: an older installed CLI can successfully bundle the
sources while stamping old SDK metadata. Inspect `dist/*.meta.json` before any
future installation or distribution. Generated bundles and declarations are
ignored. No plugin installation or live core is needed for these checks.
