# bb Mobile (Expo React Native)

Status (2026-08-19): plan v3, **built through M4** (Phases 0–7) on branch
`bb/build-expo-react-native-app-thr_qvau3b2d5b`; M5 (Phase 8) deferred. The
decisions below were confirmed with Sawyer in a grilling session on
2026-08-18; the execution log is `plans/bb-mobile-progress.md`. See "Status
(2026-08-19)" right below for what shipped, what is deferred, and what needs
Sawyer.

## Status (2026-08-19)

Every phase was built by parallel agents on the branch, verified on the
iPhone 17 Pro simulator (iOS 26.3) with Maestro against the harness backend,
with `pnpm exec turbo run typecheck lint test --filter=@bb/mobile` green at
each step; the per-phase details, verification notes and carried-forward
items live in `plans/bb-mobile-progress.md`.

Shipped per milestone:

- **M0 – Toolchain (Phase 0)**: `apps/mobile` (Expo SDK 57 / RN 0.86 /
  React 19.2 workspace copy, dev client, Expo Router, NativeWind v5), Metro
  resolution of workspace packages from source, the `expo-modules-jsi`
  patch for Xcode 26.2, runtime + connect spikes, the harness backend
  (`tests/integration/mobile-e2e/backend.ts`) + first Maestro flow, the
  `mobile` request app surface, the macOS runner probe workflow.
- **M1 – Read (Phases 1–4a)**: Direct server profiles (SecureStore, probe,
  warnings), per-profile SDK / realtime / QueryClient with realtime
  invalidation, generated theme tokens + primitives + fonts/icons, drawer +
  stack shell with connection banner, `@bb/client-core` (pure modules
  extracted from the web app) + fake-provider approvals, sidebar / thread
  list / search / archived with every long-press action, thread creation +
  project screens + pickers, the read-only thread detail (FlashList timeline
  with every row kind, native markdown, diff, ANSI, lightbox, unread divider,
  paging, table of contents, status cards).
- **M2 – Act (Phase 4b)**: the shared native composer (mentions, typeahead,
  attachments, voice, drafts, execution pills), send / queue / steer / stop,
  queued-message list, approvals + questions + plugin forms
  (`@bb/plugin-interaction-contracts` shared with the plugins), context
  banner with PR actions, message / thread / git action sheets, fork /
  handoff / edit.
- **M2.5 – Reach (Phase 5)**: bb connect enrollment (QR / code, account
  servers, re-pair, session hardening), "Add mobile device" in web Settings →
  Remote access + `bb connect machine-code`, push notifications end to end on
  the server (`push_subscriptions`, routes, SDK, CLI, Expo Push sender) and
  in the app (registration, tap routing, badge, per-profile toggle), `bb://`
  - universal links with the `.well-known` files served by the connect gate
    and apex, the TLS connect stub for e2e.
- **M3 – Workspace (Phase 6)**: the workspace panel (Info · Diff · Files ·
  Terminal + synced file tabs, also on compose), the batched Diff tab, file
  search / thread-storage browser / previews (text, markdown, CSV, HTML,
  image), the xterm terminal in a WebView with RN-owned socket + accessory
  bar, full-screen file and terminal routes.
- **M4 – Settings + extras (Phase 7)**: settings screens over
  `/system/config` + `PUT /settings/*`, machines, updates, plugins
  management, extensions / skills, share sheet, haptics, keep-awake (see the
  Phase 7 entry in the progress log for the exact surfaces), plus the release
  prep in this pass: `.github/workflows/mobile-e2e.yml` (label-gated /
  nightly / manual Maestro run on the macOS runner against a Release build
  with the embedded bundle — `e2e/subflows/launch-app.yaml`,
  `e2e/scripts/ci-run-flows.sh`), `apps/mobile/eas.json` build profiles, and
  the docs (`apps/mobile/README.md` CI + Release sections,
  `docs/platform-support.md` mobile section, `docs/repository-overview.md`,
  `docs/multiple-devices.md`).

Deferred (M5 – Phase 8, plus carried-forward items): SPA-in-WebView embed
mode for plugin nav panels / settings sections / directive cards, tablet
two-pane layout, web sign-in onboarding, KaTeX / Mermaid WebView, custom
palette anchors, TestFlight / Play through EAS and `eas update`
(`expo-updates` not installed), the Android build + emulator CI, the crash
reporting / telemetry decision before public release; `onlineManager` /
NetInfo wiring, the native header font on iOS 26, the `getThreadDisplayTitle`
/ `systemVersionQueryKey` relocations, and the other small items each phase
entry in the progress log carries forward.

Needs Sawyer (cannot be done by agents):

1. **Expo / EAS account**: create it, run `eas init` in `apps/mobile` (writes
   `extra.eas.projectId` into `app.json`; push registration stays disabled
   until it exists), then `eas credentials -p ios` (signing + an **APNs
   key** for Expo Push). Steps in `apps/mobile/README.md` → Release.
2. **Push acceptance** on a physical iPhone with a `development-device` /
   `preview` EAS build: token → `POST /notifications/push-subscriptions` →
   `exp.host` → APNs; universal links
   (`https://<handle>.getbb.app/threads/…`) need the same signed build.
3. **Revoke the spike machines** in the getbb.app dashboard → Machines: the
   Phase 0 spike credential (named after this Mac) and the Phase 5 simulator
   enrollment on handle `bee`.
4. **Android**: install the SDK / emulator (commands under "Environment
   status") before the Android milestone; `ASSETLINKS_SHA256_FINGERPRINTS`
   on the connect workers once the Android app is signed.
5. **Review + merge** the branch to `main` (the branching decision: one PR
   at M1+; everything sits on the branch). After the merge: label a PR
   `mobile-e2e` or dispatch `Mobile E2E` to run the iOS flows on the macOS
   runner (the job is also nightly), and dispatch `Mobile Runner Probe` once
   — `gh workflow run` needs the workflow file on the default branch, which
   is why the probe could not be run from the branch on 2026-08-19 (the
   job's Xcode / simulator / Java choices are based on the GitHub macOS 15
   image Blacksmith mirrors: Xcode 16.4 default + 26.0.1–26.3, iOS 26.2
   runtime with iPhone 17 / 17 Pro, JDK 17 / 21, CocoaPods 1.17).
6. Telemetry / crash reporting for the app before a public release (none in
   v1 by decision).

## Decisions (confirmed 2026-08-18)

| Topic        | Decision                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience     | Real product: bb users must be able to use it through bb connect. Dogfood first, no dev-only shortcuts in product paths.                                                                                                            |
| Platforms    | iOS first. Android after M2 (SDK not installed until then). Code stays platform-neutral.                                                                                                                                            |
| Connectivity | Both modes. Direct (Tailscale/LAN/simulator) first for dev and M1 dogfood; bb connect is the must-work path (Phase 5).                                                                                                              |
| Auth         | Phone enrolls as a connect machine + installs the desktop-session cookie via a native cookie manager. No gate change unless the Phase 0 cookie spike fails.                                                                         |
| Pairing UX   | QR/code from web Settings → Remote access (+ `bb connect machine-code`) for dogfood/TestFlight; GitHub sign-in pairing page + deep link before public release.                                                                      |
| Profiles     | Multiple servers per phone, one active; each server enrolls its own credential; one QueryClient/realtime per profile.                                                                                                               |
| Compat       | App targets the current server contract; on mismatch show an "update bb" banner and degrade. New routes are additive.                                                                                                               |
| Direct mode  | Allowed with a warning for non-loopback http; https/Tailscale Serve recommended.                                                                                                                                                    |
| Shared code  | Hybrid: extract already-pure modules into `@bb/client-core` now; mobile copies the query hooks; revisit after M2.                                                                                                                   |
| Push         | After M2. Expo Push API. Triggers: pending interaction, turn finished (attention), thread error/provider failure. Body includes a message preview; per-profile toggle. Automation results later.                                    |
| v1 scope     | Native diff + git actions, voice + camera/photo attachments, queue edit + fork/handoff + add-to-chat, terminal (WebView xterm) in M3. Edit-sent-message and table of contents later.                                                |
| Plugins      | Native forms for `ask-user-question`/`secrets`, plugin mentions, descriptor settings now; SPA-in-WebView for panels/settings sections in M5.                                                                                        |
| Design       | bb tokens and typography + native navigation, sheets, gestures, keyboard.                                                                                                                                                           |
| iPad         | Allowed with the phone layout (portrait+landscape on iPad, portrait on phones); two-pane in M5.                                                                                                                                     |
| Telemetry    | No client crash reporting/analytics in v1 (server PostHog with `app_surface=mobile` only). Revisit before public release.                                                                                                           |
| Identity     | Name "bb", bundle id `app.getbb.mobile`, scheme `bb://`, package `@bb/mobile` in `apps/mobile`. Apple team `9QCU24SXK5`. **Expo/EAS account still to be created** (needed for EAS Build/TestFlight and Expo Push; not for Phase 0). |
| Execution    | Phase 0 in one thread (spike). Then parallel bb child threads per work item; Sawyer reviews PRs. No date pressure.                                                                                                                  |
| Branching    | Everything (app + server-side pieces) stays on the long-lived branch; merge to main at M1. Rebase on main regularly.                                                                                                                |
| CI           | Unit tests on Linux always. iOS Maestro job label-gated + nightly on the macOS runner after a Phase 0 probe.                                                                                                                        |

## Goal

Ship a native iOS and Android app for bb. The app must look and behave like the
current PWA (`apps/app`) on a phone, and it must use native capabilities the
mobile web cannot: push notifications, a real keyboard model, secure credential
storage, camera/photo attachments, haptics, background reconnect, and deep
links.

The app is a **client only**. It talks to a bb server over the existing HTTP +
WebSocket contract. It does not run agents, host daemons, or plugins itself.

## Summary of the recommendation

- New workspace package `apps/mobile` (Expo SDK 57, React Native 0.86,
  Expo Router, dev-client builds, NativeWind + `@rn-primitives`).
- Reuse the headless packages as-is: `@bb/sdk/browser`, `@bb/server-contract`,
  `@bb/domain`, `@bb/thread-view`, `@bb/core-ui`, `@bb/connect-client`.
- Extract the web app's headless data layer (query keys, cache owners, realtime
  cache effects, timeline controller, prompt policy, mention builders) into a
  new `@bb/client-core` package behind a `ClientCoreProvider`. This is its own
  phase with its own budget. Rendering is native.
