# @bb/mobile

Native iOS/Android client for bb (Expo SDK 57, React Native 0.86, Expo
Router, NativeWind v5). Plan and decisions: `plans/bb-mobile-expo.md`.

Status: Phase 7 (settings, machines, updates, plugins, skills, share,
haptics, CI) — M4, the last build milestone, over Direct mode and bb connect;
M5 (SPA-in-WebView plugin surfaces, tablet layout, store releases) is
deferred. Direct-mode and bb connect server profiles (QR / code pairing, desktop-session
cookie, re-pair), the app shell (root stack, connection banner, settings),
theme/design system, the per-profile SDK/realtime/query layer, the grouped
thread list (home, long-press menus, organize/sort, drag-to-reorder
sections per organize mode under the web localStorage keys, search, archived),
thread creation on the shared composer (mentions, attachments, voice, fork /
handoff seeds), the thread detail screen (`/threads/[id]`: the virtualized
timeline with every row kind, markdown, inline diffs, terminal output, images +
lightbox, sticky-bottom, older pages, unread divider; the
prompt area with pending-interaction banners, the prompt chip row, the context
banner, the queued-message list and the follow-up composer; header / message /
git action sheets), push notifications + deep links, and the workspace panel
(a bottom sheet with Info · Diff · Files · Terminal + the thread's synced file
tabs: thread metadata, the batched Diff tab with "Add to chat", file search /
thread-storage browser / previews for text, markdown, CSV, HTML, images, the
xterm terminal in a WebView with an accessory key bar, full-screen file and
terminal routes, and the same panel on the compose screen for project files
and a host terminal), the settings buckets (General / Appearance /
Experiments / Haptics, provider settings, usage limits, Machines with pairing /
rename / permission ceiling / provider CLI installs, Updates, Plugins with
detail / settings form / logs / catalog / marketplaces, Skills library +
skills.sh registry, Notifications, Discord / GitHub), "Share link" from the
thread menu, and the `Mobile E2E` GitHub workflow are in place. The Phase 0
spikes and the renderer / composer / interactions showcases live under
Settings → Developer.

## Structure

