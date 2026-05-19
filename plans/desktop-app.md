# Desktop App for bb

## Goal

Ship a native desktop application that wraps bb (server + host-daemon + web UI)
so users get a real window, a tray/menu-bar surface, native notifications,
deep links, and a code-signed installer instead of `npx bb-app@latest` in a
terminal. The desktop app is an additional distribution channel for the same
binary, not a replacement of `bb-app` as an npm package.

## Non-goals

- **Mobile.** No iOS/Android client. Tailnet/remote URL usage already works
  from the existing `BB_APP_URL` config (`packages/bb-app/README.md:86`).
- **Cloud / remote hosting.** The desktop app launches a local server; remote
  hosts join via the existing enrollment flow.
- **Browser sandbox model.** The renderer talks to a trusted local server we
  ship — no iOS-style permission prompts, no per-domain capability gates.
- **Rewrite or split the existing Node stack.** Server and host-daemon stay
  exactly as they are today (`apps/server`, `apps/host-daemon`).
- **App Store distribution (Mac App Store / Microsoft Store) in v1.** Direct
  download + auto-update via DMG / NSIS / AppImage is enough; store
  distribution is a separate, future workstream because of the sandbox rules
  (especially around `node-pty`, host filesystem access, and the daemon).

## Framework Recommendation: Electron

After working through the comparison below, **Electron is the right pick** for
bb. The codebase is unambiguously Node-first — every runtime primitive
(server, daemon, CLI, bb-app launcher) is Node, the team has no Rust
experience represented in the tree, and three production-critical native
modules (`better-sqlite3`, `@parcel/watcher`, `node-pty`) need a Node host with
the same ABI as the server. Electron gives us a Node main process that can
either spawn our existing entrypoints exactly as `packages/bb-app/src/launcher.ts:2029`
does today, or `require()` them in-process. Tauri would force us to ship a
sidecar Node binary anyway, which throws away the bundle-size advantage that
was the only real reason to choose it. The decision below is opinionated, not
hedged.

### Comparison

| Concern | Electron | Tauri 2 | Neutralino | PWA |
| --- | --- | --- | --- | --- |
| Embeds Node natively | Yes — main process is Node | No — Rust core; Node must ship as a sidecar binary | No — runtime is its own | No — no Node at all |
| `better-sqlite3` / `node-pty` / `@parcel/watcher` packaging | First-class. `electron-builder` runs `electron-rebuild` and packages prebuilds per arch. | Possible but bb has to ship a portable Node runtime + node_modules tree as resources; sidecar Node must match prebuild ABI. | Same problem as Tauri, less ecosystem to lean on. | Impossible. The browser can't run them. |
| Server lifecycle | Can spawn server/daemon as today, or run them in-process | Spawn-only via sidecar; no in-process option | Spawn-only via sidecar | N/A |
| Bundle size (macOS DMG, signed, x64+arm64 universal) | ~140–200 MB | ~25–60 MB (excluding the bundled Node sidecar; with sidecar ~80–120 MB) | ~5–15 MB | Zero (but: no offline launcher) |
| Memory at idle | ~250–400 MB (main + renderer + Node server + daemon) | ~80–180 MB (Webkit renderer + Node sidecar + daemon) | ~40 MB (no Node sidecar overhead, but we have to add one) | n/a |
| Signing / notarization (macOS) | `electron-builder` + `@electron/notarize` — mature, documented | `tauri-action` + manual `xcrun notarytool` — works but newer | Bespoke shell scripts | n/a |
| Signing (Windows) | EV cert via `electron-builder` (Authenticode + optional Azure Trusted Signing) | `tauri.conf.json` + signtool | Manual | n/a |
| Linux | AppImage (`electron-builder`), deb, rpm, snap | AppImage (`tauri.conf.json`), deb, rpm | AppImage | n/a |
| Auto-update | `electron-updater` (Squirrel.Mac / NSIS / AppImageUpdate) — stable, signed-delta updates | Tauri Updater (signed manifest + Ed25519) | None first-party | n/a |
| Deep links (`bb://thread/<id>`) | `app.setAsDefaultProtocolClient("bb")` + `open-url` / `second-instance` events | `tauri.conf.json` + `deep_link` plugin | Limited | Possible via URL scheme handlers but no install hook |
| Tray / menu bar | `Tray` API — well-trodden | Tauri Tray API — works, fewer examples | DIY | n/a |
| Native notifications | `Notification` (BrowserWindow) or `node-notifier` | Plugin-based | Limited | DOM `Notification` only when tab is open |
| Dev ergonomics for this team | Node-first; engineers can debug everything with the same tools as the server | Rust toolchain required for any main-process change | Tiny ecosystem | Trivial, but trivial because it doesn't solve the problem |
| Renderer load source | `http://localhost:38886` (our own server) | Same | Same | Browser tab |