- Two connection modes: **Direct** (LAN / Tailscale / simulator, no auth, same
  as the PWA today) first, then **bb connect** (`https://<handle>.getbb.app`)
  with a per-device machine credential and the existing desktop-session cookie.
  No gate change is required for the recommended path.
- Plugins: backend half works automatically. Native forms for the two
  pending-interaction plugins (`ask-user-question`, `secrets`). Plugin panels
  and plugin settings sections through the existing web SPA in a WebView
  (embed mode) as a later milestone.
- Terminal: xterm.js inside a WebView, with React Native owning the socket.
- Diff: native unified-diff renderer. Markdown: native mdast renderer.
- Push notifications: new server table + route + Expo Push API sender; needs
  an EAS project and APNs/FCM credentials decided up front.
- Tests: pure logic with vitest, screens with Maestro on the iOS Simulator
  against a real bb server driven by the existing integration harness (fake
  provider adapter, extended for approvals). Android emulator second.
- Honest size: ~16–22 calendar weeks to full phone parity (M4) for one
  developer plus agents. Read-only dogfood (M1) lands at about week 8.

## Phase 0 results (2026-08-18, same day)

Done on the branch, iOS only (Android deferred by decision):

- `apps/mobile` (`@bb/mobile`) exists: Expo SDK 57.0.14 / RN 0.86.2 /
  React 19.2.4 (the workspace copy — verified single copy at runtime),
  dev-client, Expo Router, NativeWind **v5 preview** (Tailwind v4, no second
  Tailwind major), full native set (reanimated 4.5, gesture-handler, webview,
  secure-store, mmkv 4, flash-list 2, keyboard-controller, bottom-sheet 5,
  camera, notifications, cookies, expo-image, expo-audio, image/document
  picker, haptics, clipboard, keep-awake, web-browser, svg, hugeicons RN).
  Identity `bb` / `app.getbb.mobile` / `bb://`, iPad allowed, cleartext +
  local-network entitlements set.
- **Native build passes on Xcode 26.2 / iOS 26.3.1** with one `pnpm patch`
  (`patches/expo-modules-jsi@57.0.4.patch`, `Swift.abs`). Two pnpm
  overrides were needed for NativeWind v5: `lightningcss@1.30.1` scoped to
  `@expo/metro-config` (react-native-css resolves lightningcss from there),
  plus the same pin as a mobile devDependency.
- **Metro resolves workspace packages** from TS source: `metro.config.js`
  applies the `source` export condition only to `@bb/*` / `@get-bb/*` (a
  global `source` condition would pull raw sources of third-party packages
  such as react-native-css) and maps NodeNext `./x.js` → `./x.ts` inside
  workspace sources.