```
app/                     Expo Router routes (thin: each file re-exports a screen)
  _layout.tsx            providers: GestureHandlerRootView › SafeAreaProvider ›
                         KeyboardProvider › PaletteProvider › ThemeProvider ›
                         ProfilesProvider (QueryClientProvider per profile) ›
                         SheetProvider › RootNavigator + Toaster
  index.tsx              home: the thread list + compose dock; the workspace menu (server
                         switcher / archived / Settings) opens from the header avatar
  threads/[id].tsx       thread detail (Phase 4a, read-only); threads/search.tsx;
                         threads/[id]/terminal/ (index: the thread's terminals,
                         [terminalId]: one terminal full screen, any orientation);
                         threads/[id]/files (the Files tab full screen, or a file
                         preview for ?kind=&path=&line=[&source=&status=])
  settings/              index (the settings buckets), servers/ (list),
                         servers/add (bb connect entry + Direct mode form),
                         archived (archived threads), server (server status
                         card), general, appearance, experiments,
                         providers/[providerId] (codex | claude-code), usage
                         (usage limits), updates (bb + provider CLIs + CLI
                         skills), machines/ (index: the paired machines + the
                         add-machine sheet, [hostId]: one machine), plugins/
                         (index: installed plugins, browse: the catalog,
                         [pluginId]/index: one plugin, [pluginId]/logs: its
                         log tail), marketplaces, skills/ (index: the library,
                         [skillId]: one skill read-only, registry/index:
                         skills.sh browse, registry/[registrySkillId]: one
                         registry skill + install)
  connect/index.tsx      bb connect enrollment (QR / code) — also the re-pair
                         target (`?profileId=`) and the `bb://connect?code=…` link
                         (the new-thread composer is the home screen's bottom
                         dock: `/?projectId=&sectionId=&initialPrompt=&reuseEnvironmentId=`
                         + the fork / handoff seed params open it)
  projects/              new (create project), [id]/settings (rename, sources, delete),
                         [id]/threads/[threadId] (web deep-link alias → threads/[id])
  dev/                   ui (gallery), diff (diff + terminal showcase), markdown
                         (markdown showcase), work-rows (timeline work-row renderers
                         on synthetic rows), interactions (pending-interaction
                         banners + queued list on synthetic payloads, plus a
                         "Live thread" section for any thread id), spike,
                         connect-spike (Phase 0 diagnostics). Dev /
                         EXPO_PUBLIC_BB_E2E=1 only: release bundles redirect
                         them (and bb://dev/* links) home
  e2e/reset.tsx          bb://e2e/reset — wipes local state (dev / EXPO_PUBLIC_BB_E2E=1)
  +native-intent.tsx     redirectSystemPath: every incoming URL (bb:// scheme,
                         universal links, dev-client URLs) → src/lib/links
                         resolution → profile switch + route / add-server prompt
src/
  app-shell/             RN glue: ProfilesProvider + hooks (useProfiles,
                         useProfileClient, useRealtimeConnectionState,
                         useConnectionBanner), useAppBoot, PaletteProvider,
                         client-registry (per-profile clients + the global
                         mutation-error toast), e2e reset wiring,
                         waitForActiveConnection,
                         ThreadOpenSignalHandler (realtime `thread-open` →
                         navigate, like the web's wsManager.onThreadOpen)
  notifications/         push (RN glue): expo-notifications behind the data
                         layer's PushNotificationsModule, MMKV push store,
                         app-wide registration controller, PushNotificationsHost
                         (registration sync, taps → thread, foreground toast
                         with Open, app-icon badge, first-run prompt),
                         and usePushRegistration (Settings)
  screens/               screen components (home/ — thread list + the
                         new-thread ComposeDock; compose/ — ComposeDock,
                         useComposeController; settings/, shell/, connect/ — bb connect enrollment: ConnectEnrollScreen,
                         ConnectScanner (expo-camera QR), AccountServersList;
                         projects/, pickers/ — reusable picker sheets: project,
                         provider, model+reasoning, permission mode, environment,
                         machine, branch, folder, remote path browser;
                         sidebar/ — grouped thread list (FlashList), rows, status
                         glyph, long-press action sheets, display options;
                         threads/ — search, archived;
                         thread/ — thread detail: ThreadDetailScreen (list +
                         prompt area inside KeyboardPaddingView), the native
                         header pieces (title + status subtitle, panel + "…"),
                         cards/ (PromptChip + the prompt chip row: workflows,
                         background tasks (glyph shimmers while live), plan +
                         Exit, goal + Clear, to-dos, model fallback, plus the
                         context/ chips, each a pill that opens a detail
                         sheet; context-window ring), prompt-area/
                         (ThreadPromptArea: banner-or-stack + the follow-up
                         Composer; useFollowUpComposer: draft, submit mode,
                         send / queue / steer / stop, edit modes, quoting;
                         useThreadExecutionOptions: thread defaults → pills →
                         execution overrides; pure follow-up-submission.ts),
                         and timeline/ (FlashList TimelineList with
                         memoized cells, rows.ts list model — flat items with
                         kind/depth/parentKind/expanded + identity cache —,
                         renderers.ts registry + fallback, TimelineTitleView,
                         sticky-bottom + unread-divider policies; renderers/
                         index.ts registers every row renderer once (dev warns
                         on a missing kind): conversation/ (authored bubble,
                         generated "Message from …" row, assistant markdown,
                         attachments), system/, turn/, summaries/, work/
                         (WorkRowShell over the shared header), shared/
                         (TimelineRowShell, ExpandableRowHeader, past-row dim);
                         host/ TimelineRowHostProvider (server URL, sender
                         metadata, thread navigation, image lightbox,
                         long-press message actions); lightbox/);
                         context/ — ThreadContextChips (related-thread chip,
                         child threads / needs-input chip, pull request chip +
                         Mark ready / merge methods, changed-files chip → sheet
                         with WorkspaceChangesList, merge base →
                         MergeBasePickerSheet, Open diff; archived /
                         environment-gone status chip), use-thread-context-chips.ts
                         (data assembly), pure context-model.ts;
                         actions/ — MessageActionSheet + message-actions-model
                         (copy / quote paragraph / add to chat / edit / fork /
                         send to main), useMessageActionHandlers (fork →
                         home dock seed, side-chat send-to-main),
                         ThreadActionsSheet (header "…" menu: handoff, new
                         thread in worktree, rename, pin, read state, move,
                         copy link, open in web, archive, delete),
                         ThreadGitActionSheet + useThreadGitActions (commit
                         through the environment actions);
                         interactions/ — PendingInteractionBanner (approval /
                         user question / ask-user-question + secret-request
                         plugin forms / unsupported-plugin card), QuestionForm,
                         SecretRequestForm;
                         queue/ — QueuedMessagesList (send now, edit via
                         onEdit, move up/down, group toggle, delete);
                         dev/ — renderer showcases (markdown, work rows) +
                         fixtures; shell/hrefs.ts — typed-route boundary;
                         panel/ — the workspace panel (Phase 6): a 92% bottom
                         sheet with the tab strip (Info · Diff · Files ·
                         Terminal + the thread's synced closable file tabs),
                         WorkspacePanelProvider + usePanel() controller,
                         the tab-content registry (registerPanelTabContent /
                         registerPanelLauncherContent; Diff / Files / Terminal
                         register their contents), ThreadInfoTabContent, the
                         thread + root-compose providers; see panel/README.md);
                         diff-tab/ — the panel's Diff tab: DiffTabContent
                         (header with target picker + merge base, file-count
                         and +/- pills, collapse-all, refresh; FlashList of
                         DiffTabFileCard over @/diff DiffFileCard with
                         skeleton / "Load diff" / too large / error bodies
                         and per-file "Add to chat"), DiffTargetPickerSheet,
                         register.tsx (the `git-diff` panel registration:
                         scroll-to path, close-then-quote into the thread's
                         composer host via the `quoteIntoComposer` prop);
                         terminal/ — the terminal (Phase 6): TerminalView
                         (xterm in a react-native-webview page + the RN-owned
                         attach socket), TerminalTabContent (terminal +
                         accessory key bar + not-running card),
                         TerminalAccessoryBar (esc / tab / sticky ctrl /
                         arrows / home / end / - / | / paste / keyboard / …),
                         TerminalSessionsList, panel-contents.tsx +
                         register.ts (the `terminal` tab kind and launcher),
                         TerminalScreen (`/threads/[id]/terminal/[terminalId]`,
                         any orientation) + ThreadTerminalsScreen, pure
                         terminal-bridge.ts / terminal-stream.ts /
                         terminal-scope.ts / terminal-theme.ts, and
                         page/terminal-page.ts (the WebView page source)
                         files/ — Files tab + file previews (Phase 6):
                         FilesTabContent (search box → Workspace files /
                         Thread storage sections with match highlights;
                         idle: Recent files + the thread-storage browser with
                         breadcrumbs; long-press → copy path / name),
                         FilePreviewView (header: name, source pill, size,
                         tappable path, Preview/Source toggle, jump to line,
                         open in browser, reload; bodies: TextFilePreviewBody
                         — virtualized mono lines with numbers, horizontal
                         scroll, line-range highlight, long-press line → Add
                         to chat / Copy line / Copy path:line; markdown via
                         @/markdown with sibling links + images; CSV grid;
                         HTML in a WebView on the CSP-sandboxed raw route;
                         image + lightbox; video hand-off card; loading /
                         not-found / too-large / error / empty / binary),
                         FilePreviewScreen (`/threads/[id]/files`),
                         file-preview-target.ts (target union ↔ route
                         params), file-opener.tsx (useThreadFileOpener:
                         context override → workspace panel tab → route;
                         records recents), use-thread-local-file-links.tsx
                         (absolute `/path[:line]` → workspace root → thread
                         storage → host file; relative references → root
                         picker), panel-contents.tsx + register.ts (the
                         "files" launcher + the three preview tab kinds)
  data/                  TanStack Query hooks + pure helpers per area (diff —
                         the Diff tab's data: diff/files TOC query, the
                         viewport-driven batched diff/patch loader, the target
                         selection over the merge base, the collapse store,
                         the add-to-chat patch text; thread-tabs —
                         GET/PUT /threads/:id/tabs sync: per-profile write
                         queue with 409 rebase-and-retry, MMKV fixed-panel
                         state store, useSyncedPanelTabs; connect —
                         pairing payload parsing, enrollment target resolution,
                         redeem + error copy, account servers hook; sidebar,
                         threads, thread-detail, projects, sections, hosts,
                         system, compose, environments — record, workspace
                         status + merge base, pull request, git / PR actions
                         with 409 "blocked" toasts —, interactions — resolve/respond/cancel
                         pending interactions, question form state, plugin
                         payload parsing, child-thread attention —, thread-runtime
                         — send/edit/stop/cancel-plan/clear-goal + the queued
                         message CRUD with optimistic transactions,
                         notifications — push registration policy
                         (decidePushSync / syncPushRegistration / controller),
                         push store, plugin RPC wrapper,
                         notification payload → profile resolution, badge count);
                         see src/data/README.md
  lib/                   pure TypeScript, vitest-tested (no react-native imports)
    profiles/            ServerProfile model, SecureStore-backed store, URL
                         validation, /health + /system/config probe
    sdk/                 createMobileSdk (@bb/sdk/browser + app-surface header),
                         per-profile client registry
    realtime/            WebSocketManager-shaped realtime on RN WebSocket
    query/               query keys, per-profile QueryClient, AppState focus,
                         realtime → query invalidation (+ the observer-less
                         diff-patch cache it evicts on workspace events)
    session/             bb connect desktop-session cookie scheduler (Phase 5)
    connection/          active-profile connector (socket + session lifecycle),
                         connection banner derivation
    e2e/                 launch/deep-link reset logic
    links/               incoming-link resolution: bb:// scheme + web/universal
                         links → mobile route, profile match, add-server prompt
    native/              RN adapters for the lib contracts (SecureStore,
                         cookies, AppState) — never imported by tested modules
  diff/                  native unified-diff renderer: parse-unified-diff (parse-git-diff
                         wrapped in our DiffFile/DiffHunk/DiffLine types, tolerant of
                         bare/synthetic patches, binaries, renames), file-change-diff
                         (TimelineFileChange → diff | plain | none via client-core's
                         renderable-patch rules), DiffFileCard / DiffHunkView /
                         FileChangeDiffBlock (pinned gutter, horizontal scroll,
                         "Show N more lines" cap, add-to-chat action)
  ansi/                  SGR parser (ansi-to-spans → 16-color theme palette, 256/truecolor
                         snapped, cursor/OSC stripped, \r rewinds), AnsiText /
                         AnsiSpansText, TerminalOutputBlock (command card that collapses
                         to its tail)
  markdown/              native markdown renderer (mdast → RN): parse (unified + remark
                         gfm/breaks/math/directive, memoized), the web's prompt/thread
                         mention transforms, directive normalization, link classification
                         (local file path[:line] / external / localhost rewrite),
                         sugar-high code spans, <Markdown> / <MarkdownText> / CodeBlock /
                         MarkdownTable / MarkdownImage / MentionPill, markdownToPlainText,
                         extractMarkdownHeadings; showcase at /dev/markdown
  theme/                 generated tokens, ThemeProvider, fonts (see src/ui/README.md)
  ui/                    NativeWind primitives (Text, Button, ListRow, Sheet, …;
                         KeyboardPaddingView — JS-state keyboard padding for
                         bottom-anchored composer screens; OverlayBounds — the
                         region under the header the composer's floating
                         typeahead may cover)
e2e/flows/               Maestro flows for launch, deep links, sending,
                         connect, and unreachable servers
e2e/manual/              flows that need a server the harness cannot provide
                         (phase7-plugins-devserver: the checkout's dev server;
                         demo-server: the apps/demo-server worker) and so are
                         not part of `pnpm e2e:ios`
e2e/subflows/            shared steps (launch-app.yaml: cold start through the
                         dev client + Metro, or `launchApp` of the embedded
                         Release bundle with `-e BB_E2E_EMBEDDED_BUNDLE=1`;
                         launch-to-home.yaml: launch + add the harness server +
                         wait for Home), called with `runFlow: ../subflows/<name>.yaml`
e2e/scripts/             seeding + CI helpers: create-idle-thread.sh ("P4b …"
                         threads), phase6-diff-setup.sh / phase6-files-setup.sh,
                         phase6-commit.js, connect-stub-control.js,
                         pick-simulator.mjs (newest iPhone 17 Pro/17/16 Pro
                         runtime), ci-run-flows.sh (the CI flow set against a
                         Release build; see "CI")
eas.json                 EAS Build profiles (development / development-device /
                         preview / production); see "Release"
assets/terminal/         index.html — the bundled xterm page (generated, committed;
                         `pnpm --filter @bb/mobile terminal:build`)
scripts/                 generate-native-theme.ts (theme tokens),
                         build-terminal-page.ts (the terminal WebView page),
                         data-smoke.mts
```

Rules: import `@bb/sdk/browser` (never `@bb/sdk`); no `@bb/shared-ui`; no DOM
APIs; keep RN-dependent code out of `src/lib/**` except `src/lib/native`.

## Prerequisites (macOS)

- Xcode 26.2 with an iOS 26 simulator runtime (`xcodebuild -downloadPlatform iOS`).
- CocoaPods (`brew install cocoapods`), `export LANG=en_US.UTF-8`.
- For Maestro e2e: `brew install --cask temurin@17` or `brew install openjdk@17`
  plus `brew install mobile-dev-inc/tap/maestro`; the `e2e:ios` script sets
  `JAVA_HOME=/opt/homebrew/opt/openjdk@17` unless already set.

## Develop

```bash
pnpm install                                   # applies patches/expo-modules-jsi@57.0.4.patch
cd apps/mobile
pnpm ios                                       # prebuild + build the dev-client, opens the simulator
EXPO_PUBLIC_BB_SERVER_URL=http://127.0.0.1:<port> pnpm dev   # Metro (dev-client)
```

The iOS Simulator shares the Mac loopback, so `pnpm dev` (repo root) or
`scripts/bb-dev-app current` gives a server URL that works as-is. Physical
phones need a Tailscale Serve URL, bb connect, or a temporary
`BB_SERVER_BIND_HOST=0.0.0.0`.

## E2E (Maestro)

```bash
# terminal 1: deterministic backend (fake provider, fixed port 41999)
pnpm --filter @bb/integration-tests e2e:mobile-backend
# terminal 2: Metro (EXPO_PUBLIC_BB_E2E=1 wipes profiles/preferences on every launch)
cd apps/mobile && EXPO_PUBLIC_BB_SERVER_URL=http://127.0.0.1:41999 EXPO_PUBLIC_BB_E2E=1 pnpm dev --port 8082
# terminal 3: flows
cd apps/mobile && pnpm e2e:ios
```

`phase1-shell.yaml` drives the real first-run flow (Add server → home →
workspace menu → Settings → Server status shows realtime connected); `smoke.yaml`
opens the Phase 0 diagnostics screen; `phase3-threads.yaml` exercises the
thread list (rename, pin, archive, Settings → Archived → unarchive, search);
`phase3-compose.yaml` creates a thread from the home dock (`bb://compose`
→ home; pickers, model, environment) and exercises the New-project machine/folder
pickers (pass `-e REPO_PARENT_DIR=<dir>` to also browse into the harness repo);
`phase4a-timeline.yaml` opens the seeded "Rich thread" (the seed leaves it
unread; after a run, `POST /api/v1/threads/<id>/unread` restores that), lands
on the unread divider and scrolls to the long message.
`phase4a-conversation-rows.yaml` opens
the seeded "Rows thread" (started on behalf of "Idle thread": the generated
"Forked from" row, its preview/body, long-press → Copy text, and the
source-thread chip) and the "Rich thread" (bubble, assistant prose, "Worked
for" recap; its pending question's banner covers the bottom third, so the
long-press check lives on the Rows thread). `phase4a-work-rows.yaml` adds the server, opens Settings →
Developer → Work rows showcase (`/dev/work-rows`: synthetic rows for every
`work:<kind>` through the real list model) and expands a command, a closed
step's compact intents, a tool card, a file-change diff, an answered
question, a delegation with children, and running / failed workflows.
`phase4b-interactions.yaml` and `phase4b-approval.yaml` take `-e THREAD_ID=<id>`
(create your own thread through the API and send it `ask_user` /
`approve:command echo hi` first): they open Settings → Developer →
Interactions showcase, load that thread in the "Live thread" section, answer
the question / tap Allow once and expect the banner to clear, then walk the
synthetic banner variants (command/plan approvals, secret-request form,
unknown-plugin card) and the queued messages list.
`phase4b-thread-actions.yaml` opens a thread named "P4b banner parent" (create
it first: a managed-worktree thread through the API with a file written into
its worktree, so the context banner's changed-files row and the header git
button appear), expands the banner, opens the git sheet, renames through the
title, walks the "…" menu (Copy link toast), long-presses an assistant message
and forks into the home dock.
The Phase 4b thread-screen flows each open a thread by a fixed title that
must exist on the backend (create it through the API first; Maestro ignores
`-e` overrides for keys a flow's `env:` block defines): `phase4b-send.yaml`
("P4b send": type hello → optimistic row → "Response to: hello" → draft
cleared), `phase4b-ask-user.yaml` ("P4b ask user": `ask_user` → the question
banner replaces the composer → answer → composer back, turn completes),
`phase4b-approve.yaml` ("P4b approve": `approve:command echo hi` → Allow once
→ "Response to: …"; again → Deny → "Denied"), `phase4b-queue.yaml` ("P4b
queue": `delay:30000 first` → Stop + queue affordances → queue "second" →
Send now → steered into the turn), `phase4b-actions.yaml` ("P4b actions":
environment line, "…" → Rename, long-press → Copy text, Add to chat quotes
into the composer). `phase4b-composer.yaml` drives the composer showcase's
typeahead, pills, "+" menu and attachment chip. The shell rewrite deleted
`phase5-links.yaml`. `shell-deep-link.yaml` now checks the applicable native
route at `bb://settings/notifications`. It does not restore the deleted flow.
`phase6-panel.yaml` opens a thread named "P6 panel thread" (create it first:
a managed-worktree thread through the API with a file written into its
worktree), presents the workspace panel from the header button, checks the
Info tab's Directory / Branch / Git status / Changed files rows, taps
"Changed files" (the Diff tab becomes the selected strip entry), switches to
Info and the Files launcher, and swipes the sheet away. Under
`EXPO_PUBLIC_BB_E2E=1` a Metro reload mid-flow (another agent saving a file)
wipes the profile; when sources are being edited concurrently, run Metro
without that flag for this flow.
`phase6-diff.yaml` opens the thread named "P6 diff" whose worktree
`e2e/scripts/phase6-diff-setup.sh` dirtied (`SERVER_URL=… ./e2e/scripts/phase6-diff-setup.sh`
creates a managed-worktree thread through the API, then modifies the first
tracked file, deletes the second and adds `phase6-added.ts` — the fake
provider never edits files, so the shell does; re-runs reset and re-dirty
the same worktree), taps the banner's "Open diff" (the panel's Diff tab),
checks the modified / deleted / added cards and the hunk, the target picker
(uncommitted + merge base), collapse-all, "Add to chat" (the panel closes
and `> diff --git …` lands in the composer), a banner file row focusing its
card, then commits through the API (`e2e/scripts/phase6-commit.js`,
`runScript`), refreshes and picks "Committed changes".
`phase6-terminal.yaml` takes `-e THREAD_TITLE=<title>` (any thread; the seed's
"Idle thread" works): it opens the workspace panel's Terminal tab, starts a
session, opens it full screen, types `echo bb-42` and reads the output back
through the dev-only text mirror (`terminal-text-mirror`, a one-line
`accessibilityLabel` of the page's last lines — a WebView's text is invisible
to the accessibility tree, so this is how Maestro sees the terminal; only
rendered under `EXPO_PUBLIC_BB_E2E=1` / dev), interrupts a `sleep` with the
accessory bar's sticky Ctrl + `c`, recalls it with the arrow keys, and
renames the session from the "…" menu. `phase6-terminal-resume.yaml` runs a
slow producer, presses Home for 20 s (the socket suspends) and expects the
missed output after the app comes back.
`phase6-files.yaml` opens the thread named THREAD_TITLE ("Idle thread")
after `e2e/scripts/phase6-files-setup.sh` seeded its project checkout
(README.md, src/app.ts, data.csv, docs/index.html, assets/dot.png) and its
thread storage (notes/plan.md, report.csv) through `POST /files/write`:
workspace panel → Files launcher (storage browser lists notes › report.csv)
→ search "README" → the workspace result opens as a panel file tab
(markdown preview) → Source → Jump to line 60 → back to Files (the launcher
stayed mounted, so the query is still there: clear it) → notes ›
plan.md (storage preview) → close the panel → the full-screen preview by
deep link (`bb://threads/<id>/files?kind=workspace&path=src%2Fapp.ts&line=12`,
pass `-e THREAD_ID=`) lands on the highlighted line → long-press a line →
Copy line toasts.
`phase5-connect.yaml` drives bb connect end to end against the stub apex +
gate (`pnpm --filter @bb/integration-tests e2e:mobile-connect-stub`, see
"bb connect" below): Add server → "Connect with bb connect" → an expired code
shows the inline error → the real code with the handle and the self-hosted
apex → enrolled screen (session signed in, account servers listed, one tap
adds the second server) → Done → home through the gate (cookie on fetch and
on `/ws`) → Settings → Servers shows the mode pills and handles → the stub
expires the session (`POST /__stub/expire-session`: banner, then the app
re-mints and reconnects by itself) → the stub revokes the machine
(`/__stub/revoke-machine`: "needs to be paired again" banner) → tap the
banner → "Sign in again" re-pairs the same profile with a new code → home
connected again. The flow needs the stub started with
`BB_MOBILE_E2E_SIMULATOR=<udid>` once (it installs its root certificate in
that simulator) and drives the stub through `e2e/scripts/connect-stub-control.js`
(plain-HTTP control port 42997).
`phase7-settings.yaml` walks the settings buckets against the harness:
Experiments → toggles "New onboarding" (the switch reads checked after
leaving and coming back, and `phase7-settings-assert.js` reads the server's
`/system/config` to agree), Appearance → palette → Nord (the row shows
"Nord", the API agrees, the UI re-tints from the refetched config), Machines
→ the harness host (`phase7-machine-name.js` exports its id and name) →
detail (permission limit, provider CLIs) → Rename → the list shows the new
name → renamed back through the API; `phase7-settings-reset.js` puts the
experiments and the palette back to the defaults at the start and the end,
so the flow is safe on a shared backend. The Machines row sits below the
fold, so the flow scrolls to it.
Flows dismiss the keyboard by tapping a static label ("Server URL",
"Pairing code"): Maestro's `hideKeyboard` looks for a Return/Done key and the
Add server and connect fields use "next".
Flows cold-start the dev client (`stopApp`) because a warm reload keeps the
last deep link as the initial URL. Flows that share seed threads are
order-sensitive: `phase3-threads.yaml` renames "Idle thread", which
`phase4a-conversation-rows.yaml` looks up, so run the Phase 4a flows first (or
restart the backend between them). Without `EXPO_PUBLIC_BB_E2E=1`, open `bb://e2e/reset`
(dev builds) to return the simulator to first run.

### Flows against a Release build (no Metro)

A Release build (`npx expo run:ios --configuration Release --no-bundler
--device <udid>`) embeds the JS bundle and never starts the dev launcher, so
the same flows run without Metro: build it with `EXPO_PUBLIC_BB_E2E=1` (and
`EXPO_PUBLIC_BB_SERVER_URL=http://127.0.0.1:41999` for the smoke screen) in
the environment — the Xcode "Bundle React Native code and images" phase
inlines `EXPO_PUBLIC_*` at bundle time — and pass
`-e BB_E2E_EMBEDDED_BUNDLE=1` to Maestro. `e2e/subflows/launch-app.yaml`
switches on that variable between the dev-client deep link and a plain
`launchApp`; it is a `-e` variable on purpose because values in a flow's
`env:` block beat `-e`, and `METRO_URL` lives in every flow's header.
`e2e/scripts/ci-run-flows.sh <udid> <artifacts dir> [flow…]` is what CI runs:
it seeds "P4b send" (`create-idle-thread.sh`) and "P6 panel thread"
(`phase6-diff-setup.sh`) through the API, then runs `smoke`, `phase1-shell`,
`phase4a-timeline`, `phase3-compose`, `phase4b-send`, `phase6-panel` one
`maestro test` at a time with `--test-output-dir` per flow (screenshots,
logs, JUnit) and exits non-zero if any failed; `--dev-client` as the first
argument drives a dev client through Metro instead.

## CI

- Typecheck, lint, and unit tests run on Linux in the regular `CI` workflow
  (`pnpm exec turbo run build typecheck lint` in `Checks`, the `packages`
  test shard for `vitest`), like every workspace package.
- `.github/workflows/mobile-e2e.yml` (`Mobile E2E`) runs the flows above on
  the `blacksmith-6vcpu-macos-15` runner: label a pull request `mobile-e2e`,
  dispatch it by hand (optional `flows` input), or wait for the nightly run.
  It selects Xcode 26.2 (`DEVELOPER_DIR`, falling back to the newest 26.x),
  boots the simulator `pick-simulator.mjs` chooses, installs Maestro 2.8.0
  (Java 17 from `actions/setup-java` only when the image has no JDK 17+),
  restores `ios/Pods` + `Podfile.lock` and (behind the workflow's
  `CACHE_DERIVED_DATA` knob — DerivedData is ~7 GB raw and the Actions cache
  quota is shared with the Turbo caches) the Xcode DerivedData `Build/`
  directory from `actions/cache` keyed on `pnpm-lock.yaml` + `app.json` +
  `package.json` + `patches/**`, prebuilds, builds the Release app onto the
  simulator, starts the harness backend (`turbo run e2e:mobile-backend`,
  waits for `/health`), runs `ci-run-flows.sh`, and uploads
  `e2e-artifacts/` (per-flow Maestro output, backend log, simulator log).

## Files and previews (Phase 6)

- **Where**: the workspace panel's Files launcher (search + thread storage
  browser + recents) and one panel tab per opened file
  (`workspace-file-preview` / `host-file-preview` /
  `thread-storage-file-preview`, the client-core tab kinds synced with the
  web strip), plus the full-screen route `/threads/[id]/files` (the same
  `FilesTabContent` / `FilePreviewView` components) with the params
  `kind` (`workspace` | `host` | `storage` | `project`), `path`, `line`
  (`12` or `12-20`), `source` (`working-tree` | `head` | `merge-base:<ref>`)
  and `status` (`deleted`).
- **Opening files**: `useThreadFileOpener(threadId)` — the mounted workspace
  panel (`panel.openFile`, the file becomes a tab), else the route. Every open of a
  workspace / storage file lands in the thread's Recent list (MMKV
  `bb.thread.recentItems-<threadId>-1`, the web's key and JSON shape).
- **Local file links**: `useThreadLocalFileLinks` routes markdown
  `/abs/path[:line]` links (timeline rows through `TimelineRowHostProvider`,
  previewed markdown files): inside the environment's checkout → workspace
  file; inside the thread storage root (known once the storage list is
  cached) → storage file; otherwise a host-file read through the thread's
  host. Relative references (`src/a.ts:12` links, a bare relative path)
  resolve against the known roots and ask which one when both exist.
- **Content**: workspace files read `sdk.environments.diffFile` (working
  tree / HEAD / merge base; images and videos become `data:` URLs), host /
  storage / project files read the raw content routes with the profile fetch
  (cookie jar shared with expo-image and the WebView) and classify with
  `buildFilePreview` from `@bb/client-core`; a 413 `file_too_large` shows the
  too-large state with "Open in browser". HTML renders in a WebView pointed
  at the raw route (`/worktree/files/<path>`, `/thread-storage/files/<path>`,
  `/files/raw?path=` for host files — all answered with
  `Content-Security-Policy: sandbox allow-scripts`); video has no in-app
  player in this build (no expo-av / expo-video) and hands off to the system.
- **Add to chat**: long-press a line → "Add to chat" quotes
  `path:line\n<line>` into the thread's follow-up composer through the
  per-thread composer host (`registerThreadComposerHost`, set by the thread
  screen); a panel tab also closes the panel. Without a reachable composer
  (a deep-linked preview) the `path:line` reference is copied instead.

## Terminal (Phase 6)

- **Where**: the workspace panel's Terminal tab (sessions of the panel's
  scope + "Start terminal", then one tab per attached session with a
  title / restart / new / close toolbar) and the full-screen route
  `/threads/[id]/terminal/[terminalId]` (any orientation; the tab's title
  opens it). `/threads/[id]/terminal` lists the thread's sessions.
- **Transport**: React Native owns the socket. `@bb/client-core`
  `TerminalWebSocketTransport` over RN's `WebSocket`
  (`ws(s)://<server>/ws/terminals/:id?sinceSeq=N`, cookies from the native
  jar so bb connect works), heartbeat + reconnect from the transport, and
  `suspend()` / `resume()` bound to `AppState`: backgrounding closes the
  socket, foregrounding reattaches from the last chunk seen and the server
  replays what was missed. A replay gap the socket cannot cover
  (`replayStartSeq > nextOutputSeq`) is filled from
  `GET /terminals/:id/output?sinceSeq=`; only when the scrollback no longer
  reaches does the terminal reset with "Some terminal output was unavailable
  after reconnect" (the web's behavior). `terminal-stream.ts` holds that
  policy, `terminal-bridge.ts` the batching / encoding, both vitest-tested.
- **Page**: `assets/terminal/index.html` is a single self-contained document
  (xterm.js + fit + unicode11 + web-links + the page script and CSS inlined)
  built by `scripts/build-terminal-page.ts`
  (`pnpm --filter @bb/mobile terminal:build`) and committed;
  `src/screens/terminal/terminal-page.test.ts` rebuilds it in memory and
  fails when it is stale (like the theme drift test). It is loaded with
  `expo-asset` + `expo-file-system` and handed to `react-native-webview` as
  `source={{ html }}` — the page itself makes no network requests.
  RN → page: `init` / `theme` / `write` (base64 chunks batched to ≤16 KiB or
  16 ms) / `status` / `reset` / `resize` / `focus` / `blur` / `key` /
  `paste`; page → RN: `ready` / `data` (keystrokes and terminal replies) /
  `resize` (fit) / `link` / `title` / `text-mirror` / `error`. Replayed
  output is written with a completion callback and `onData` is muted until
  xterm has parsed it, so the PTY never receives a second cursor-position
  (DA1) reply — the web's `forwardTerminalData` / `writeTerminalOutput`
  semantics, ported to `terminal-bridge.ts`.
- **Input**: tapping the terminal focuses xterm's hidden textarea and raises
  the keyboard (`keyboardDisplayRequiresUserAction={false}`); the accessory
  bar above it adds esc, tab, a sticky ctrl (applied to the next keystroke),
  arrows, home / end, `-`, `/`, `|`, paste, a keyboard
  key and, full screen, a "…" that opens the same menu as the header
  (rename / restart / new / close). Cursor keys follow DECCKM (SS3 in
  application mode), Ctrl+arrow sends `CSI 1;5<final>`.
- **Data** (`src/data/terminals`): `useTerminals(scope)`
  (`GET /terminals?threadId|environmentId|hostId`),
  `useTerminalSession(id)`, `useCreateTerminal` / `useRestartTerminal` /
  `useCloseTerminal` / `useRenameTerminal`, `useFetchTerminalOutput`. Realtime
  `terminals-changed` (thread scope) invalidates the lists; the attach
  socket's `attached` / `session-updated` / `exited` are written straight
  into the cache. The shell's OSC title renames the session (debounced,
  path-like prompts ignored — the web's `normalizeTerminalTitle`).
- **Measured** (iPhone Air simulator, Direct mode): `seq 1 320000`
  (2.45 MB) reached the terminal in 365 ms from the first to the last
  `postMessage` batch (86 socket chunks → 83 batches), the view stayed
  responsive and ended on the last line; 1.42 MB took 369 ms. Server chunks
  are up to 64 KiB, so the batcher mostly coalesces small interactive
  output.

## bb connect (Phase 5)

- The pairing surfaces on the bb side (Settings → Remote access → Add mobile
  device, `bb connect machine-code`) sit behind the `mobileApp` experiment
  while the app is in early access: turn it on in Settings → Experiments or
  with `bb settings experiment mobileApp true` before you mint a code.
- Enrollment (`src/screens/connect`, `src/data/connect`, route `/connect`):
  "Add server" offers "Connect with bb connect" above the Direct URL form.
  The screen scans the pairing QR (`expo-camera`; payload = the connect
  plugin's `MobilePairingPayload` JSON `{code, serverUrl, apex, expiresAt}`, a
  `bb://connect?code=…&serverUrl=…` link, or a bare code —
  `parseConnectPairingPayload`) or takes the code by hand with an optional
  server (handle like `bee` or `https://bee.getbb.app`) and an optional
  self-hosted apex; the apex defaults to `deriveConnectBaseUrl(serverUrl)`
  or `https://getbb.app` (`resolveEnrollmentTarget`). `redeemEnrollment`
  calls `redeemMachineCredential` (`POST <apex>/api/connect/redeem-machine`)
  and saves `{mode:"connect", serverUrl, handle, credential(bbcm_…), label}`
  in SecureStore, then activates it: the connector mints the desktop-session
  cookie and opens realtime (the enrolled screen shows that status live).
  Errors map to copy per wire code (`describeEnrollmentError`: invalid /
  expired / already used, the 409 `machine_limit` with the "revoke a device
  in the dashboard" way out, network, unauthorized).
- Account servers: the machine credential is account-scoped (the apex stores
  it against the user, `apps/web/src/server/api.ts` `redeemMachineCode`; the
  gate checks it against the label's owner), and the desktop-session cookie
  is a `.getbb.app` cookie carrying only the user id, so one enrollment
  covers every server the account owns — the same as the desktop app's
  Server menu. After pairing, "Servers on this account"
  (`GET <serverUrl>/api/connect/servers` with the credential,
  `listAccountServers`) adds any other server as a profile in one tap with
  the same credential; no second code is needed.
- Session: `src/lib/session` mints `POST <serverUrl>/api/connect/desktop-session`
  with the credential, installs the cookie in both native jars (`Secure`
  follows the server URL's scheme so a plain-http stub gate works), renews
  five minutes before expiry and on AppState active. The connector
  (`src/lib/connection`) re-checks the session on any 401/403 (an API call
  or the `/ws` upgrade — React Native reports the refused upgrade as the
  close reason "Received bad response code from server: 401.") and on
  repeated connection failures (throttled): a fresh cookie reconnects the
  socket at once; a refused re-mint flips the profile to `auth-required`.
  Queries that raced the first mint (or a re-mint) and hit the gate's 401
  page are fetched again once the cookie lands
  (`refetchQueriesRejectedBeforeSession`); a 401 within two seconds of a
  mint is attributed to a request that started with the old cookie and
  only triggers that refetch, not another mint.
- Re-auth UX: the `auth-required` banner ("<label> needs to be paired again.")
  is a button that opens `/connect?profileId=<id>`, which re-pairs the same
  profile (new credential, same label and place in the list); Settings →
  Servers offers "Sign in again" from the long-press menu for connect
  profiles and shows a mode pill (`bb connect` / `direct`) plus `@handle`.
  "Remove" only forgets the profile locally: the phone stays listed under
  Machines in the getbb.app dashboard until revoked there (the copy says so).
- Stub for e2e (`tests/integration/mobile-e2e/connect-stub.ts`,
  `pnpm --filter @bb/integration-tests e2e:mobile-connect-stub`): plays the
  apex and the gate on one TLS port (`https://localhost:42998` /
  `https://stub.localhost:42998`, so `@bb/connect-client`'s "server lives
  under the apex" rule and the `Secure` cookie hold; iOS ATS refuses plain
  http to a qualified name). It redeems `STUB-PAIR` (sentinels
  `EXPIRED-CODE` / `USED-CODE` / `LIMIT-CODE` reproduce the apex errors),
  mints sessions for its machines, lists two account servers, and reverse
  proxies everything else (HTTP + WebSocket upgrade) to the harness backend
  — only with a valid session cookie, otherwise the gate's HTML 401 —
  rewriting `Origin: https://<gate host>` to the loopback origin like the
  tunnel client does so the bb server's origin guard accepts RN's
  WebSocket. Control: `POST /__stub/{expire-session,revoke-machine,reset}`,
  `GET /__stub/state`, also on plain `http://127.0.0.1:42997`. It generates a
  local CA under `~/.bb-mobile-e2e/connect-stub-certs` and installs it in
  the simulator named by `BB_MOBILE_E2E_SIMULATOR` (`xcrun simctl keychain …
add-root-cert`). Env: `BB_MOBILE_E2E_GATE_PORT` (42998),
  `BB_MOBILE_E2E_STUB_CONTROL_PORT` (42997), `BB_MOBILE_E2E_UPSTREAM_URL`
  (`http://127.0.0.1:${BB_MOBILE_E2E_PORT ?? 41999}`),
  `BB_MOBILE_E2E_CONNECT_CODE`, `BB_MOBILE_E2E_STUB_HANDLE`,
  `BB_MOBILE_E2E_SESSION_TTL_MS`, `BB_MOBILE_E2E_STUB_LOG=1` (one line per
  gate request).

## Push notifications and deep links (Phase 5)

- Registration: `PushNotificationsHost` (mounted once in `app/_layout.tsx`)
  registers the phone's Expo push token with each enabled server through
  Settings → This device → Notifications. It calls the `push-notifications`
  plugin RPC methods `pushSubscriptions.add`, `pushSubscriptions.list`, and
  `pushSubscriptions.remove` through `sdk.plugins.callRpc`. It syncs on
  connect, on
  AppState active, when the OS rolls the token (re-register), and when the
  toggle flips; profiles removed from the app get their server row deleted
  by the stored server URL. A direct profile must use HTTPS, unless it uses
  `127.0.0.1`, `localhost`, or `::1`. Tailscale Serve and bb connect profiles
  work normally. Other HTTP profiles show "Push needs HTTPS or bb connect"
  and do not register. The server also needs outbound access to `exp.host`.
  The server must enable the `push-notifications` plugin.
  The one-time "Get notified…" sheet appears only after the first successful
  connection. The sheet never appears on launch. The OS prompt starts only
  after the user selects "Turn on notifications".
- Privacy: the registration request contains the full Expo token. The list
  RPC method and `bb push-notifications list` return only the last six token
  characters in `tokenSuffix`. A token can receive pushes but cannot read
  server data.
- Handling: a foreground arrival becomes a toast with "Open" (no system
  banner); a tap on a background / cold-start notification opens
  `/threads/<threadId>` on the profile that owns it. The phone first matches
  the optional `serverUrl` hint. It probes saved profiles for the thread only
  when no hint matches. The web page sends the app-icon badge count through
  the mobile bridge, and `AppBadgeSync` keeps that count on background.
- Simulator check without APNs: `xcrun simctl push <udid> app.getbb.mobile
payload.apns` with `{"aps":{"alert":{…}},"body":{"kind":"turn-finished",
"threadId":"…","projectId":"…","serverUrl":"https://…"}}`
  (expo-notifications reads remote `data` from the `body` key) after the user
  grants permission.
- Deep links: `bb://<mobile path>` (`bb://threads/<id>`, `bb://settings/servers`,
  `bb://projects/<p>/threads/<t>`, …) and universal / app links
  `https://<handle>.getbb.app/{threads,projects,settings}/*` (iOS
  `associatedDomains: applinks:getbb.app, applinks:*.getbb.app`; Android
  `intentFilters` with `autoVerify`). `app/+native-intent.tsx` resolves every
  URL with `src/lib/links`: a web link whose origin matches a saved profile
  switches to that profile (waiting for its connection) and maps the web
  path onto the mobile route (`mapWebPathToMobilePath`; web-only surfaces
  land on home / settings); an unknown server opens Add server prefilled
  with the origin and the follow-up path. Universal links only resolve once
  `https://<handle>.getbb.app/.well-known/apple-app-site-association` /
  `assetlinks.json` are served (the connect gate and the apex do, before the
  session gate — `packages/connect-db/src/app-links.ts`) and the app is
  signed with the team id in that file; until then only the `bb://` scheme
  works, and wildcard associated-domain behavior still needs a physical
  device check. The realtime `thread-open` signal (`POST /threads/:id/open`,
  `bb thread open`) navigates to the thread while the app is foregrounded.

## Plugins, marketplaces, skills (Phase 7)

- Data: `src/data/plugins/` (`usePluginList` over `GET /plugins`, kept live by
  `plugins-changed`; `usePlugin`, `usePluginSettings`, `usePluginUpdates`,
  `usePluginLogs` (raw `GET /plugins/:id/logs?tail=`, not in the SDK),
  `usePluginCatalogSearch`, `usePluginCatalogInstallPlan`,
  `usePluginMarketplaces`, `useServerSvgAsset`; mutations enable / disable,
  update settings (changed keys only, secrets write-only), check / apply
  updates, remove, reload, install (source or catalog, with the third-party
  `confirmedSource`), add / refresh / remove marketplaces; pure
  `plugin-model.ts` ports the web's row signal / health presentation /
  settings-form rules) and `src/data/skills/` (`useProjectSkills` of the
  personal project = the library, skill files / content, the skills.sh
  registry search / entry / detail, install / delete; pure `skill-model.ts`).
- Screens: `src/screens/plugins/` (PluginsScreen with the long-press menu,
  PluginDetailScreen: enable switch, health + recovery, update card,
  `PluginSettingsForm` (string / secret / boolean / select → option sheet /
  project → ProjectPicker), includes, runtime, source, reload / logs /
  uninstall; PluginLogsScreen; PluginBrowseScreen grouped by publisher with
  `AddPluginSheet` (full-trust warning, third-party resolved-source
  disclosure); MarketplacesScreen) and `src/screens/extensions/` (skills
  library grouped by scope, SkillDetailScreen rendering SKILL.md with
  `@/markdown`, RegistrySkillsScreen with Load more, RegistrySkillDetailScreen
  with "Install to my skills").
- Plugin compact icons and provider logos are `currentColor` SVGs served by bb:
  `ServerSvgIcon` reads them as text through the profile fetch and renders
  `SvgXml` with the theme foreground (an image view would paint them black);
  the provider picker uses it for `GET /system/providers/:id/logo`.
- Plugin _frontends_ (nav panels, settings sections, directives) still do not
  run natively (see the plan's A5 / Limitations); only the server-side
  management surfaces above are covered.
- The integration harness runs no plugin service: on `e2e:mobile-backend` the
  installed list is empty (the flow asserts the empty state) while the
  catalog / marketplaces / skills routes work. `e2e/manual/phase7-plugins-
devserver.yaml` drives the same screens against the checkout's dev server
  (`scripts/bb-dev-app current`; real builtin plugins, read-mostly) and is not
  part of `pnpm e2e:ios`.

## Share sheet and haptics (Phase 7)

- Outbound: the thread "…" menu's "Share link" hands the thread's web URL to
  the OS share sheet (`src/lib/share/share-thread.ts`, RN `Share.share`; iOS
  gets a `url` item, Android a `message`).
- Inbound "Send to bb" is wired for `expo-share-intent` but the native module
  is **not** in the current dev client: `src/lib/share/share-intent.ts` loads
  it optionally (Metro's `allowOptionalDependencies` keeps the bundle building
  without it) and `src/app-shell/ShareIntentHandler.tsx` renders nothing when
  it is absent. To enable it: `npx expo install expo-share-intent`, add
  `["expo-share-intent", { "iosActivationRules": { "NSExtensionActivationSupportsText": true, "NSExtensionActivationSupportsWebURLWithMaxCount": 1 } }]`
  to `app.json` plugins, rebuild the dev client (`pnpm ios`, ~10 min, also
  reinstall it on every simulator the flows use). Shared text / URLs open
  `/compose?initialPrompt=`; media / file shares are declined with a toast
  in this phase.
- Haptics: `src/lib/haptics/` — `haptic(kind)` maps semantic kinds
  (`selection`, `impact-light|medium|heavy`, `success`, `warning`, `error`)
  onto expo-haptics and honors the Settings → Preferences → Haptics toggle
  (MMKV `bb.haptics.enabled`, default on). Call sites: `Button haptic`,
  picker rows (selection), composer send (medium), approvals / saves /
  installs (success), destructive ActionSheet rows (warning), long-press
  menus (heavy). Screens never import expo-haptics directly.

## Release (EAS)

The app lives in the EAS project `@bb-team/bb-app` (id in
`app.json` → `extra.eas.projectId`; the Expo slug `bb-app` also names the
dev-client scheme `exp+bb-app://`). Apple team `9QCU24SXK5`, bundle id
`app.getbb.mobile`, App Store Connect app `6803559210`. EAS holds the iOS
credentials (distribution certificate, App Store provisioning profile, APNs
push key); nobody needs a local Xcode signing setup to ship.

- **Log in once**: `pnpm exec eas login` (or `EXPO_TOKEN`). `eas-cli` is a
  pinned devDependency, so use `pnpm exec eas …` from `apps/mobile`.
- **Build profiles** (`eas.json`): `development` (simulator dev client),
  `development-device` (dev client for a physical iPhone; needed for push
  acceptance), `preview` (internal ad-hoc), `production` (App Store /
  TestFlight; `autoIncrement` + `appVersionSource: remote` keep the build
  number on EAS, `version` in `app.json` is the marketing version).
- **Push release check**: confirm the APNs key with `pnpm exec eas credentials
  -p ios`. Use `development-device` for a physical iPhone. Keep the server
  `push-notifications` plugin enabled, and use an HTTPS or bb connect profile.
  Run `bb push-notifications list`. Confirm that it shows a token suffix, not
  a full token.
- **TestFlight by hand**: `pnpm exec eas build -p ios --profile production`,
  then `pnpm exec eas submit -p ios --latest`. The submit profile reads the
  App Store Connect API key from the gitignored `apps/mobile/asc-api-key.p8`
  (key id and issuer id are in `eas.json`); get the `.p8` from a teammate or
  App Store Connect → Users and Access → Integrations → App Store Connect API
  (role App Manager, one-time download). Both commands also work with
  `--non-interactive`.
- **CI**: `.github/workflows/mobile-ios-eas.yml` writes the `.p8` from the
  `ASC_API_KEY_P8` secret, optionally sets `app.json` `version`, and runs
  `eas build -p ios --profile <profile> [--auto-submit]` with
  `EXPO_TOKEN`. EAS builds, then uploads to TestFlight; the job waits for
  both and fails when either fails. Logs are on expo.dev under the project's
  Builds and Submissions (the run summary links them). After a submit, the
  job runs `scripts/testflight-distribute.mjs`, which waits for App Store
  Connect to process the build, submits it for Beta App Review when it has
  none, and adds it to the external group named by the `external_group`
  input (default `External testers`; empty skips the step). Run the script
  by hand with `node scripts/testflight-distribute.mjs --version X.Y.Z
--build N` from `apps/mobile` with the `.p8` in place.
  Run it alone from the Actions tab ("Mobile iOS (EAS)") or
  `gh workflow run mobile-ios-eas.yml -f profile=production -f submit=true`.
  The nightly `publish-bb-app.yml` calls the same workflow after the npm
  nightly publish with an empty `version`, so every nightly keeps the
  marketing version committed in `app.json` and only the EAS build number
  moves. This is deliberate: TestFlight needs a Beta App Review for the
  first build of each new marketing version, and later builds of the same
  version skip it. Bump `app.json` `version` only when you want a new
  review, for example for a store release. Repo
  secrets: `EXPO_TOKEN` (a robot token from the `bb-team` Expo org) and
  `ASC_API_KEY_P8` (the `.p8` contents).
- The `expo-modules-jsi` pnpm patch and the `lightningcss` override ship
  with the repo and apply on EAS; the default build image provides
  Xcode 26.x.
- Universal links need the signed app's team id in the AASA the connect gate
  serves (`packages/connect-db/src/app-links.ts`) and a physical-device
  check against `https://<handle>.getbb.app/threads/…`. Android signing
  (`eas credentials -p android`, FCM V1, `ASSETLINKS_SHA256_FINGERPRINTS`)
  is still open.
- `eas update` (JS-only fixes over the air) is deferred: `expo-updates` is
  not installed, so the profiles define no update channels.

## TestFlight testers

**Internal testers** need no Apple review. A build reaches the group as soon as
App Store Connect finishes processing it, usually within 30 minutes. The group
`bb team` exists and the nightly feeds it.

**External testers** need a Beta App Review on the first build of each
marketing version, and Apple usually auto-approves later builds of that
version. The nightly keeps one marketing version for this reason (see "CI"
above). Apple offers "Automatically distribute builds" only for internal
groups, so the CI distribute step adds each submitted build to the external
group through the App Store Connect API. Before a build can go to an external
group, App Store Connect needs all of this:

- **Test Information** (`betaAppLocalizations`): a feedback email, a beta
  description, and the privacy policy URL <https://getbb.app/privacy>. Per
  build, a "What to test" note.
- **Beta App Review Details** (`betaAppReviewDetail`): contact first name, last
  name, phone, and email. Apple uses these, testers never see them.
- **A way for the reviewer to use the app.** This is the part that fails. bb
  opens on "Add server", and a reviewer has no bb server, so without help they
  cannot get past the first screen and will reject the build. Neither real
  path works for a reviewer: a bb server's API is unauthenticated and runs
  commands, so it cannot be on the internet, and connect pairing codes are
  single-use and expire in ten minutes. Give them the **demo server** instead:
  `apps/demo-server` is a Cloudflare Worker that answers the launch-path API
  from fixed data, runs nothing, and isolates each client address. Deploy it
  with `pnpm --filter @bb/demo-server deploy`, and rehearse the notes with
  `e2e/manual/demo-server.yaml` before every submission. Disclose it in the
  notes: a disclosed demo mode is sanctioned by guideline 2.1.

Review notes template — keep it literal, and assume the reviewer knows nothing
about coding agents:

```text
bb is a client for a bb server that a developer runs on their own computer.
The app has no accounts of its own, so we have prepared a demo server for
you. It serves sample conversations and scripted replies; it does not run a
real coding agent.

1. Open the app. It shows "Connect to a bb server".
2. Under "Direct URL", in "Server URL", enter: https://<DEMO-HOST>
3. Tap "Connect".
4. The app shows a list of conversations. Open any of them to read it.
5. Type a message and send it. The agent replies after a moment.

Write to <EMAIL> if the server does not respond.
```

Rehearse it before submitting: hand a colleague a phone that has never run bb,
give them only these notes, and check that they reach a thread.

The nightly keeps the marketing version in `app.json` and lets the EAS build
number tell nightlies apart, because a new version string triggers a fresh
Beta App Review and another build of the same version usually does not.

## Local state

- Server profiles: `expo-secure-store`, one key per profile
  (`bb.profile.<id>`) plus `bb.profiles.index`.
- Preferences (theme mode `bb.theme`, sidebar `bb.sidebar.*`, thread-creation
  picks `bb.promptbox.*` / `bb.root-compose.*`, composer drafts
  `bb.promptbox.contents-*` in the web's `PromptDraftState` JSON, all with the
  web app's key names): MMKV store `bb.preferences`. Push state shares it:
  `bb.push.enabled.<profileId>` (+ `bb.push.enabledProfiles` index),
  `bb.push.registration.<profileId>` (+ `bb.push.registrations` index: the
  token / server row the phone registered, so a removed profile can still be
  unregistered), `bb.push.prompted`.
- Each profile owns one SDK client, one realtime socket, and one TanStack
  QueryClient (`src/lib/sdk/client-registry.ts`, instantiated once by
  `src/app-shell/client-registry.ts`); the active profile's socket/session
  lifecycle lives in `src/lib/connection`.
- Failed mutations toast globally from the profile QueryClient's mutation
  cache (`meta.errorMessage` is the headline, the server/transport detail the
  description; `meta.showErrorToast: false` opts out for inline errors) —
  screens do not toast mutation errors themselves.

## Theme tokens

`src/theme/theme.native.ts` is generated from the web app's
`apps/app/src/components/ui/theme.css` plus the built-in palettes in
`apps/app/src/lib/themes/*.ts`: every color token per palette × light/dark as a
plain RN color string, with `nativeRadii` and the touch (`pointer: coarse`)
`nativeTypography` scale. Do not edit it by hand. After changing theme.css or a
palette, run `pnpm --filter @bb/mobile theme:generate` and commit the result;
`src/theme/generate-native-theme.test.ts` fails when the file is stale.

## Notes

- Workspace packages resolve from TypeScript source through `metro.config.js`
  (`source` export condition for `@bb/*` only, `./x.js` → `./x.ts`).
- Import `@bb/sdk/browser`, never `@bb/sdk` (lint-enforced).
- Never spread a `Headers` instance into a fetch init on React Native.
- File uploads (`POST /projects/:id/attachments`, `/system/voice-transcription`)
  go through `XMLHttpRequest` (`src/data/composer/multipart-upload.ts`): the
  SDK's Blob upload cannot run on RN and `expo/fetch` (the global fetch)
  rejects `{ uri, name, type }` form parts; RN's XHR streams them natively.
- `lightningcss` is pinned to 1.30.1 for `@expo/metro-config` (NativeWind v5).
- Type-scale line heights in `global.css` are unitless ratios
  (`calc(22 / 15)`), not px: react-native-css drops the unit inside Tailwind's
  `var(--tw-leading, …)` fallback and treats the number as an em multiplier.
- On a `ScrollView`, do not combine `contentContainerClassName` with an inline
  `contentContainerStyle`; the class styles are dropped. Use one or the other.
- FlashList v2 keeps the first visible row anchored when rows are inserted
  above it (`maintainVisibleContentPosition` is on by default); lists where
  new rows must appear at the top (sidebar, search, archived) pass
  `{ disabled: true }`.
- `Sheet` sets `accessible={false}` on the bottom-sheet container and
  `keyboardShouldPersistTaps="handled"` on its scroll body so rows are
  reachable by VoiceOver/Maestro and a tap lands while the keyboard is up.
- Maestro on iOS: `back` is not a thing; tap `id: BackButton`. The dev
  client's floating gear can sit over the header's right icons on larger
  simulators; Settings is reached through the header avatar on the left
  (`e2e/subflows/open-settings.yaml`).