### Why not the others, more directly

- **Tauri** would force us to maintain two languages for one app. Every change
  to "what the main process does" — tray menus, deep link handling, IPC,
  auto-update wiring — would touch Rust. We would still need to ship Node
  because `node-pty` and `better-sqlite3` cannot be replaced by Rust crates
  without a large rewrite (`apps/host-daemon/src/terminals/*` is built on
  `node-pty`, and the entire database layer in `packages/db/` is
  drizzle-on-better-sqlite3). So we would carry both the Rust complexity *and*
  the Node binary, and the bundle-size win disappears.
- **Neutralino** has no auto-update story, a small ecosystem, and the same
  Node-sidecar problem. Not credible for a product shipping to engineers.
- **PWA** can't run the server at all. The whole premise of bb is a local
  Node server with a host daemon; a PWA is the wrong layer entirely.

## Architecture

```
+-----------------------------------------------------------------+
|                       Electron main process                     |
|                       (Node 22, our code)                       |
|                                                                 |
|   - app lifecycle (single-instance lock, window mgmt, tray)     |
|   - IPC bridge to renderer (notifications, deep links, theme)   |
|   - spawns BB processes (option A) OR requires them (option B)  |
|                                                                 |
|     +-----------------------+     +--------------------------+  |
|     |  @bb/server (Node)    |     |  @bb/host-daemon (Node)  |  |
|     |  :38886 (or 0)        |     |  :38887 (or 0)           |  |
|     +-----------------------+     +--------------------------+  |
|                                                                 |
+-----------------------------------------------------------------+
                       |
                       v   loads http://127.0.0.1:<server-port>
+-----------------------------------------------------------------+
|                       Electron renderer                         |
|       BrowserWindow loading @bb/app (served by @bb/server)      |
+-----------------------------------------------------------------+
```

**Option A (recommended for Phase 0): spawn server + daemon as child
processes** using the exact same `spawn(process.execPath, [entry])` pattern as
`packages/bb-app/src/launcher.ts:2029-2096`. This means the desktop app's
Phase 0 is essentially "Electron main process replaces the `runBbApp`
function in `launcher.ts`." We get full process isolation, identical crash
semantics to the npm distribution, and `process.execPath` inside Electron
resolves to the bundled Electron helper, which embeds Node.

**Option B (consider later in Phase 5 polish): require them in-process** to
save ~150 MB of resident memory and one process boundary. Forfeits crash
isolation; revisit only if we measure memory pressure on small machines.

**Renderer source:** `http://127.0.0.1:<port>/` served by `@bb/server` after
health-check. We deliberately do *not* load `file://` even though `apps/app/dist`
is on disk: the SPA expects the API on the same origin and shipping CORS for
the desktop case would diverge the codepath. The port is dynamic in the
desktop build (see "Phase 1 — port collisions" below).

**IPC channels (main ↔ renderer):**

| Channel | Direction | Purpose |
| --- | --- | --- |
| `bb:server-ready` | main → renderer | Fired once the server health check passes; renderer uses it to remove its loading splash. |
| `bb:deep-link` | main → renderer | Forwards `bb://...` URLs received via `open-url` / `second-instance`. |
| `bb:notify` | renderer → main | Renderer requests a native notification (so a manager message can ping the dock even if the window is hidden). |
| `bb:set-dock-badge` | renderer → main | Renderer reports unread count. |
| `bb:tray-action` | main → renderer | Tray "Open thread X" requests routing without restarting the SPA. |
| `bb:theme` | main → renderer | System theme change (light/dark/system) forwarded to the SPA. |

All other communication continues to be HTTP / WebSocket against the local
server. We do not introduce a parallel "Electron IPC for app data" surface;
the SPA stays portable to plain-browser usage.

## Repository Layout

A new package `apps/desktop/` (top-level alongside `apps/app`, `apps/server`,
`apps/host-daemon`, `apps/cli`):