- **Runtime spike passed on the simulator** (`app/index.tsx`): `@bb/domain`,
  `@bb/thread-view`, `@bb/server-contract`, `@bb/connect-client`,
  `@bb/sdk/browser` evaluate under Hermes; `GET /system/config` via the SDK;
  raw `/ws` opens (Origin guard accepts RN's WebSocket); SDK realtime
  connects and receives a real `system: config-changed` after
  `POST /system/config/reload`; `crypto.getRandomValues` (via `expo-crypto`
  in `src/lib/polyfills.ts`), URL setters, TextDecoder fatal,
  structuredClone, `AbortSignal.timeout`, `FormData.set` all OK; global
  fetch is `expo/fetch`; **Blob from ArrayBuffer is unsupported** (as
  predicted → attachment upload bypasses the SDK). Lesson: never spread a
  `Headers` instance into a fetch init on RN (its polyfill exposes internal
  fields; expo/fetch then fails to cast the init).
- **Connect cookie spike passed against `bee.getbb.app`**
  (`app/connect-spike.tsx`): machine code (from the connect plugin RPC) →
  `redeemMachineCredential` → `fetchDesktopSession` → cookie installed with
  `@react-native-cookies/cookies` (both stores) → `fetch /api/v1/system/config`
  200, `/ws` upgrade OK (receives broadcasts), `expo-image` loads via the
  shared cookie jar and via an explicit `Cookie` header, and a `WebView`
  with `sharedCookiesEnabled` renders the fully authenticated bb SPA. **No
  gate change is needed.** (One spike machine credential named after this
  Mac's code was consumed; revoke it in the getbb.app dashboard if you want
  the slot back.)
- Composer range spike: inline styled `@mention` / `/command` ranges inside
  a `TextInput` render correctly on iOS.
- Typecheck: `apps/mobile` uses `customConditions: ["react-native"]` (not
  `source`) because workspace packages expose `types` → source. The SDK's
  `Response`-typed helpers were loosened to a structural `SdkResponseLike`
  (`packages/sdk/src/response.ts`) so Hono client responses stay assignable
  under React Native's global `FormData`/`Response` declarations; web/CLI
  typecheck unchanged.
- E2E skeleton: `tests/integration/mobile-e2e/backend.ts` starts the
  in-process harness (fake adapter with user questions) on a fixed port
  (`CreateHarnessOptions.serverPort/bindHost` added), seeds a project and
  two threads, prints JSON; `pnpm --filter @bb/integration-tests
e2e:mobile-backend` (turbo task builds `@get-bb/plugin-sdk` first).
  `apps/mobile/e2e/flows/smoke.yaml` passes end to end with Maestro
  (`pnpm --filter @bb/mobile e2e:ios`, sets `JAVA_HOME`).
- Request-side `mobile` app surface: `RequestAppSurface` in
  `packages/config/src/app-surface.ts`, server request context + telemetry
  updated, config test added. The server config union stays `desktop|web`.
- CI: `apps/mobile` typecheck/lint/test are picked up by turbo. A
  `workflow_dispatch` probe (`.github/workflows/mobile-runner-probe.yml`)
  prints the macOS runner toolchain and optionally times a Release build;
  run it before adding the label-gated e2e job.

Not done in Phase 0 (carried into Phase 1/4b): fake-adapter `approve:<kind>`
token (approval e2e is blocked until then), e2e reset entry (no profiles
yet), Expo/EAS account, Android SDK.

## Environment status on this Mac (verified 2026-08-18)

Verified working today (blank Expo template, npm, standalone project):

- Xcode 26.2 (17C52), Command Line Tools selected.
- iOS 26.3.1 simulator runtime installed today (`xcodebuild -downloadPlatform
iOS`, 8.4 GB). iPhone 17 / 17 Pro / 17 Pro Max simulators exist. iOS 18.4
  runtime also present.
- Node 22.23.1, pnpm 9.15.0, watchman 2026.01.12, CocoaPods (Homebrew ruby
  gem; needs `LANG=en_US.UTF-8`).
- OpenJDK 17 (`/opt/homebrew/opt/openjdk@17`) and Maestro 2.8.0 installed
  today. Maestro needs `export JAVA_HOME=/opt/homebrew/opt/openjdk@17` in the
  shell (or a symlink under `/Library/Java/JavaVirtualMachines`); put it in the
  `e2e:ios` script env.
- Smoke test passed: `create-expo-app` (SDK 57.0.14, RN 0.86.2, React 19.2.3)
  → `expo run:ios` on iPhone 17 Pro → Metro bundle → a Maestro flow tapped the
  OS dialog and asserted the on-screen text.
- A physical iPhone ("Sawyer's iPhone") is known to Xcode; on-device builds
  need a signing team selected once in Xcode.

Known issue and fix:

- `expo-modules-jsi@57.0.4` fails to compile with Xcode 26.2 (Swift 6.2.3):
  `JavaScriptCodable+Date.swift:53 type of expression is ambiguous`. Upstream
  fix qualifies `abs` as `Swift.abs`
  ([expo/expo#47957](https://github.com/expo/expo/issues/47957),
  [expo/expo#48261](https://github.com/expo/expo/pull/48261)). We apply it with
  `pnpm patch expo-modules-jsi@57.0.4` until a release includes it.

Not yet verified (Phase 0 spike):

- The pnpm-isolated monorepo path (Metro + workspace packages + `pnpm patch`).
- The full native dependency set on Xcode 26.2 / Swift 6.2.3
  (`react-native-reanimated` 4, `react-native-gesture-handler`,
  `react-native-webview`, `expo-secure-store`, `react-native-mmkv`,
  `@shopify/flash-list`, `react-native-keyboard-controller`,
  `@gorhom/bottom-sheet`, `expo-camera`, `expo-notifications`,
  `@react-native-cookies/cookies`, NativeWind).
- RN WebSocket cookie and Origin behavior against the server and the connect
  gate.

Not installed (Android):

- Android SDK / platform-tools / emulator (`brew install --cask
android-commandlinetools`, then `sdkmanager "platform-tools"
"platforms;android-36" "build-tools;36.0.0" "emulator"
"system-images;android-36;google_apis;arm64-v8a"`), plus `ANDROID_HOME`,
  `JAVA_HOME` in the shell profile. ~10 GB. Android Studio optional.

## Findings that shape the design

Each fact comes from the code. Paths are relative to the repo root.

1. The web app is ~290k lines; the timeline row model is projected on the
   **server** by `@bb/thread-view` (`apps/server/src/services/threads/timeline.ts`).
   The client only renders `TimelineRow[]` and applies deltas
   (`packages/server-contract/src/thread-timeline.ts:541-601`). This makes a
   native client tractable.
2. `@bb/sdk/browser` is DOM-free (`packages/sdk/src/browser.ts`,
   `transport-http.ts`, `realtime-client.ts`). The root `@bb/sdk` export must
   never be imported (its `source` entry is Node: `packages/sdk/src/node.ts`).
   Two SDK calls are not RN-safe and get mobile implementations: attachment
   upload (`new Blob([arrayBuffer])`, `packages/sdk/src/areas/projects.ts:363-366`;
   RN cannot build Blobs from ArrayBuffer) and voice transcription (`form.set`).
3. Workspace packages export TS source with NodeNext `.js` specifiers
   (`packages/server-contract/src/index.ts`). Metro needs
   `unstable_enablePackageExports`, the `source` condition, and a
   `.js → .ts` resolver.
4. Realtime is invalidation-only (`{type:"changed", entity, id, changes[]}`),
   with no resume cursor on `/ws` (`apps/server/src/ws/client-protocol.ts`).
   Timeline refetch uses `afterSequence` deltas. Subscribing `thread-detail`
   drives host-daemon file watching (`apps/server/src/ws/watch-interests.ts`).
   The web hooks use `WebSocketManager` (`apps/app/src/lib/ws.ts:165-252`:
   `subscribe/onChanged/onThreadOpen/onPluginSignal/getConnectionState`), not
   the SDK realtime client.
5. Local server has no user auth; only an Origin guard
   (`apps/server/src/browser-request-guard.ts:147-175`). Requests without an
   `Origin` pass. `Origin: null` (WebView pages) is rejected. Origins with a
   non-bb port are rejected unless configured (`:118-131`).
6. bb connect gate (`apps/connect/src/worker.ts`): the machine credential header
   `x-bb-connect-machine` is accepted only on `/api/v1*` and `/internal*`
   (`:393-425`) and marks the request as `machine`, which **refuses host
   management mutations** (`:243-260`, `apps/server/src/routes/hosts.ts:59-66`).
   `/ws` and `/ws/terminals/*` need a session cookie (`:430-463`). The desktop
   app enrolls as a machine and mints a 1-hour "desktop session" cookie
   returned as JSON (`apps/connect/src/servers.ts:365-374`,
   `packages/connect-client/src/desktop-session.ts`), then installs it into its
   own cookie store (`apps/desktop/src/main.ts:1038`).
7. Plugin frontends are remote ESM bundles that share React DOM + Radix through
   `globalThis.__bbPluginRuntime` (`apps/app/src/lib/plugin-frontend.ts:917`).
   Hermes cannot run them. Plugin backends (tools, CLI, RPC, mention providers,
   settings schemas, pending interactions) are server-side and work for any
   client. Four first-party plugins render settings through `settingsSection`
   React DOM slots (connect "Remote access", memory, custom-instructions,
   keep-awake).
8. Two pending-interaction kinds are plugin-rendered: `ask-user-question` and
   `secret-request` (`plugins/ask-user-question/src/contracts.ts`,
   `plugins/secrets/src/contracts.ts`, private plugin internals). Without native
   forms, threads block on the phone.
9. There is no push, no service worker, no device-token table anywhere.
   `GET /system/attention` returns only `{hasAttention}`
   (`packages/server-contract/src/api/system.ts:235-237`).
10. Theme tokens are `color-mix(in oklch)` off `--canvas`/`--ink`
    (`apps/app/src/components/ui/theme.css`, Tailwind v4 CSS-first); the
    palette id is server state (`GET /system/config → appearance.themeId`);
    light/dark is client-local.
11. Composer is TipTap/ProseMirror; only the value contract
    `PromptEditorValue{text, mentions}` and the policy helpers are portable.
    Both composers (`NewThreadPromptBox`, `FollowUpPromptBox`) share it.
12. Terminal protocol is JSON/base64 over `/ws/terminals/:id?sinceSeq=N`; the
    transport class is headless but gates sends on `socket.bufferedAmount`
    (`terminal-websocket-transport.ts:142,322`), which RN's WebSocket never
    sets — a socket adapter is required.
13. Attachments: `POST /projects/:id/attachments` with exactly one multipart
    field `file`; voice: `POST /system/voice-transcription`, no MIME check,
    ≤25 MB.
14. `x-bb-app-surface` only accepts `desktop|web`
    (`packages/config/src/app-surface.ts`), and the same union is also the
    server's own configured surface (`packages/config/src/server.ts:48,108-113`).
15. Environment git actions are `commit`, `pull_request_ready`,
    `pull_request_draft`, `pull_request_merge`
    (`packages/server-contract/src/api/environments.ts:189-216`); the PR
    actions live in the composer context banner
    (`ThreadPromptContextBanner.tsx:525-605`), the commit dialog is
    separate.
16. The fake provider adapter (`packages/agent-runtime/src/test/fake-adapter.ts`)
    supports `delay:<ms>`, `call_tool:<name>`, and `ask_user` (only with
    `supportsNativeUserQuestion: true`), but emits **no approval interactive
    requests**. The integration harness
    (`tests/integration/helpers/harness.ts:64,338-351`) hardcodes port 0 on
    127.0.0.1.
17. Expo SDK 57 installs "winter" polyfills (URL, TextDecoder, structuredClone,
    AbortSignal, FormData) and replaces global `fetch` with `expo/fetch`
    unless `EXPO_PUBLIC_USE_RN_FETCH=1`. `crypto.getRandomValues` (needed by
    `nanoid` in `thread-runtime-cache-owner.ts`, `fixed-panel-tabs-state.ts`)
    is not included.
18. The workspace resolves one `react@19.2.4`; Expo SDK 57 pins `19.2.3`. RN
    0.86 peers `react ^19.2.3`, so `apps/mobile` must use the workspace React
    to avoid a second copy (hooks in `@bb/client-core` would break).

## Decisions required before Phase 0

1. App identity: bundle id / package name (e.g. `app.getbb.mobile`), app name,
   URL scheme (`bb://`), Apple Developer team, EAS org/project. Needed for
   Maestro `appId`, deep links, push.
2. Version alignment: `apps/mobile` uses workspace `react` (19.2.4),
   `@tanstack/react-query`, `jotai`, `zod`; `@bb/client-core` declares them as
   peer dependencies. Accept the `expo-doctor` warning about 19.2.3.
3. Styling: evaluate NativeWind v5 (Tailwind v4, pre-release,
   [docs](https://www.nativewind.dev/v5/core-concepts/tailwindcss)) in the
   Phase 0 spike; fall back to NativeWind v4 with a generated Tailwind v3
   config from the token generator. Either way tokens are generated from
   `theme.css`, not shared as CSS.
4. Test runner for `apps/mobile`: vitest (node env) for pure logic; no RN
   component test runner in v1. Maestro for screens.
5. Where the e2e backend lives: `tests/mobile-e2e` workspace package (it needs
   `@bb/agent-runtime/test`, `@bb/host-daemon`, `@bb/server`,
   `@hono/node-server`), not inside `apps/mobile`.
6. pnpm: no global linker change. If RN autolinking needs hoisting, use scoped
   `public-hoist-pattern[]` for RN/Expo packages only.
7. Push prerequisites: EAS project id, APNs key upload, FCM V1 credentials,
   physical iPhone for acceptance (the simulator cannot register for push).

## Architecture decisions

### A1. Stack

| Concern      | Choice                                                                                                               | Why                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework    | Expo SDK 57 / RN 0.86 / React 19.2 (workspace copy), dev-client                                                      | Custom native modules; not Expo Go.                                                                                                                       |
| Navigation   | Expo Router                                                                                                          | File routes map 1:1 to web paths for deep links (`/threads/[id]`, `/projects/[id]/threads/[id]`, `/settings/[section]`); reuse `route-paths.ts` builders. |
| Styling      | NativeWind (v5 if the spike passes, else v4) + `react-native-reusables` (`@rn-primitives`) + cva                     | Class vocabulary and variant model close to `@bb/shared-ui`. Tamagui rejected (different token model).                                                    |
| Theme        | Generated `theme.native.ts` from `theme.css` + palette files (`culori`)                                              | RN has no `color-mix`/`oklch`. A test compares generator output to `theme.css` invariants. Coarse-pointer sizes are the base.                             |
| Data         | TanStack Query 5, jotai (MMKV storage adapter), `@bb/sdk/browser`, `@bb/client-core`                                 | Same cache/invalidation semantics as web. One `QueryClient` per server profile (query keys are not server-scoped).                                        |
| Lists        | `@shopify/flash-list` v2                                                                                             | Timeline and thread lists need virtualization; web has none.                                                                                              |
| Sheets/menus | `@gorhom/bottom-sheet` (+ reanimated 4, gesture-handler), `@rn-primitives/dropdown-menu`                             | Mirrors the compact-viewport bottom drawer behavior.                                                                                                      |
| Keyboard     | `react-native-keyboard-controller`                                                                                   | Replaces the `visualViewport` guessing in `FollowUpPromptBox.tsx`.                                                                                        |
| Icons/fonts  | `@hugeicons/react-native` (verify it accepts the `core-free-icons` `IconSvgElement` data), Inter + Fira Code bundled | Visual parity.                                                                                                                                            |
| Storage      | `expo-secure-store` one key per profile (2 KB per value limit), `react-native-mmkv` (prefs, drafts, panel state)     | Desktop refuses to enroll without persistent secure storage; same rule here.                                                                              |
| Cookies      | `@react-native-cookies/cookies`                                                                                      | Installs the connect session cookie for fetch/WebSocket/WebView.                                                                                          |
| WebView      | `react-native-webview` (`sharedCookiesEnabled`)                                                                      | Terminal (xterm), HTML/file previews, plugin SPA embed.                                                                                                   |
| Polyfills    | Expo winter set + `expo-crypto` / `react-native-get-random-values` for `nanoid`                                      | Finding 17. Decide `expo/fetch` vs RN fetch in the spike (cookie + multipart `{uri}` parts).                                                              |
| Tests        | vitest (pure logic), Maestro (screens)                                                                               | See Testing.                                                                                                                                              |

### A2. Connectivity and auth

Server profiles live in SecureStore, one key per profile:
`{id, mode: direct|connect, serverUrl, label, handle?, credential?}`.

1. **Direct** (first): user enters `http(s)://host:port` (LAN with
   `--server-bind-host 0.0.0.0`, Tailscale Serve HTTPS URL, or
   `http://127.0.0.1:<port>` in the simulator, `http://10.0.2.2:<port>` in the
   Android emulator). No auth, same trust model as the PWA today. Constraints:
   iOS needs `NSLocalNetworkUsageDescription`; ATS allows raw LAN IPs /
   `.local` but blocks plain `http://` to FQDNs (Tailscale hosts must use
   Serve HTTPS); Android release builds need `usesCleartextTraffic` for
   `http://`. The app must not adopt `serverUrl` from `/system/config` when it
   is `127.0.0.1` (emulator case). Direct URLs on non-bb ports need the
   Origin guard to accept the RN WebSocket Origin (verify in the spike;
   `BB_APP_URL` config is the escape hatch).
2. **bb connect** (after M1): the phone enrolls as a connect **machine**
   exactly like the desktop app:
   - Web app Settings → Remote access gets an "Add mobile device" action, and
     the CLI gets `bb connect machine-code [--json]` (SDK + CLI parity rule).
     Both call the existing connect RPC `createMachineCode` →
     `{code, expiresAt, serverUrl}` (`plugins/connect/src/rpc.ts:101-107`);
     the QR/payload adds the derived apex (`deriveConnectBaseUrl`) and
     `expiresAt`. Surface the 409 `machine_limit` (20 machines per account).
   - Phone scans/enters the code → `redeemMachineCredential`
     (`@bb/connect-client`) → stores `{serverUrl, handle, credential(bbcm_)}`.
     The device shows in the getbb.app dashboard machine list and can be
     revoked there.
   - Session: `fetchDesktopSession(serverUrl, credential)` returns
     `{cookie:{name,value,domain:".getbb.app",expiresAt}}`. The app installs it
     with `@react-native-cookies/cookies` (NSHTTPCookieStorage + WKHTTPCookieStore
     on iOS, CookieManager on Android). RN fetch, RN WebSocket, `expo-image`,
     and `react-native-webview` (`sharedCookiesEnabled`) then send it. Renew 5
     minutes before expiry and on `AppState` active, like
     `apps/desktop/src/connect-session-renewal.ts`.
   - The machine credential is used **only** to mint the session. Every
     `/api/v1`, `/ws`, image, and WebView request carries the session cookie,
     never `x-bb-connect-machine` (which would 403 host management).
   - **No gate change** on this path. Fallback (only if the Phase 0 spike shows
     RN cookies are unreliable): gate accepts the session value from an
     `x-bb-connect-session` header on `/ws*` upgrades, and
     `requestForTunnelDo` strips `Authorization`. WebView surfaces still need
     the cookie, so the cookie path is the primary design either way.
   - 401 HTML from the gate → re-auth screen (the app maps HTML 401/403 to
     "Authentication failed", `apps/app/src/lib/api.ts:75-77`).
   - Later (v1.x): web sign-in onboarding (GitHub OAuth in `expo-web-browser`
     → dashboard page lists servers → deep link back with a machine code) so
     onboarding needs no desktop.

App surface: add a request-side `RequestAppSurface = AppSurface | "mobile"`
used by `parseAppSurface`/telemetry, leaving the server config union at
`desktop|web` (Finding 14).

### A3. Shared headless code: `@bb/client-core` (own phase)

Mechanism:

- `ClientCoreProvider` React context supplies `{ sdk, realtime, storage,
navigate? }`; `createClientCore(deps)` factory for non-hook helpers.
- One realtime interface, `WebSocketManager`-shaped (`subscribe/unsubscribe/
onChanged/onThreadOpen/onPluginSignal/onPaneAction/getConnectionState`).
  Web implements it with partysocket (`apps/app/src/lib/ws.ts`), mobile with
  RN WebSocket + cookies + `AppState`. The SDK realtime client is **not** used
  by client-core (it drops non-`changed` messages).
- Rule: no DOM, no `window`, no react-router, no `localStorage`, no
  `@/lib/bb-desktop`. A vitest `node` environment guards it.

Known couplings to split (from the review): `realtime-cache-registry.ts:96`
(`schedulePluginFrontendReconcile` → injected hook), `cache-owners/
resource-route-owner.ts:3` (react-router `useNavigate` → injected `navigate`),
`hooks/queries/system-queries.ts` (`@/lib/bb-desktop` → injected desktop
bridge or split), `lib/route-paths.ts:2` (`matchPath` → tiny matcher),
`lib/fixed-panel-tabs-state.ts` (`@bb/desktop-contract`, `nanoid`),
`connection-aware-query-state.ts` (`useServerConnectionState` → realtime
interface), 39 files importing `@/lib/sdk|api|api-server|ws`, and 28 web test
files that `vi.mock` those module paths and must move to the injected client.

Order of extraction: (1) already-pure modules first (`query-keys`,
`thread-read-state`, sidebar grouping/sorting, `prompt-draft`, submission
policy, mention builders, `timeline-auto-expand`, `thread-runtime-status`,
`fixed-panel-tabs-state` schemas, `secondaryPanelTabState`,
`terminal-websocket-transport` with a `bufferedAmount`-tolerant socket
adapter, `file-preview` logic); (2) `realtime-cache-effects` + `cache-owners`

- queries/mutations behind the provider; (3) `useThreadTimelineController`.
  Web wires the current singletons into the provider at `main.tsx`.
  `turbo run test --filter=@bb/app` must stay green per PR; the 28 mocking tests
  are migrated as part of the phase.

Alternative rejected: copy the hooks into `apps/mobile`. Query keys and cache
invalidation would rot apart from the web app.

### A4. Rendering strategy per surface

| Surface                                                    | Decision                                                                                                                                                                                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeline                                                   | Native `FlashList`, one renderer per `TimelineRow` kind                                                                                                                                                                                                                                                                                                | Sticky-bottom + "jump to latest", older-page loading, unread divider, table-of-contents sheet, delegation `childRows`, lazy `turn` children, image lightbox.                                                                                                   |
| Markdown                                                   | Native renderer over mdast (`unified` + `remark-parse/gfm/breaks/directive`, reuse `markdown-prompt-mentions`/`markdown-thread-mentions` transforms)                                                                                                                                                                                                   | Code via `sugar-high` `tokenize` → styled `Text`. KaTeX/Mermaid: v1 shows source; later lazy WebView. Directives render as cards. Local file links (`path:line`) route to the file preview screen (Phase 6) and are inert before that; long-press copies path. |
| Diff (timeline + Diff tab)                                 | Native unified renderer (`parse-git-diff`) + the patch normalization rules from `TimelineFileDiffBlock.tsx:54-236` (created/deleted files, metadata stripping, plain-text fallback)                                                                                                                                                                    | Split view, gutter selection, syntax highlight deferred. Optional WebView Pierre later.                                                                                                                                                                        |
| File preview                                               | Text, markdown, images (`expo-image`, cookies), CSV native; HTML via WebView to the raw route (cookie auth)                                                                                                                                                                                                                                            | Server CSP sandbox already applies.                                                                                                                                                                                                                            |
| Terminal                                                   | WebView with bundled xterm.js + fit + unicode11; RN owns the WS via the transport + a socket adapter and bridges chunks with batched `postMessage`                                                                                                                                                                                                     | Preserve replay/resize/DA1-suppression semantics from `ThreadTerminalView.tsx`. Accessory bar: Esc, Tab, Ctrl, arrows, paste. Measure `postMessage` throughput on a `cat` of a large file before calling it shippable.                                         |
| Composer                                                   | One shared native composer for root compose and follow-up: `TextInput` with a text+ranges mention model; typeahead sheet; attachments (photos, camera, files); voice (`expo-audio` → transcription route); "+" actions (skills/plan/goal/automation/plugin prompts); execution controls (model, reasoning, permission mode, service tier "Fast", mode) | Serialization must produce the same `PromptInput` as web (`PromptEditorValue{text,mentions}`). Spike inline styled ranges in `TextInput` (Android cursor issues); fallback = plain text + chip strip. Rich text not in v1.                                     |
| Queued messages                                            | Native list under the composer: view, send now, edit, delete, group boundary, move up/down                                                                                                                                                                                                                                                             | Drag reorder deferred.                                                                                                                                                                                                                                         |
| Message actions                                            | Long-press sheet: copy, add to chat (quote), fork, edit (experiment), send to main thread                                                                                                                                                                                                                                                              | Text-selection quoting: per-paragraph long-press quote (RN `Text` has no selection API).                                                                                                                                                                       |
| Sidebar                                                    | Native drawer (gesture): New thread, search, plugin nav rows (as "open on desktop / open in web view" until Phase 8), sections/projects/threads, pinned, organize (project/machine/manual) + sort options, footer                                                                                                                                      | Long-press = context menu. Drag reorder deferred.                                                                                                                                                                                                              |
| Dialogs/pickers                                            | Bottom sheets                                                                                                                                                                                                                                                                                                                                          | Same as compact web.                                                                                                                                                                                                                                           |
| Root compose panel (files/terminal before a thread exists) | Deferred to Phase 6 with the thread panel                                                                                                                                                                                                                                                                                                              | Same components.                                                                                                                                                                                                                                               |
| In-app browser tab                                         | `react-native-webview` tab                                                                                                                                                                                                                                                                                                                             | Cannot reach host `localhost` unless shared via bb connect expose.                                                                                                                                                                                             |
| Open in editor / local daemon                              | Hidden                                                                                                                                                                                                                                                                                                                                                 | Phones have no daemon (`docs/multiple-devices.md`).                                                                                                                                                                                                            |
| Splits, resize, drag reorder                               | Deferred                                                                                                                                                                                                                                                                                                                                               | Provide move up/down for queue and manual order later.                                                                                                                                                                                                         |
| Tablet                                                     | Two-pane layout (list + detail)                                                                                                                                                                                                                                                                                                                        | Phase 8.                                                                                                                                                                                                                                                       |

### A5. Plugins

What works automatically: agent tools + status labels, skills, CLI commands,
background services, mention providers (`GET /plugins/mentions/search`),
declarative settings (`GET/PUT /plugins/:id/settings`), plugin management
routes, provider registration, and pending-interaction plumbing.

What we build natively:

- v1: forms for `ask-user-question` and `secret-request` payloads. Move those
  payload/resolution schemas into a shared package
  (`@bb/plugin-interaction-contracts` or `@bb/domain`) consumed by both the
  plugins and the app (they are private plugin internals today). Plugin
  mention typeahead, plugin settings forms from the descriptor schema, plugin
  list/enable/disable, provider icons from the server SVG. Message directives
  (`::task{}`, `::docs{}`, `::workflow-preview{}`, `::inline-vis{}`) render as
  compact cards with "copy link" and "open in web view" (Phase 8).
- Phase 8 (optional): load the **existing web SPA routes** in a WebView with an
  embed flag that hides sidebar/header (`?embed=1`), plus a `postMessage`
  bridge for navigate/openThread. This reuses the whole plugin runtime at
  phone width and covers `navPanel` (Automations, Tasks, Docs, GitHub),
  `threadPanelAction`, and `settingsSection` slots (connect Remote access,
  memory, custom-instructions, keep-awake). Cookie auth makes it work through
  connect. A bespoke "plugin host shell" is only worth building if bundle size
  or boot time is measured to be a problem.

Not covered: composer customization, message-action `run` callbacks, content
scripts, thread-list replacement, side-chat panels (side chats are hidden forks
and are unavailable in v1).

Rejected: a declarative JSON UI plugin API (large new `experimental_` surface,
value only after plugin adoption); native re-implementation of Tasks (~21k
lines), Automations, Docs, GitHub over their RPC contracts.

### A6. Push notifications (net-new, server-owned)

- Server: table `push_subscriptions {id, expoPushToken, platform, deviceLabel,
createdAt, lastSeenAt}` (Drizzle migration + regenerated snapshot), routes
  `POST/DELETE /api/v1/notifications/push-subscriptions`, SDK area,
  `bb notifications push-subscriptions list|add|remove` CLI, docs surfaces per
  `docs/cli-guide-and-skill.md` (guide templates regen, `bb-cli/SKILL.md`,
  `docs/configuration.md`).
- Sender: triggers are (1) a new pending interaction (`interactions-changed`),
  (2) turn finished / `latestAttentionAt` change, (3) thread error or provider
  failure. POST to the Expo Push API (`https://exp.host/--/api/v2/push/send`).
  Body: thread title + a short message preview (question text, first line of
  the reply, or the error). No APNs/FCM keys in bb; the EAS project holds
  them. Coalesce per thread; skip when the thread was read on any client
  (`read-state-changed`). Per-profile toggle in the app. Unit test with a
  fake `exp.host`. Automation/background-task results later.
- App: `expo-notifications`, token registration per profile after connect,
  tap → deep link to the thread, badge count derived client-side from the
  thread list (`latestAttentionAt > lastReadAt`) since `/system/attention`
  is boolean.
- Acceptance needs a signed build on a physical iPhone.

### A7. Realtime and lifecycle on mobile

- One realtime manager and one `QueryClient` per server profile; subscribe only
  to the visible thread + `thread-list` + `system`; unsubscribe on background
  (daemon watch sets).
- `AppState` drives TanStack `focusManager`; on foreground: reconnect, refetch
  attention + active thread with `afterSequence`.
- Optional server improvement (later): a `since` cursor on `/ws` to avoid the
  full invalidation on every reconnect.

## Milestones and phase mapping

| Milestone                                          | Content                                                                                                                                                                                                 | Phases      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| M0 – Toolchain                                     | Monorepo dev-client builds, e2e skeleton                                                                                                                                                                | 0           |
| M1 – Read (Direct mode dogfood over Tailscale/LAN) | Profiles, shell, theme, sidebar, thread list, search, read-only timeline with all row kinds, markdown, inline diffs, realtime                                                                           | 1, 2, 3, 4a |
| M2 – Act                                           | Composer, send/queue/steer/stop, queued list, approvals + questions (incl. plugin forms), new thread with pickers, thread/project/section actions, fork, child threads, context banner incl. PR actions | 4b          |
| M2.5 – Reach                                       | bb connect enrollment + session, push notifications, deep links                                                                                                                                         | 5           |
| M3 – Workspace                                     | Info, Diff, Files/preview, storage browser, terminal, commit dialog, thread tabs sync, root compose panel                                                                                               | 6           |
| M4 – Settings + extras                             | Settings screens, machines, updates, plugins mgmt, extensions/skills, share sheet, haptics, keep-awake                                                                                                  | 7           |
| M5 – Optional                                      | SPA-in-WebView for plugin panels/settings sections, tablet layout, web sign-in onboarding, custom palette anchors, KaTeX/Mermaid WebView, TestFlight/Play                                               | 8           |

Not planned: splits, drag reorder, keyboard shortcut editor, local editor
integration, desktop browser automation, content scripts, provider CLI login
(needs a terminal on the host), side-chat panels.

## Phases and steps

Each phase ends with a demo on the iPhone 17 Pro simulator, a Maestro flow,
and green `pnpm exec turbo run typecheck lint test`. Estimates are calendar
time for one developer plus agents; stop-and-reassess checkpoints are marked.

### Phase 0 – Toolchain, monorepo spike, e2e skeleton (3–5 days)

1. Create `apps/mobile` with `create-expo-app` (blank TS) + `expo-dev-client`,
   name `@bb/mobile`, scripts `dev`, `ios`, `android`, `typecheck`, `lint`,
   `test`, `build` (`expo export` or no-op); add `@bb/mobile#dev` to
   `turbo.json` (`cache:false, persistent:true`). Pin `react` to the workspace
   version; add a check that `react`, `@tanstack/react-query`, `jotai` resolve
   to one realpath from `apps/mobile` and `packages/client-core`.
2. `pnpm patch expo-modules-jsi@57.0.4` with the `Swift.abs` fix; commit
   `patches/` and `pnpm.patchedDependencies`.
3. `metro.config.js`: `unstable_enablePackageExports = true`,
   `unstable_conditionNames` with `source` first, `react-native`, `import`,
   `default` (do not add `browser`; record which node_modules resolve to raw
   sources), `resolveRequest` mapping `./x.js` → `./x.ts|tsx` inside
   `packages/*` and `apps/*`, monorepo `watchFolders`. ESLint
   `no-restricted-imports` for `@bb/sdk` root and `@bb/shared-ui`.
4. Native dependency spike: install the full native set (A1 table incl.
   reanimated 4 + gesture-handler + cookies + NativeWind v5/v4) inside the
   pnpm workspace and build the dev-client on iOS 26.3. Record per-module
   results and any further `pnpm patch` entries. **Checkpoint: if this fails
   badly, re-plan before estimating further.**
5. Runtime spike in `App.tsx`: import `@bb/domain`, `@bb/server-contract`,
   `@bb/thread-view`, `@bb/sdk/browser`, `@bb/connect-client`; call
   `GET /api/v1/system/config` and open `/ws` against the dev server on
   `127.0.0.1` (and `10.0.2.2` on Android). Verify RN WebSocket Origin passes
   the guard, `expo/fetch` vs RN fetch cookie + multipart `{uri}` behavior,
   `crypto.getRandomValues` polyfill for `nanoid`, and one styled-range
   `TextInput` prototype (composer fallback decision).
6. Connect spike (no product UI): with a test machine credential, mint a
   desktop session, install the cookie via `@react-native-cookies/cookies`,
   and confirm fetch, WebSocket, `expo-image`, and a WebView all authenticate
   through `https://<handle>.getbb.app`. This decides whether the header
   fallback is needed.
7. `tsconfig.json` extends `@bb/tsconfig/base.json` + `typecheck-overrides.json`
   with `moduleResolution: bundler`, `jsx: react-jsx`; ESLint script + devDeps
   (only `apps/app` has them today; CI lint would silently skip otherwise).
8. E2E backend package `tests/mobile-e2e`: extend `CreateHarnessOptions` in
   `tests/integration/helpers/harness.ts` with `serverPort?` and `bindHost?`;
   `backend.ts` uses `adapterFactory: () => createFakeAdapter({
supportsNativeUserQuestion: true })`, seeds with `createProjectFixture` /
   `createReadyThread`, prints `BB_SERVER_URL`. Agent-runtime work item: add an
   `approve:<kind>` control token to `fake-provider-script.ts`/`fake-adapter.ts`
   that emits an approval interactive request (mirroring
   `runtime-test-harness.ts:132-170`), with a unit test. Also a
   `pnpm dev:backend` script (server + daemon, no Vite).
9. Maestro: `flows/smoke.yaml` opens the dev-client via `openLink`
   (`exp+<scheme>://expo-development-client/?url=…`) or runs against a Release
   build; an e2e-only reset entry (`EXPO_PUBLIC_BB_E2E=1` deep link) clears
   SecureStore/MMKV; `pnpm --filter @bb/mobile e2e:ios` sets `JAVA_HOME`.
10. CI: `apps/mobile` typecheck/lint/test in the Linux `checks` job. Run a
    `workflow_dispatch` probe on `blacksmith-6vcpu-macos-15` printing
    `xcodebuild -version`, `xcrun simctl list runtimes`, `java -version`, and
    timing a Release build; then add a label-gated iOS e2e job with
    DerivedData/Pods caching. Android emulator job later if KVM is available.
11. (Deferred to after M2 by decision.) Install Android command-line tools +
    emulator on this Mac; document `ANDROID_HOME`, `JAVA_HOME`.
12. Add `mobile` request app surface (Finding 14) — small, isolated.

Exit: dev-client with the full native set runs on the simulator, hits the dev
server, workspace packages resolve, connect spike result recorded, one Maestro
flow passes locally.

### Phase 1 – Foundation: Direct profiles, realtime, theme, shell (1–1.5 weeks)

1. Server profiles store (SecureStore, one key per profile) + profile picker +
   "Add server" (URL entry with `/health` + `/system/config` probe, error
   states, `NSLocalNetworkUsageDescription`, Android cleartext config).
2. `createMobileSdk(profile)`: `createBrowserBbSdk({baseUrl, fetch, websocket})`
   with the app-surface header; realtime manager implementing the
   `WebSocketManager`-shaped interface on RN WebSocket, `AppState` reconnect,
   lenient parsing of `thread-open`/`plugin-signal`/pane-action.
3. Theme: `scripts/generate-native-theme.ts` reads `theme.css` + built-in
   palette files → `theme.native.ts` (hex per token per mode per palette);
   drift test; NativeWind vars per palette; light/dark from `Appearance` +
   MMKV `bb.theme`; palette from `/system/config`; custom CSS → default
   palette with a note.
4. App shell with Expo Router: drawer + stack, error boundary, toaster
   (`sonner-native` or `burnt`), `focusManager` on `AppState`, connection
   banner, per-profile `QueryClient`.
5. Fonts/icons: Inter, Fira Code, `@hugeicons/react-native` `Icon` with the
   `ICON_MAP` names (or `react-native-svg` fallback if the package does not
   accept the free icon data).
6. Tests: vitest for profile store, sdk wrapper, realtime manager
   (reconnect/resubscribe), theme generator; Maestro: add a Direct server →
   shell renders.

### Phase 2 – `@bb/client-core`, hybrid (3–5 days, can overlap Phase 1)

Decision: hybrid. Extract only the already-pure modules listed in A3 step (1)
into `@bb/client-core` (web re-exports from the old paths; no provider
refactor). Mobile owns thin copies of the query hooks, cache owners, realtime
effects, and the timeline controller, adapted to the per-profile
`QueryClient` and the mobile realtime manager. Revisit full extraction after
M2 when the mobile shapes are known. `turbo run test --filter=@bb/app` stays
green per PR.

### Phase 3 – Sidebar, thread list, thread creation (1.5–2 weeks)

1. `GET /projects/sidebar-bootstrap` → sections, projects, threads, pinned;
   grouping/sorting from client-core; organize (project/machine/manual) + sort
   options; unread/pending glyphs; realtime `thread-list`.
2. Thread search (≥2 chars), recent threads on the home screen.
3. Long-press sheets: thread (open, mark read/unread, pin, rename,
   archive/unarchive, delete with child confirmation), project (settings,
   rename, add path via remote path browser, remove), section
   (create/rename/delete). New project (remote path browser + `POST /projects`),
   project settings screen (sources add/remove), machine setup dialog when the
   chosen host has no source.
4. Thread creation (plain text prompt for now): project, provider, model +
   reasoning, permission mode with host ceiling, service tier, environment
   (`project-default` default; `reuse`; `host` + `managed-worktree` base
   branch; `unmanaged` path), `POST /threads`, navigate-after-create pref.
   Accept `initialPrompt`/`reuseEnvironmentId`/fork/handoff seeds later
   (Phase 4b).
5. Archived threads screen, unarchive.
6. Tests: vitest for grouping/sorting/read state; Maestro: create thread, see
   it, rename, archive, search.

### Phase 4a – Thread detail, read-only (3–4 weeks) → **M1 dogfood**

1. Data: `useThreadDetailBootstrap`, `useThreadTimeline` (delta merge),
   `useThreadTimelineController`, child summary — from client-core.
2. Timeline list: FlashList, stable keys, sticky-bottom + "jump to latest",
   auto-load older, unread divider, working indicator from `activeThinking`,
   turn rows with lazy children, step/bundle summaries from
   `buildTimelineViewRows`, titles from `buildTimelineRowTitle`.
3. Row renderers: conversation (attachments, mentions, turn-request labels),
   assistant, command (ANSI via `anser`), tool, file-change (native diff +
   normalization rules), web-search/fetch, image-view, approval, question,
   delegation (nested), workflow/background task, system.
4. Markdown renderer (mdast → RN) incl. tables, code, links, images, mentions
   as pills, directive cards; image lightbox; localhost link rewrite pref.
5. Header (read-only): title, status pill, environment summary; context
   window usage; goal/mode/todo/model-fallback cards (read-only); table of
   contents sheet.
6. Tests: vitest for merge/paging/serialization; Maestro (fake adapter): open
   a seeded long thread, page older, see a `delay:` response stream in.
   **Checkpoint after the first three row renderers land: re-estimate 4a/4b.**

### Phase 4b – Act: composer, interactions, queue (3–4 weeks) → **M2**

1. Shared composer: `TextInput` + mention ranges model (spike result),
   `PromptEditorValue` serialization tests against web fixtures, typeahead
   sheet (threads, projects, sections, paths, plugin mentions, `/` commands),
   attachments (image picker, camera, document picker → one `file` field),
   voice (`expo-audio` + keep-awake → transcription route), drafts in MMKV,
   "+" actions menu, execution controls incl. service tier, submit modes from
   `buildFollowUpSubmitMode`, send (`queue-if-active` / `steer-if-active`),
   stop, cancel plan, clear goal. Swap thread creation onto it; accept
   fork/handoff/initialPrompt/reuseEnvironmentId seeds.
2. Queued messages list (view, send now, edit, delete, group boundary, move
   up/down).
3. Pending interactions banner: approvals (allow once / for session / deny),
   plan approval, user questions, plugin forms (`ask-user-question`,
   `secret-request` from the shared contracts package), generic fallback with
   Cancel; child-thread pending interactions surfaced in the parent.
4. Context banner sections: git changed files + merge-base picker, parent,
   children, pull request (status pill, Mark ready, Merge merge/squash/rebase,
   Convert to draft), archived (Unarchive), environment gone; "Handoff to new
   thread"; "New thread in this worktree".
5. Message actions sheet: copy, add to chat (message and paragraph quote),
   fork, edit (experiment), send to main thread. Thread actions menu in the
   header. Haptics on send/approve.
6. Tests: vitest for policy/serialization/mention model; Maestro (fake
   adapter): send → response; `ask_user` → answer → continues;
   `approve:command` → allow; queue two messages, reorder, send now.

### Phase 5 – bb connect, push, deep links (1.5–2 weeks) → **M2.5**

1. Connect enrollment UI (QR via `expo-camera`, manual code), session install
   - renewal, re-auth screen, profile list of the account's servers
     (`listAccountServers`). Web "Add mobile device" QR/code in Settings →
     Remote access + `bb connect machine-code` CLI + guide/skill updates +
     409 machine-limit handling.
2. Push: server table/routes/SDK/CLI/docs, Expo Push sender service with unit
   test, app registration per profile, tap → route, client-derived badge.
   Physical-device acceptance.
3. Deep links: `bb://` scheme + universal links → same paths as web via
   `route-paths.ts` builders (child threads whose parent is in another project
   included); `thread-open` WS signal → navigate. Cloud change: serve
   `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`
   from the gate before auth on `<handle>.getbb.app`; verify wildcard
   associated-domain behavior.
4. Tests: Maestro connect flow against a stubbed apex; unit tests for
   renewal, cookie install, push registration.

### Phase 6 – Workspace surfaces (2–3 weeks) → **M3**

1. Bottom-sheet panel with tabs: Info, Diff, Files, Terminal, plus tabs synced
   from `GET/PUT /threads/:id/tabs` (placeholders for browser / plugin-panel /
   side-chat kinds); same panel on root compose (project context).
2. Info: metadata rows (parent, forks, environment, directory, branch, PR pill,
   merge base, git status, commits, changed files, storage).
3. Diff tab: `/environments/:id/diff/files` + `diff/patch` batches (reuse
   `useEnvironmentDiffPatches`), tiering states, per-file cards, "add to chat".
4. Files: storage browser (`useThreadStorageBrowser` logic), file search
   (`/environments/:id/paths`), preview screen (text, markdown, image, CSV,
   HTML via WebView, video via `expo-video`); local file link routing from
   markdown.
5. Terminal: WebView page (bundled `xterm` + addons), RN-owned transport with
   the `bufferedAmount` socket adapter (+ vitest proving input flushes with
   `bufferedAmount` undefined), batched `postMessage`, throughput measurement,
   accessory key bar, create/restart/close/rename.
6. Commit dialog with 409 blocked messages.
7. Tests: Maestro: open Diff after a fake file change; open a text file;
   start a terminal and type `echo hi`.

### Phase 7 – Settings, machines, plugins management (2 weeks) → **M4**

1. Settings screens over `/system/config` + `PUT /settings/*`: general,
   appearance, experiments, provider pages, usage limits, updates
   (`/system/version` + provider CLI status/install NDJSON stream), machines
   (list, detail, rename, remove, permission ceiling, retry update, add machine
   via join code / connect code), marketplaces, community, archived, plugins
   (list, enable/disable, install/uninstall/update from marketplaces,
   descriptor settings), extensions/skills browse/library/registry, CLI skills
   install. Hide host-dependent screens when `primaryHostId` is null or the
   host is offline.
2. Share sheet target ("Send to bb" → new thread with text/image), clipboard,
   keep-awake, app icon variants (from `apps/app/public` sources).
3. Tests: Maestro settings toggle round-trip; machine rename through a stubbed
   gate (proves session-cookie auth, not machine header).

### Phase 8 – Optional and release (ongoing) → **M5**

1. SPA-in-WebView embed mode (`?embed=1`) + bridge for plugin nav panels,
   thread panel actions, and plugin settings sections; sidebar plugin rows and
   directive cards open it.
2. Tablet two-pane layout; landscape.
3. Web sign-in onboarding (apps/web route + deep link).
4. KaTeX/Mermaid WebView; custom palette anchor parsing.
5. TestFlight / Play internal via EAS; `eas update` for JS-only fixes; crash
   reporting decision (none exists in bb today).

## Server and cloud changes required

| Change                                                                                                          | Where                                                                                                                                                       | Phase | Notes                                   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------- |
| Request-side `mobile` app surface                                                                               | `packages/config/src/app-surface.ts`, `apps/server/src/request-context.ts`, telemetry                                                                       | 0     | Do not widen the server config union.   |
| Integration harness `serverPort`/`bindHost` options; fake adapter `approve:<kind>`                              | `tests/integration/helpers/harness.ts`, `packages/agent-runtime/src/test/*`                                                                                 | 0     | Test infra only.                        |
| `pnpm dev:backend` (server + daemon only)                                                                       | `packages/scripts`                                                                                                                                          | 0     | Convenience.                            |
| Shared pending-interaction contracts for `ask-user-question` / `secret-request`                                 | new shared package + both plugins                                                                                                                           | 4b    | Real cross-package contract.            |
| "Add mobile device" QR/code UI + `bb connect machine-code` CLI + guide/skill/config docs                        | `plugins/connect/app.tsx`, `plugins/connect/src/cli.ts`, `docs/cli-guide-and-skill.md` surfaces                                                             | 5     | Uses existing `createMachineCode` RPC.  |
| Push subscriptions + sender + SDK + CLI + docs                                                                  | `packages/db` migration, `apps/server`, `packages/server-contract`, `packages/sdk`, `apps/cli`, guide templates, `bb-cli/SKILL.md`, `docs/configuration.md` | 5     | No daemon change → no protocol bump.    |
| `.well-known` exemption at the gate for universal links                                                         | `apps/connect/src/worker.ts`                                                                                                                                | 5     | Cloudflare deploy.                      |
| Fallback only: session value via header on `/ws*` + strip `Authorization` in `requestForTunnelDo`               | `apps/connect/src/worker.ts`                                                                                                                                | 5     | Only if the Phase 0 cookie spike fails. |
| SPA embed mode (`?embed=1`) + bridge                                                                            | `apps/app`                                                                                                                                                  | 8     | Optional.                               |
| Later: `/ws` since-cursor; open-in-target proxied to the environment host (`HOST_DAEMON_PROTOCOL_VERSION` bump) | server / daemon                                                                                                                                             | —     | Not in v1.                              |

## Testing strategy

- **Pure logic (vitest, node env)**: everything in `@bb/client-core` and
  `apps/mobile/src/lib/**` (profiles, session/cookie install, realtime
  manager, mention model + serialization fixtures shared with web tests, theme
  generator drift, terminal socket adapter + bridge batching, markdown
  transforms, diff normalization). Runs in the Linux CI shard.
- **Screens (Maestro)**: flows under `apps/mobile/e2e/flows`, run against the
  `tests/mobile-e2e` harness backend (fake adapter: `Response to: …`,
  `delay:<ms>`, `call_tool:<n>`, `ask_user`, new `approve:<kind>`) on the iOS
  Simulator (`127.0.0.1`) and Android emulator (`10.0.2.2` / `adb reverse`).
  Deterministic seeds; e2e reset entry; screenshots kept as artifacts.
- **Live QA**: `scripts/bb-dev-app current` + the dev-client on the simulator
  against real providers; physical iPhone via a Tailscale Serve URL, a
  temporary `BB_SERVER_BIND_HOST=0.0.0.0` LAN URL, or `bb connect expose
<server-port>` from this thread.
- **Connect QA**: stubbed apex + gate for automated flows; a staging handle
  for manual checks; push and universal links on a physical device.
- **Contract drift**: typecheck of the typed client from `@bb/server-contract`;
  label-gated Maestro run in CI on the macOS runner after the Phase 0 probe.
- **Web regression**: every `@bb/client-core` extraction PR keeps
  `turbo run test --filter=@bb/app` green; the 28 mocking tests are migrated
  explicitly.

## Limitations (explicit)

- Plugin **frontends** do not run natively. v1 ships native forms for
  `ask-user-question` and `secrets`, plugin mentions, descriptor-based plugin
  settings, and directive placeholder cards. Nav panels (Automations, Tasks,
  Docs, GitHub) and DOM `settingsSection` pages (connect Remote access, memory,
  custom-instructions, keep-awake) need the optional SPA-in-WebView (M5).
  Composer customization, message-action callbacks, content scripts, side-chat
  panels: not available.
- Provider sign-in (`codex login`, `claude /login`) still needs a terminal on
  the host. The phone assumes a signed-in host.
- Local editor integration, "Open in …", native folder picker: not available
  (no daemon on the phone). Remote path browser works.
- Custom CSS themes and plugin themes: only built-in palettes map to native
  tokens in v1.
- Splits, drag reorder, keyboard shortcut editor, desktop browser automation:
  not planned. Text-selection quoting is per paragraph.
- KaTeX/Mermaid render as source in v1.
- Push needs an EAS project, APNs/FCM credentials, a physical device, and a
  server that can reach `exp.host`.
- Direct mode is unauthenticated by design (same as the PWA over LAN /
  Tailscale). Plain `http://` works only for LAN IPs / `.local` on iOS.
- Each phone consumes one of the 20 connect machine slots per account.
- Two Tailwind majors may coexist in the repo (v4 web, v3 for NativeWind v4)
  unless NativeWind v5 passes the spike.

## Open decisions for the user

1. Approve the auth model: machine enrollment + desktop-session cookie via a
   native cookie manager (no gate change), header fallback only if the spike
   fails.
2. `@bb/client-core` extraction as its own phase (recommended) vs. thin
   copies in mobile.
3. Push via the Expo Push API (recommended) vs. direct APNs/FCM; provide EAS
   org, Apple team, bundle id, URL scheme.
4. Terminal in M3 (WebView xterm) or later.
5. SPA-in-WebView for plugin panels/settings sections in the roadmap (M5) or
   drop.
6. Android: install the SDK/emulator now (~10 GB) or after iOS M1.
7. Accept the ~16–22 week horizon to M4, with M1 dogfood at ~week 8.