```
apps/desktop/
  package.json              # @bb/desktop, "private": true
  electron-builder.yml      # signing/notarization/update config
  src/
    main.ts                 # app lifecycle, spawns server+daemon
    preload.ts              # contextBridge IPC surface
    tray.ts
    deep-links.ts
    window-state.ts
    auto-update.ts
    server-supervisor.ts    # extracted spawn/healthcheck/shutdown logic
    notifications.ts
  assets/
    icons/                  # platform-specific icon sets
  scripts/
    dev.mjs                 # boots @bb/server, @bb/host-daemon, then Electron
  test/
    server-supervisor.test.ts
```

The shared supervisor logic in `apps/desktop/src/server-supervisor.ts` is
extracted from `packages/bb-app/src/launcher.ts` (`spawnManagedProcess`,
`waitForHealth`, `terminateProcessIfRunning`, the daemon-lock check). That
extraction goes into a new shared package `@bb/launcher-core` so both the
npm launcher (`bb-app`) and the desktop app consume the same code. This is a
prerequisite, not a refactor — it lives in Phase 0.

## Phased Roadmap

### Phase 0 — Scaffold

**Scope:**

- Extract supervisor logic from `packages/bb-app/src/launcher.ts` into a new
  shared package `packages/launcher-core/` (functions: `spawnServer`,
  `spawnDaemon`, `waitForHealth`, `terminateProcessIfRunning`,
  `assertArtifacts`). `bb-app` is refactored to consume `@bb/launcher-core`
  in the same change — no behavior change, just relocation.
- Create `apps/desktop/` with Electron 32+ (latest stable), TypeScript,
  `electron-builder` config in skeleton form, no signing.
- `apps/desktop/src/main.ts` boots: acquire `app.requestSingleInstanceLock()`,
  call `@bb/launcher-core`'s `spawnServer` and `spawnDaemon`, wait for health,
  open a `BrowserWindow` pointed at `http://127.0.0.1:<server-port>`.
- Renderer loads the existing SPA unchanged. No IPC, no tray, no notifications,
  no auto-update.
- Add `pnpm desktop:dev` to the root `package.json` that runs the existing
  `@bb/server` / `@bb/host-daemon` `dev` scripts (turbo-watched) and then
  launches Electron pointed at the dev server URL. Mirrors the existing
  `pnpm dev` flow (`package.json:12`).

**Exit criteria:**

- `pnpm desktop:dev` opens a window with bb running inside.
- Closing the window terminates both server and daemon cleanly (verified via
  `ps -o pid,ppid,command` showing no orphans after a graceful Cmd-Q).
- A second `pnpm desktop:dev` invocation focuses the existing window instead
  of spawning a second instance (because of the single-instance lock).
- `@bb/launcher-core` is consumed by `bb-app` and the test suite for
  `bb-app` still passes (`pnpm exec turbo run test --filter=bb-app`).

**Validation steps:**

1. `pnpm install && pnpm exec turbo run build --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/app`
2. `pnpm desktop:dev` — confirm window opens to the SPA.
3. Create a thread, send a message, observe the daemon log in
   `~/.bb-desktop-dev/logs/`.
4. Quit via Cmd-Q. `lsof -i :38886` and `lsof -i :38887` return nothing.
5. Re-run `pnpm desktop:dev` from a second terminal; the original window
   focuses, no second window opens, no port conflict.
6. `pnpm exec turbo run test --filter=bb-app --filter=@bb/launcher-core` is
   green.

### Phase 1 — Packaging

**Scope:**

- `electron-builder.yml` configured to produce:
  - macOS: universal `.dmg` (`x64` + `arm64`)
  - Windows: `.exe` NSIS installer (`x64` + `arm64`)
  - Linux: `.AppImage` (`x64` + `arm64`)
- Native deps packaging: configure `electron-builder` `asarUnpack` for
  `better-sqlite3`, `@parcel/watcher`, `node-pty` (the three native modules
  declared in `scripts/build-utils.mjs:14`). Add `@electron/rebuild` to the
  packaging step so prebuilt binaries match Electron's Node ABI on each target.
- Bundle the built SPA, server dist, daemon dist, and templates inside the
  app's `resources/` directory. The supervisor reads them from
  `process.resourcesPath` in production and from the workspace path in dev.
- The desktop app uses its own data directory by default to avoid colliding
  with `~/.bb/` (used by `npx bb-app`) and `~/.bb-dev/` (used by `pnpm dev`).
  Specifically: `~/Library/Application Support/bb/` on macOS, `%APPDATA%\bb\`
  on Windows, `~/.config/bb/` on Linux (Electron's `app.getPath("userData")`).
  Document the migration story in "Migration / compatibility" below.
- No signing yet — installers are unsigned drafts.

**Exit criteria:**

- `pnpm desktop:build` produces installable artifacts for the host OS in
  `apps/desktop/release/`.
- A colleague on a clean machine (no Node, no pnpm) can install the artifact
  and launch the app.
- Database and lock-file are written under the user-data dir, not `~/.bb`.
- `better-sqlite3` opens the DB; `node-pty` spawns a shell in the first
  thread; `@parcel/watcher` does not crash the daemon on first project add.
- `lsof -p <pid>` on the running app shows the server and daemon as child
  processes of the Electron main, with three Renderer/GPU helpers.

**Validation steps:**

1. `pnpm desktop:build:mac` on a clean mac runner (e.g. via `act` or a fresh
   CI job).
2. Drag-and-drop the `.dmg` content to `/Applications`, launch from Finder.
3. Verify `~/Library/Application Support/bb/bb.db` exists and is non-empty
   after creating a thread.
4. Open a terminal panel in a thread — confirm a real PTY is allocated.
5. Add a project; touch a file in it from another terminal; verify the
   watcher fires (manager surfaces the change).
6. Repeat steps on Linux (`.AppImage` on Ubuntu 22.04) and Windows (`.exe`
   on Windows 11). Both x64 and arm64 where possible.

### Phase 2 — Signing & Notarization

**Scope:**

- macOS: Developer ID Application certificate stored as a base64
  `APPLE_API_KEY_P12` GitHub Actions secret. `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER_ID`, `APPLE_TEAM_ID` for `notarytool`-based notarization
  via `@electron/notarize`. `hardened-runtime` enabled; entitlements declared
  in `apps/desktop/entitlements.mac.plist` with `com.apple.security.cs.allow-jit`
  (V8) and `com.apple.security.cs.allow-unsigned-executable-memory` (Node).
  Also: `com.apple.security.cs.disable-library-validation` (loading
  prebuilt native modules from `app.asar.unpacked`).
- Windows: EV code-signing cert via Azure Trusted Signing or DigiCert; use
  `electron-builder`'s `azureSignOptions` (preferred — no exportable key) or
  fall back to a PFX in CI. Stamped with timestamp authority.
- Linux: AppImage is unsigned but published with a detached `.sig` (sigstore
  Cosign) and the public key documented in the README.
- Document the credentials in `docs/desktop-signing.md`: where to get certs,
  rotation procedure, what to do if the EV cert expires mid-release.

**Exit criteria:**

- macOS: `spctl --assess --verbose /Applications/bb.app` says "accepted /
  Notarized Developer ID".
- macOS: `xcrun stapler validate /Applications/bb.app` succeeds — the
  notarization ticket is stapled.
- Windows: `signtool verify /pa /v bb-Setup-<version>.exe` succeeds.
- Linux: `cosign verify-blob --signature bb-<version>.AppImage.sig
  --key cosign.pub bb-<version>.AppImage` succeeds.
- CI workflow runs all three builds, signs, and uploads to a draft GitHub
  Release without manual intervention.

**Validation steps:**

1. Trigger `Release desktop` workflow on a tag.
2. Download the artifacts on a clean machine *with Gatekeeper / SmartScreen
   on*; install and launch.
3. macOS: no "unidentified developer" prompt.
4. Windows: SmartScreen shows the signed publisher; no "Unknown publisher"
   warning.
5. Linux: `cosign` verification passes against the published key.
6. Confirm CI does not log the signing key (review action logs for any
   accidental `set -x` over secrets).

### Phase 3 — System Integration

**Scope:**

- **Tray / menu-bar icon** with: Open bb, Start, Stop, Restart server,
  Open data dir, Show logs, Check for updates, Quit. Implemented in
  `apps/desktop/src/tray.ts`. Status indicator dot color: green = healthy,
  yellow = starting, red = degraded (server health check fails).
- **App menu** with the platform-conventional layout (File, Edit, View,
  Window, Help on mac; the rest on Linux/Windows). New menu items: New
  Thread, New Manager Window, Open Project Folder…
- **Dock badge** for unread events. Renderer calls `bb:set-dock-badge` with
  the unread count from the existing manager unread divider state
  (`scroll unread divider into view` work in commit e33dbb52 confirms the
  unread concept already exists in the SPA).
- **Deep linking** `bb://thread/<id>`, `bb://project/<id>`,
  `bb://manager/<id>`. macOS registers via `app.setAsDefaultProtocolClient`
  and listens for `open-url`. Windows/Linux use the `second-instance` event
  with the URL in `argv`. Renderer receives via the `bb:deep-link` IPC
  channel and uses the existing `react-router-dom` routes.
- **Native notifications** wired to manager messages and turn completion.
  Renderer subscribes to the existing server WebSocket events; when the
  window is hidden or background, it forwards via `bb:notify` to the main
  process which uses Electron's `Notification`. Clicking the notification
  focuses the window and dispatches a `bb:deep-link` with the relevant
  thread URL.

**Exit criteria:**

- Clicking the tray icon while the main window is minimized restores and
  focuses it.
- Tray "Stop" shuts the server and daemon and shows a degraded state; tray
  "Start" relaunches them.
- `open bb://thread/thr_abc123` in a fresh terminal opens (or focuses) the
  desktop app on that thread.
- Receiving a manager message while the window is hidden produces a native
  notification; clicking it focuses the window on the thread.
- Dock badge updates within 250 ms of a new unread event.

**Validation steps:**

1. Quit fully, then run `open "bb://thread/thr_abc"` — app launches to that
   thread. Repeat with the app already running (focus instead of relaunch).
2. Hide the window, send a manager message from a second device or via
   `pnpm bb`. Verify a notification appears, the dock badge increments,
   clicking the notification opens the right thread.
3. Tray menu: exercise every item and confirm state transitions.
4. macOS dark/light: toggle System Settings → Appearance, confirm the SPA
   follows. (Phase 5 hardens this; Phase 3 verifies the IPC plumbing.)

### Phase 4 — Auto-update

**Scope:**

- `electron-updater` with the GitHub Releases provider (no extra
  infrastructure required). Update channels:
  - `stable` — published from a release-tagged commit on `main`.
  - `beta` — pre-release tagged commits (`vX.Y.Z-beta.N`); requires
    "Allow beta updates" in the app's General settings.
- Updates are downloaded in the background, verified against the macOS code
  signature / Windows Authenticode / AppImage `cosign` signature, and
  installed on next launch (`autoInstallOnAppQuit`).
- Tray "Check for Updates…" forces a check and surfaces "You're up to date"
  or "Restart to install".
- Release notes pulled from the GitHub Release body.

**Exit criteria:**

- A v0.0.1 installed app upgrades itself to v0.0.2 when v0.0.2 is published
  to the GitHub Releases page (verified end-to-end on macOS and Windows).
- AppImage update applies in-place via AppImageUpdate (or falls back to a
  user-prompted download for distros without it).
- A user with `stable` configured does *not* receive a beta update.
- A failed signature verification aborts the update and reports the error
  in the app log; the previous install continues to run.

**Validation steps:**

1. Publish v0.0.1, install, run.
2. Push a v0.0.2 GitHub Release with `electron-builder` artifacts attached.
3. Watch the app log — `update-available`, `update-downloaded`, "Restart"
   button surfaced in the tray and in-app banner.
4. Restart; confirm `app.getVersion()` is 0.0.2.
5. Intentionally corrupt the v0.0.3 artifact signature; confirm
   `update-error` and that the app stays on 0.0.2.

### Phase 5 — Polish

**Scope:**

- **Window state restoration:** persist bounds and maximized/fullscreen
  state across launches (use `electron-window-state` or implement against
  `app.getPath("userData")`).
- **Multiple manager windows:** the SPA already supports multiple manager
  workspaces (per `manager startup prompt` commit 8a842b35); the desktop
  build should be able to open more than one `BrowserWindow` against
  different thread URLs and persist them as a "workspace".
- **Dark/light follow system:** wire `nativeTheme.shouldUseDarkColors` and
  push changes through `bb:theme` to the SPA. Existing
  `manager welcome` and `app: soften dark-mode sidebar hairlines` work
  (commits b1ad81fa, f4516b99) already produce a real dark theme — this
  ties the OS preference to it.
- **Accessibility:** verify VoiceOver / NVDA can navigate the window
  chrome (menus, tray menu, in-app dialogs); ensure focus is correctly
  restored after deep links and notifications; respect
  `prefers-reduced-motion` in the splash transition.
- **Crash reporter:** opt-in Sentry or Electron's built-in crash dump
  upload. Off by default for v1; user toggles in Preferences.
- **Auto-launch on login:** opt-in toggle calling `app.setLoginItemSettings`.

**Exit criteria:**

- Closing and reopening the app restores the window to the same screen,
  position, and size.
- Opening two manager workspaces from the SPA opens two windows, each
  reflected in the dock with its own context.
- Switching macOS appearance switches the SPA theme without reload.
- VoiceOver reads tray menu items; keyboard-only navigation can reach
  every menu and dialog.
- Auto-launch toggle survives a reboot.

**Validation steps:**

1. Resize window, quit, relaunch — same size and position.
2. Open two manager workspaces; confirm two distinct dock icons /
   taskbar entries.
3. macOS: System Settings → Appearance → switch Light/Dark. SPA tracks.
4. Enable auto-launch, reboot, verify bb starts and a window opens.

## Risks & Open Questions

These are the items most likely to take longer than the headline estimate.
Each one has a fallback if it slips.

1. **Native-dep packaging across architectures.** `better-sqlite3` and
   `node-pty` ship prebuilt binaries per Node ABI; Electron uses a different
   ABI than upstream Node. `electron-builder` runs `electron-rebuild`, but
   universal macOS builds (`x64 + arm64`) require `lipo`-merged prebuilds.
   Fallback: ship two separate `.dmg` files (one per arch) until universal
   works.
2. **First-time macOS signing setup.** Notarization with an organization's
   Developer ID requires App Store Connect API keys with the right roles.
   Allow a full sprint to get credentials, automate them in CI, and
   troubleshoot the inevitable "you're not authorized" errors. Fallback:
   manual local notarization of the first release while CI is fixed.
3. **Port collisions with `npx bb-app`.** If a user already runs
   `npx bb-app` and then launches the desktop app, both will try to bind
   38886/38887. The desktop app needs to either (a) default to a *different*
   port range and pass it via `BB_SERVER_PORT` / `BB_HOST_DAEMON_PORT`
   (`packages/bb-app/src/launcher.ts:38-39`), or (b) detect the conflict and
   ask the user. The plan: pick a different default port range
   (e.g. 38888/38889) for the desktop build, document the divergence, and
   keep the port environment-configurable.
4. **Multiple instances.** `app.requestSingleInstanceLock()` handles the
   desktop side. But the desktop app and `npx bb-app` are different
   processes — we still need the existing daemon lock
   (`apps/host-daemon/src/lock.ts:8`) to prevent two daemons from binding the
   same data dir. Mitigation: distinct default data dir per distribution
   channel (desktop: `app.getPath("userData")`, npm: `~/.bb`,
   dev: `~/.bb-dev`).
5. **App Store / store distribution.** `node-pty` and `@parcel/watcher` will
   likely *not* pass Mac App Store review without entitlement waivers, and
   the daemon's host-filesystem access certainly will not. Direct-download
   + auto-update is the only realistic distribution model for v1.
6. **Anti-virus heuristics on Windows.** Even signed Electron apps with a
   spawned Node child sometimes get flagged by SmartScreen reputation until
   they've earned enough installs. Mitigation: submit to Microsoft's
   reputation queue early; EV cert helps. Fallback: include the
   "verify the signature" instructions in the install error path.
7. **Server startup time / splash window.** Health check today gives the
   server up to 15s (`packages/bb-app/src/launcher.ts:44`). The desktop app
   will block the main window load until the server is ready; we should
   show a splash window during that gap so the OS doesn't think the app
   hung. Easy, but worth calling out so it doesn't get cut.
8. **Telemetry / privacy.** Auto-update connects to GitHub; users have a
   reasonable expectation we'll mention this in the README and provide an
   opt-out.

## Migration / Compatibility

| Distribution channel | Default data dir | Server port | How users start it |
| --- | --- | --- | --- |
| `npx bb-app@latest` (production npm) | `~/.bb/` | 38886 (server) / 38887 (daemon) | `npx bb-app` (terminal) |
| `pnpm dev` (source dev) | `~/.bb-dev/` | 38886 / 38887 | `pnpm dev` |
| **Desktop app (new)** | `app.getPath("userData")` — `~/Library/Application Support/bb/` etc. | 38888 / 38889 | Launchpad / Start Menu |

The three channels have to coexist. Concretely:

- **Data dir.** Desktop uses `app.getPath("userData")` by default, *not*
  `~/.bb/`. This lets a developer run `pnpm dev`, `npx bb-app`, and the
  desktop app on the same machine without three processes fighting over
  one SQLite file. The desktop app supports a "Use existing
  `~/.bb` data" Preferences toggle that re-points `BB_DATA_DIR` to
  `~/.bb` — turning that toggle on while another bb instance is running
  shows an error and refuses to switch until the user stops the other
  instance (the daemon lock already enforces this at the file-system level;
  the toggle wraps it in a nicer error).
- **Ports.** Desktop defaults to 38888/38889 so it can run side-by-side with
  `npx bb-app`. Still configurable via env / settings.
- **Config / env.** The desktop app continues to honor `BB_APP_URL`,
  `BB_INFERENCE`, etc., from `~/.bb/config.json` and `~/.bb/env.json`
  (per `packages/bb-app/README.md:86`). When the user is on the default
  desktop data dir, those files live next to the desktop data dir; when
  they've opted into the shared `~/.bb` data dir, those files are shared.
- **CLI access.** The desktop app installs no global `bb` shim. Users who
  want the CLI continue to use `npx bb-app` or `pnpm bb`. (We can ship a
  "Install CLI…" Preferences action later that drops a wrapper into
  `/usr/local/bin/bb` pointing at the bundled Node + CLI entrypoint, but
  that's not v1.)

## CI / Release Pipeline

New workflow: `.github/workflows/desktop-release.yml`, triggered by tagging
`desktop-vX.Y.Z`. Three parallel matrix jobs (macOS-14, windows-latest,
ubuntu-22.04), each running:

1. `pnpm install --frozen-lockfile`
2. `pnpm exec turbo run build --filter=@bb/desktop --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon`
3. `pnpm --filter=@bb/desktop run dist` (electron-builder)
4. Sign / notarize using GH Actions secrets (see Phase 2)
5. Upload artifacts to the draft GitHub Release for the tag

Secrets required (added to the existing `npm-release` GitHub Environment or
a new `desktop-release` environment):

| Secret | Used by |
| --- | --- |
| `APPLE_API_KEY_P12` | macOS signing |
| `APPLE_API_KEY_PASSWORD` | macOS signing |
| `APPLE_API_KEY_ID` | macOS notarization |
| `APPLE_API_ISSUER_ID` | macOS notarization |
| `APPLE_TEAM_ID` | macOS notarization |
| `WINDOWS_CERT_PFX` (or Azure Trusted Signing creds) | Windows signing |
| `WINDOWS_CERT_PASSWORD` | Windows signing |
| `COSIGN_PRIVATE_KEY` | Linux AppImage signing |
| `COSIGN_PASSWORD` | Linux AppImage signing |
| `GH_TOKEN` | Draft Release upload (auto-update feed) |

The existing `publish-bb-app.yml` is untouched. Desktop releases are
independent: a desktop release may bundle an older `bb-app` payload (if no
server/daemon changes shipped since the last desktop release) and vice
versa. Version numbers are independent: desktop ships its own
`apps/desktop/package.json` version.

## Validation Summary

Each phase above has explicit exit criteria and steps. As an overall
gate before declaring "the desktop app is production":

- A user on a clean macOS, Windows, or Linux machine can: download the
  installer from GitHub Releases → install → launch → create a project →
  create a thread → exchange messages with a provider → quit → relaunch
  and find their state intact → receive an auto-update.
- The CI pipeline produces signed, notarized artifacts for all three
  platforms from a single tag, with no manual signing steps.
- A developer running `pnpm dev` and `npx bb-app` simultaneously with the
  desktop app open does *not* see port collisions, database corruption, or
  daemon-lock errors.

## Out-of-scope Follow-ups (not part of this plan)

- Mac App Store / Microsoft Store distribution.
- Mobile clients.
- Headless / server-only desktop mode (no window, only tray).
- Multi-user / multi-account desktop install.
- Plugin / extension UI panels (see `plans/extensions-system.md`).
