# bb Mobile — execution log

Running log for the autonomous build of `apps/mobile` (see
`plans/bb-mobile-expo.md` for the plan and decisions). Newest entry last.
Each phase entry records: what landed (commit), how it was verified, what is
carried forward.

## Status (2026-08-19, after the Phase 7 integration pass)

Phases 0–7 (M0–M4) are built and committed on the branch
`bb/build-expo-react-native-app-thr_qvau3b2d5b` (one commit per phase, plus
a merge of `origin/main`; last commit `7d1b9f30b`); M5 (Phase 8) is deferred. The plan's own "Status" block in
`plans/bb-mobile-expo.md` lists what shipped per milestone and what needs
Sawyer; this is the short version from the verifier's seat.

Works end to end on the iPhone 17 Pro simulator (iOS 26.3), every Maestro
flow in `apps/mobile/e2e/flows` PASS on one fresh harness backend (table in
the Phase 7 integration entry): first run → Add server (Direct URL or bb
connect pairing through the TLS stub, account servers, session re-mint,
re-pair), the drawer + home thread list with every long-press action,
search, archived, `/compose` with pickers / mentions / attachments, the
thread screen (timeline with every row kind, unread divider, table of
contents; send / queue / steer / stop; approvals, questions, plugin forms;
message / thread / git action sheets; fork / handoff; context banner), deep
links (`bb://threads/<id>`, the web alias, settings), the workspace panel
(Info / Diff with "Add to chat" / Files with previews / Terminal with the
accessory bar, full-screen file and terminal routes), and the Phase 7
settings: General / Appearance (palettes re-tint live) / Experiments /
Haptics, provider settings, usage limits, Machines (detail, rename,
permission ceiling picker, Add machine sheet), Updates, Plugins (list,
detail, settings form, logs, catalog, marketplaces — the detail / form / logs
against the checkout's dev server because the harness runs no plugin
service), Skills library + skills.sh registry, "Share link". Typecheck, lint
and 822 unit tests green for `@bb/mobile`; `@bb/app` / `@bb/server` /
`@bb/sdk` / `@bb/cli` / `@bb/integration-tests` typecheck green.

Needs the user: the Expo / EAS account + `eas init` + APNs key (push
registration stays disabled until then; push acceptance needs a physical
iPhone and a signed build), revoking the spike machines in the getbb.app
dashboard, the Android SDK for the Android milestone, review + merge (then
label a PR `mobile-e2e` / dispatch `Mobile E2E` and `Mobile Runner Probe`,
which cannot run from the branch), and the telemetry / crash-reporting
decision.

Known gaps: the connect-mode edge-swipe press-through (a left-edge swipe
that opens the drawer also presses the home row under the touch on a bb
connect profile; Direct profiles are fine — Phase 7 integration entry),
inbound "Send to bb" share needs the `expo-share-intent` native rebuild,
provider CLI install / remove machine / CLI skills install / PR banner
actions / secret-request form / voice have no harness fixture (unit tests +
synthetic showcases only), plugin frontends (nav panels, settings sections,
directives) stay web-only until M5, Android unverified, `onlineManager` /
NetInfo wiring and the native header font on iOS 26 still open, the
harness emits no realtime workspace events (Diff refresh is manual there),
and the Phase 7 flows are not in `ci-run-flows.sh` yet.

## Environment used for verification

- Simulator: iPhone 17 Pro `5E5752AC-914C-42D2-AF5D-6BABBE3436EA` (iOS 26.3).
- Dev-client build: `cd apps/mobile && pnpm ios` (rebuild only when native
  deps change; JS changes reload through Metro).
- Backend for e2e: `pnpm --filter @bb/integration-tests e2e:mobile-backend`
  (port 41999; fake provider with user questions).
- Metro: `cd apps/mobile && EXPO_PUBLIC_BB_SERVER_URL=http://127.0.0.1:41999 EXPO_PUBLIC_BB_E2E=1 pnpm dev --port 8082`
  (`EXPO_PUBLIC_BB_E2E=1` wipes profiles/preferences on every launch so flows
  start at first run; drop it for manual QA).
- Flows: `cd apps/mobile && pnpm e2e:ios` (Maestro; needs `JAVA_HOME`).
- Checks: `pnpm exec turbo run typecheck lint test --filter=@bb/mobile`.

## Phase 0 — toolchain + spikes (done 2026-08-18)

Commits `7683fc218`, `ad1ffd193`. See "Phase 0 results" in the plan.
Carried forward: fake-adapter `approve:<kind>` token; e2e reset entry;
Expo/EAS account; Android.

## Phase 1 — foundation: profiles, realtime, theme, shell (done 2026-08-18)

Built by three parallel agents (data layer, design system, shell) plus an
integration pass; commit(s) to follow this entry.

What landed:

- **Data + connectivity layer** (`apps/mobile/src/lib/**`, pure TS, vitest):
  `profiles/` (SecureStore-backed `ServerProfile` store, Direct URL
  validation with the non-loopback http warning, `/health` +
  `/system/config` probe that never adopts the server-reported URL),
  `sdk/` (`createMobileSdk` on `@bb/sdk/browser` + `x-bb-app-surface:
mobile`, per-profile client registry), `realtime/` (WebSocketManager-shaped
  manager on RN WebSocket: refcounted subscriptions, backoff 1s×1.5→30s,
  handshake timeout, `suspend`/`resume` bound to AppState), `query/`
  (query keys mirroring the web app, per-profile QueryClient, AppState →
  focusManager, realtime → invalidation bridge with debounce and a full
  invalidate on reconnect), `session/` (connect desktop-session cookie
  scheduler for Phase 5), `connection/` (active-profile connector: one
  socket/session for the live profile; banner derivation), `e2e/` (reset
  logic), `native/` (RN adapters). `@tanstack/react-query` added.
- **Design system** (`src/theme`, `src/ui`, `global.css`): NativeWind v5
  variables per palette × mode from the generated tokens, Inter + Fira Code,
  hugeicons `Icon` with the shared-ui `ICON_MAP` names, primitives (Text,
  Button, Badge, Pill, Input, TextArea, Switch, Skeleton, Spinner,
  EmptyState, ListRow, Separator, Sheet/ActionSheet on @gorhom/bottom-sheet
  with deferred realization, sonner-native Toaster), `UiProvider`,
  `/dev/ui` gallery. Deps: `@expo-google-fonts/inter`,
  `@expo-google-fonts/fira-code`, `class-variance-authority`, `clsx`,
  `tailwind-merge`, `sonner-native`.
- **App shell** (`app/**`, `src/app-shell`, `src/screens`): root layout
  provider stack (gesture root › safe area › keyboard › palette › theme ›
  profiles/QueryClient › sheets › stack + toaster), Expo Router Stack with an
  `expo-router/drawer` home (server switcher + settings link), routes
  `settings`, `settings/servers`, `settings/servers/add`, `dev/ui`,
  `dev/spike`, `dev/connect-spike` (Phase 0 spikes moved, reachable from
  Settings → Developer), `e2e/reset`, `+not-found`, root `ErrorBoundary`.
  First run redirects to Add server; home shows the server-info card
  (`/system/config`, `/system/version`, realtime state, dev "Poke");
  persistent connection banner (connecting / reconnecting / connect auth
  states) under every screen header; palette follows the server's
  `appearance.themeId`. E2E reset: `EXPO_PUBLIC_BB_E2E=1` wipes local state
  on launch; `bb://e2e/reset` in dev/e2e builds.

How verified:

- `pnpm exec turbo run typecheck lint test --filter=@bb/mobile`: green
  (17 test files, 124 tests, 0 lint warnings).
- Maestro on iPhone 17 Pro (iOS 26.3) against the harness backend on
  `127.0.0.1:41999` with Metro on 8082 + `EXPO_PUBLIC_BB_E2E=1`:
  `e2e/flows/phase1-shell.yaml` passes (first run → real Add-server screen
  → home shows the profile, URL, primary host, `connected` realtime, no
  banner → Poke toast → drawer → Settings → Servers list), and
  `e2e/flows/smoke.yaml` (now deep-links to `/dev/spike`) still passes.
- Manual on the simulator: killing the backend shows the "Connection to
  E2E backend lost. Reconnecting…" banner and `reconnecting`; restarting it
  clears the banner and the card refetches (new primary host id) through
  the reconnect invalidation. Drawer, Settings, Servers screens eyeballed
  (screenshots in the run notes).

Bugs found on device during integration (fixed):

- Type-scale line heights: `--text-sm--line-height: 22px` in `global.css`
  became `lineHeight: 22 × fontSize` at runtime (react-native-css drops the
  unit inside Tailwind's `var(--tw-leading, …)` fallback and treats the
  number as an em multiplier) — every text box was ~300pt tall. Now unitless
  ratios (`calc(22 / 15)`); `theme-vars.test.ts` guards the ratio.
- `ScrollView contentContainerClassName` is dropped when an inline
  `contentContainerStyle` is also passed; screens use inline styles.

Carried forward:

- `systemVersionQueryKey` lives in `src/app-shell/queries.ts`; move it next
  to the other keys in `src/lib/query/query-keys.ts` when that file is next
  touched.
- No `onlineManager`/NetInfo wiring (TanStack assumes online); the
  reconnecting banner is driven by the socket only.
- Connect mode (Phase 5) has the session scheduler + connector wiring but no
  enrollment UI; `auth-required` currently only shows a banner.
- Native header titles look like the system font rather than Inter on iOS
  26 even with `headerTitleStyle.fontFamily` set — cosmetic, unverified
  whether the stack header honors custom families here.
- Still open from Phase 0: fake-adapter `approve:<kind>` token, Expo/EAS
  account, Android.

## Phase 1 — foundation (done 2026-08-18)

Commit `95544ab6e`. See the entry the integrator wrote above this line if
present; summary: profiles (SecureStore), Direct add-server flow with probe
and warnings, per-profile SDK + realtime manager (AppState aware) +
QueryClient with realtime invalidation, connect session scheduler,
ThemeProvider over generated tokens + NativeWind vars, fonts/icons,
primitives, Expo Router drawer/stack shell, connection banner, e2e reset.
Verified: turbo typecheck/lint/test green (125 tests); Maestro
`phase1-shell.yaml` + `smoke.yaml` pass on the simulator; reconnect banner
verified by killing/restarting the backend.

## Phase 2 — client-core hybrid + fake approvals (done 2026-08-19)

- `packages/client-core` (`@bb/client-core`): DOM/React-free package holding
  the pure modules extracted from `apps/app` (thread read state, sidebar
  grouping/sorting/pinned, prompt draft + submission policy + mention
  triggers, timeline helpers incl. merge/paging, renderable-patch rules,
  terminal WebSocket transport (tolerates RN's undefined `bufferedAmount`),
  fixed-panel tab schemas, secondary panel tab state, file preview, localhost
  link rewrite, route path builders). Old `apps/app` paths re-export; 19 web
  tests moved with their modules; a `no-dom` guard test walks `src/**`.
  Deviation: depends on `@bb/desktop-contract` (pure) for two length limits.
- Fake provider: `approve:<kind>` control token (command | file_change |
  permission_grant | plan) emits an approval interactive request; adapter
  decodes/encodes approval payloads; 5 runtime tests; integration smoke
  green. Enables the approval-banner e2e in Phase 4b.
- Verified independently: typecheck/lint/test green for client-core, app
  (2690 tests), mobile, agent-runtime, integration smoke; prettier clean.

## Phase 3 — sidebar, thread list, thread creation (done 2026-08-19)

Built by three parallel agents (data layer, sidebar/list screens,
creation/project screens) plus an integration pass; nothing committed yet at
the time of this entry.

What landed:

- **Data layer** (`apps/mobile/src/data/**`, one folder per area with an
  `index.ts` barrel; see `src/data/README.md`): `sidebar/` (bootstrap query
  on the new `sdk.projects.sidebarBootstrap()`, `buildSidebarModel` over the
  client-core grouping/sorting/pinned helpers for project / machine / manual
  organize modes, MMKV-backed organize/sort/collapsed preferences under the
  web's `bb.sidebar.*` keys, debounced thread search, recent threads),
  `threads/` (detail + list + archived infinite queries, optimistic
  rename/move/pin/unpin/archive-all/unarchive/delete/read-state transactions
  with rollback across every cached list and the sidebar, `useCreateThread`,
  read tracking), `projects/`, `sections/`, `hosts/` (directory listing,
  clone default path, path existence, join code), `system/` (config,
  version, providers, execution options; `@/app-shell/queries` re-exports
  the Phase 1 names), `compose/` (pure, tested: create-thread request
  builder validated against `createThreadRequestSchema`, typed
  `ThreadEnvironmentSelection`, model/reasoning/permission option
  derivation, MMKV thread-creation preferences under `bb.promptbox.*` /
  `bb.root-compose.*`). Query keys extended in
  `src/lib/query/query-keys.ts` and every new key mapped in
  `realtime-invalidation.ts`. Realtime subscriptions are refcounted per
  target through `data/shared/use-realtime-subscription.ts`.
- **Sidebar / list UI** (`src/screens/sidebar`, `threads`, `shell`): the
  drawer is the bb sidebar (server switcher → ActionSheet, New thread /
  Search rows, grouped FlashList of pinned + project/machine/section groups
  with collapsible headers, thread rows with the client-core status glyph +
  relative time + project subtitle, environment rows, Settings + display
  options footer); home is the same list full width with pull-to-refresh,
  skeleton / error / empty states, search + display-options header buttons
  and a New-thread FAB. One bottom sheet per list (`SidebarActionsProvider`)
  drives every long-press flow as a state machine: thread (open, mark
  read/unread, pin/unpin, rename, move to section + new section, archive
  with Undo toast / unarchive, delete with child-summary confirmation),
  project (new thread, settings, rename, add local path, remove), section
  (new thread here, rename, delete), organize + sort + new section. Screens:
  `/threads/[id]` placeholder (title + status pills, marks read),
  `/threads/search` (debounced results incl. archived group + snippets,
  recent threads when empty), `/settings/archived` (paginated, project
  filter, unarchive), `/settings/server` (the Phase 1 server-info card),
  `/projects/[id]/threads/[threadId]` (web deep-link alias → `/threads/[id]`).
  `src/screens/shell/hrefs.ts` is the single typed-route boundary.
- **Creation / project UI** (`src/screens/compose`, `pickers`, `projects`):
  `/compose?projectId=&sectionId=&initialPrompt=&reuseEnvironmentId=` with an
  optional title, a plain multiline prompt (`ComposePromptInput`, the swap
  target for the Phase 4b composer), two horizontally scrolling pill rows
  (project / provider / model+reasoning(+Fast) / permissions; environment /
  machine / branch / folder), an "Open after creating" switch and Create;
  `useComposeController` mirrors the web NewThreadComposer +
  useThreadCreationOptions (stored prefs win over project defaults,
  model/permission resolved against the routed `useSystemExecutionOptions`
  catalog, permission ceiling, reuse options, branches with worktree →
  checkout demotion, unmanaged path through the remote path browser).
  Reusable picker sheets in `src/screens/pickers` (project, provider,
  model+reasoning, permission mode, environment, machine, branch, folder,
  remote path browser). `/projects/new` (machine + folder → `POST
/projects` → compose) and `/projects/[id]/settings` (rename, sources
  add/remove via the clone-or-folder machine setup sheet, delete).
- **Integration pass**: wired the global mutation-error toast the data
  layer's `meta.errorMessage` was written for (`src/app-shell/client-registry.ts`
  builds every profile QueryClient with `onMutationError`;
  `src/lib/query/mutation-errors.ts` derives headline + description and
  recognizes expo/fetch's "fetch failed: … Could not connect to the server"
  as a transport failure, which also lets read queries retry it); removed
  the screens' duplicate explicit error toasts; exported the compose/project
  screens from `@/screens`; un-ignored `apps/mobile/src/data/` in
  `.prettierignore` (the repo-wide `data/` ignore had hidden 18 unformatted
  files) and formatted them.
- `@bb/sdk`: `sdk.projects.sidebarBootstrap()` (typed
  `GET /projects/sidebar-bootstrap`).

How verified:

- `pnpm exec turbo run typecheck lint test --filter=@bb/mobile
--filter=@bb/client-core --filter=@bb/sdk`: green (mobile 32 test files /
  204 tests, 0 lint warnings; client-core 232; sdk 93). `@bb/app` typecheck
  green. Prettier clean on every touched file.
- Maestro on iPhone 17 Pro (iOS 26.3) against a fresh harness backend on
  `127.0.0.1:41999` + Metro on 8082 with `EXPO_PUBLIC_BB_E2E=1`: all four
  flows pass end to end — `phase1-shell.yaml`, `smoke.yaml`,
  `phase3-threads.yaml` (add server → home lists the seeded project + 2
  threads → rename → pin (Pinned section) → archive (undo toast) → drawer →
  Settings → Archived → unarchive → back on home → search "Compl"),
  `phase3-compose.yaml` (compose → project picker → environment sheet →
  model sheet → prompt → Create → thread placeholder shows "hello from
  mobile" → New project host picker + remote path browser).
- Ad-hoc on device: project settings via the sidebar long-press menu, the
  `/projects/:id/threads/:threadId` alias opens the thread placeholder,
  and with the backend stopped a rename shows "Failed to rename thread —
  Could not reach the server…" and the row rolls back to its old title.
  Screenshots in `/tmp/phase3-integration-screens/` (home, drawer, pinned,
  archived, search, compose + model picker + environment picker, created
  thread, project settings, new-project host/browser, error toast).
- Data layer smoke script `apps/mobile/scripts/data-smoke.mts` (creates and
  deletes a thread/section on the target server) was run by the data agent
  against the harness.

Carried forward:

- Thread creation is plain text only (`input: [{type: "text", …}]`);
  attachments/mentions/fork/handoff seeds arrive with the shared composer in
  Phase 4b, which replaces `ComposePromptInput` behind the same props.
- Thread detail is a placeholder (`ThreadDetailPlaceholderScreen`); the
  drawer is only reachable from home because thread detail is a stack
  screen — Phase 4 decides whether thread screens live inside the drawer
  navigator.
- `getThreadDisplayTitle` is duplicated from `apps/app/src/lib/thread-title.ts`
  in `src/data/threads/thread-title.ts`; move it into `@bb/client-core` when
  that package is next extended.
- No create-project-by-clone API (POST /projects accepts a local_path source
  only, as on the web), so `/projects/new` is folder-only; cloning is offered
  when adding a source to an existing project. The machine-setup sheet and
  the compose machine picker could not be exercised on the single-host
  harness (type-checked, mirrors the web dialog).
- A presented bottom sheet survives navigation to another screen (global
  modal; nothing dismisses it on blur) — Sheet/design-system follow-up.
- Sidebar organize mode is typed `"project" | "machine" | "manual"` (the
  web's stored `"chronological"` parses to `"manual"` on read).
- `hrefs.ts` carries one documented `as Href` cast (Expo typed routes are
  generated into the gitignored `.expo/types` and absent in CI).
- Maestro on iOS: `back` does not exist (tap `id: BackButton`); the dev
  client's floating gear covers header-right icons on larger simulators, so
  flows go through drawer rows; flows cold-start (`stopApp`) because a warm
  reload keeps the last deep link; two concurrent Maestro sessions on one
  simulator kill the XCUITest driver (it also died once mid-run on its own —
  rerun); the flow-file `SERVER_URL` cannot be overridden with `-e`
  (flow env wins in Maestro 2.8) — sed the port into a temp copy for a
  private backend (`BB_MOBILE_E2E_PORT=42999 … e2e:mobile-backend`).
- Still open from earlier phases: `onlineManager`/NetInfo wiring, connect
  enrollment UI (Phase 5), native header font on iOS 26, Expo/EAS account,
  Android.

## Phase 4a — thread detail, read-only (done 2026-08-19) → M1 dogfood

Built by five parallel agents (timeline data + list skeleton, markdown
renderer, diff + terminal output, conversation/structure renderers, work-row
renderers) plus an independent verification + integration pass; nothing
committed at the time of this entry.

What landed:

- **Data** (`src/data/thread-detail/`): `useThreadDetailBootstrap`
  (`GET /threads/:id?include=environment,host`, seeds the thread/environment/
  host caches, prefetches the timeline in parallel), `useThreadTimeline`
  (`afterSequence` delta merge through `fetchThreadTimelineWindow` +
  `applyTimelineDelta`), `useThreadTimelineController` (port of the web
  controller on the `@bb/client-core` merge/paging helpers: latest window +
  older pages via `beforeAnchorId/Seq`, stale-cursor recovery on 400),
  `useThreadPendingInteractions`, `useThreadQueuedMessages`,
  `useTimelineTurnSummaryDetails`, `useChildThreads` + `useChildThreadSummary`,
  sender-thread metadata store (`useSenderThreadMetadataById`) and the
  attachment / host-file content URL builders. All subscribe `thread-detail`
  through the refcounted shared hook (released on unmount; the socket suspends
  in the background). Realtime bridge: `timeline-refetch-pacing.ts` ports the
  web `events-appended` pacing (invalidate without cancelling the in-flight
  read, one trailing refetch paced by the observed duration; `turn/completed`
  cancels + refetches at once).
- **Timeline list** (`src/screens/thread/timeline/`): `rows.ts` projects
  `TimelineRow[]` through `@bb/thread-view` (`buildTimelineViewRows`,
  `buildTimelineRowTitle`) onto a flat `TimelineListItem[]` — per-kind
  discriminator, narrowed `row`, `title`, `depth`, `parentKey`/`parentKind`,
  `scopeActive`, `expandable`, `expanded`, lazy turn-children state — with
  container children (turn, step/bundle summary, delegation) flattened one
  depth down, and an item identity cache so unchanged rows keep their object
  (the FlashList cells are `memo`ized on it and keyed by item key so local
  row state never leaks through FlashList recycling). `renderers.ts` is the
  per-kind renderer registry (`registerTimelineRowRenderer`, fallback raw-row
  renderer; `renderers/index.ts` registers every kind once at import and warns
  in dev if one is missing). `TimelineList` (FlashList: stable keys,
  `getItemType` by kind, `initialScrollIndex` / start-from-bottom decided once
  at mount, sticky-bottom reducer driven only by user drags, Jump-to-latest,
  `onStartReached` older paging with retry + short-page re-paging, unread
  "New" divider, working-indicator footer with thinking disclosure + active
  workflow titles). Pure, tested policies: `sticky-bottom.ts`,
  `unread-divider.ts`, `list-entries.ts`.
- **Row renderers** (`renderers/`): conversation (authored bubble with
  mention pills, attachments, steer label, 15-line clamp + Show more;
  generated "Message from / Forked from / Replying to" rows with the tappable
  source-thread chip; assistant markdown with `@thread:` pills, host-file
  images → lightbox, long-press → Copy text), system (operation icon, detail
  card), turn (recap header, lazy children), step/bundle summaries, and every
  `work:<kind>`: command (ANSI terminal card collapsed to its tail), tool
  (args clamp + output cap), file-change (native diff card via client-core's
  renderable-patch rules + stderr), web-search/fetch (fetch opens the URL),
  image-view (host-file image → lightbox), approval (read-only, decision
  glyph), question (answers when resolved), delegation (result markdown,
  children flattened), workflow (phase strip + phase tree). Shared chrome:
  `TimelineRowShell` + `ExpandableRowHeader` (`WorkRowShell` composes them),
  past-row dim (`opacity 0.4`, web `PAST_ROW_DIM_CLASS_NAME`), compact
  activity intents inside step/bundle summaries. `TimelineRowHostProvider`
  supplies server URL, workspace root, sender metadata, thread navigation,
  the single `ImageLightbox` (pinch/pan/double-tap/swipe) and the long-press
  action sheet.
- **Markdown** (`src/markdown/`): unified + remark (gfm, breaks, math,
  directive) with the web's prompt/thread mention transforms, directive
  normalization and link classification (local file path[:line], external,
  localhost rewrite), sugar-high code spans; `<Markdown>` (per-block memo by
  source slice so streaming re-renders only the tail), `<MarkdownText>`,
  CodeBlock (copy), MarkdownTable, MarkdownImage (expo-image), MentionPill;
  `markdownToPlainText`, `extractMarkdownHeadings`. Inter italic faces added.
- **Diff + ANSI** (`src/diff/`, `src/ansi/`): `parseUnifiedDiff` (parse-git-diff
  wrapped in our own tolerant types), `buildFileChangeDiffView`, `DiffHunkView`
  (pinned gutter, horizontal scroll, "Show N more lines"), `DiffFileCard`,
  `FileChangeDiffBlock`; own SGR parser (`ansiToSpans`, 256/truecolor →
  16-color theme palette), `AnsiText`, `TerminalOutputBlock`.
- **Screen** (`src/screens/thread/`): `/threads/[id]` = `ThreadDetailScreen`:
  read-only header (title, runtime status pill from client-core + pending
  input, project · host · worktree · branch, child-thread pill, Contents
  button on the pill row because the dev-client gear covers the header's
  top-right), the list, read-only prompt-stack cards (plan mode, goal, todos,
  model fallback), context-window readout, composer placeholder, table of
  contents sheet (user messages → scrollToRow), loading / error / not-found /
  empty states, read tracking only while focused and foregrounded. Dev
  showcases under Settings → Developer: `/dev/markdown`, `/dev/diff`,
  `/dev/work-rows` (synthetic rows through the real list model).
- **e2e**: the harness seed adds "Rich thread" (plain, `delay:300`,
  `call_tool`, `approve:command` answered `allow_once`, a 60+ line markdown
  message, pending `ask_user` last; marked unread at the end so the divider
  flow holds on a fresh backend) and "Rows thread" (started on behalf of
  "Idle thread", originKind fork); prints `threads.rich` / `threads.rows`.
  Flows: `phase4a-timeline.yaml`, `phase4a-conversation-rows.yaml`,
  `phase4a-work-rows.yaml`, `phase4a-diff-showcase.yaml`; shared subflow
  `e2e/subflows/launch-to-home.yaml`.

How verified (integration pass, fresh harness backend + Metro 8082 with
`EXPO_PUBLIC_BB_E2E=1`, iPhone 17 Pro iOS 26.3):

- `pnpm exec turbo run typecheck lint test --filter=@bb/mobile
--filter=@bb/integration-tests`: green (mobile 57 test files / 365 tests,
  0 lint warnings; integration 25 files / 55 tests). Prettier clean on every
  changed file.
- Maestro, all passing on one fresh backend: `phase4a-timeline.yaml` (add
  server → Rich thread opens at the unread divider → scroll to the long
  message → Contents → jump back), `phase3-threads.yaml`, `phase3-compose.yaml`,
  `phase1-shell.yaml`, `smoke.yaml`, `phase4a-work-rows.yaml`,
  `phase4a-diff-showcase.yaml`, `phase4a-conversation-rows.yaml` (after
  restoring the "Idle thread" title that `phase3-threads` renames — the two
  flows share seed threads and must run conversation-rows first or on a
  fresh backend).
- Ad-hoc on device: Rich thread top (divider + bubbles + assistant prose),
  expanded "Worked for" turn → expanded command card, bottom with the
  read-only pending question row and "Needs input" pill, table of contents →
  jump to message 4; new thread from compose with `delay:4000 stream test`:
  "Working" pill + "Working…" indicator + provisioning system row while the
  turn runs, then "Idle" + the response, list following the bottom; dev
  routes `/dev/markdown`, `/dev/diff`, `/dev/work-rows` (tool card with
  args Show less + output cap, compact intents, file-change diff, approvals /
  answered question, delegation, running + failed workflows).
  Screenshots in `/tmp/p4a-shots/`.

Integration fixes on top of the five agents' work:

- FlashList cells are memoized (`TimelineRowCell`) on a stable item identity
  (`createTimelineListItemCache`) and a stable `toggleRow`; `expanded` moved
  onto the item; `extraData` dropped; cells keyed by item key so recycled
  cells never show another row's terminal/diff/image state.
- `WorkRowShell` now composes the shared `TimelineRowShell` +
  `ExpandableRowHeader` (extended with `onPress`, `trailing`,
  `accessibilityLabel`) instead of duplicating the header; the duplicate
  `PAST_WORK_ROW_OPACITY` is gone.
- Compact activity intents key off `item.parentKind` (new on every item)
  instead of sniffing thread-view's `:work-summary:` id marker in the key.
- `renderers/index.ts` warns in dev when a kind has no renderer
  (`TIMELINE_ROW_KINDS`).
- Seed marks "Rich thread" unread (sending through the API had marked it
  read, so `phase4a-timeline.yaml` only passed after a manual `POST
/threads/:id/unread`).

M1 dogfood readiness (Direct mode): a user can add a server profile, browse
the grouped thread list (pin/rename/archive/search), create a thread from
compose, and open any thread to read its full timeline live — every row kind,
markdown, diffs, terminal output, images, the unread divider, paging into
older history, the table of contents, the status pill and cards — with
realtime updates while a turn streams. Not yet: replying/approving (Phase 4b
composer + interactions), bb connect / push (Phase 5), the workspace panel
(Phase 6).

Carried forward:

- Known server/seed quirks seen through the mobile UI (not mobile bugs): the
  fake adapter never completes an approved `approve:command` row, so the Rich
  thread's command stays "Waiting for approval" inside a completed turn; after
  marking read, `latestAttentionAt` can sit a few ms before the final agent
  row's `createdAt`, so a re-open can place the "New" divider above the last
  agent message; a response arriving while the thread is open shows the
  divider above it (same as the web's re-snapshot rule).
- Long multi-line RN Text inside a FlashList cell occasionally clips its last
  line on iOS (seen once on the 70-line assistant echo) — watch for it in the
  markdown/conversation renderers.
- Delegation rows carry no child thread id in the wire contract, so there is
  no tap-to-open-child; bb child threads surface as system/conversation rows.
  The delegation's result markdown renders above its flattened children (the
  web shows children first).
- The generated row's collapsed preview uses a 40-char heuristic for
  expandability (RN has no truncation signal for a clamped `MarkdownText`);
  the tool card's Show more is a pure line estimate.
- Inline mention pills/links inside a paragraph are not separate
  accessibility elements on iOS (RN Text aggregates), so Maestro must tap them
  by point; row-level testIDs cover the flows.
- The dev showcases `/dev/work-rows` and the thread row host need an active
  profile (`useProfileClient()`); the showcase shows "Add a server first."
  without one. A `bb://` deep link reloads the dev client and, under
  `EXPO_PUBLIC_BB_E2E=1`, wipes the profile — flows go through the drawer.
- Summary/turn/delegation view rows are re-projected by `@bb/thread-view` on
  every rows-array change (its cache is keyed by array identity), so their
  cells re-render during streaming; leaf rows keep identity. Cheap headers;
  revisit only if profiling says so.
- KaTeX/Mermaid render as source; image sources needing headers go through
  `resolveImageSource`; local file links are inert until the Phase 6 file
  preview; the lightbox could not be exercised against seeded data (the fake
  provider emits no image rows) — verified by the row agents on fixtures.
- Maestro: flows that share seed threads are order-sensitive
  (`phase3-threads` renames "Idle thread", which `phase4a-conversation-rows`
  looks up); `takeScreenshot` paths must stay inside the run folder.
- Still open from earlier phases: `onlineManager`/NetInfo wiring, connect
  enrollment UI (Phase 5), native header font on iOS 26, Expo/EAS account,
  Android, `getThreadDisplayTitle` duplication, `systemVersionQueryKey`
  location.

## Phase 4b — act: composer, interactions, queue, banner, actions (done 2026-08-19) → M2

Built by three parallel agents (shared composer; interactions + runtime +
queue; context banner + message/header/thread actions + fork/handoff) plus an
integration pass that wired the thread screen and the compose screen onto
their work; nothing committed at the time of this entry.

What landed:

- **Composer** (`src/composer/`, `src/data/composer/`): one native composer
  for root compose and follow-ups — `ComposerValue` (display text + mention
  ranges) over a styled `TextInput`, `@` / `#` / `/` typeahead (threads,
  projects, sections, paths via environment / thread storage, plugin mention
  providers, provider commands + skills), pills removed whole, serialization
  identical to the web (`composerValueToPromptInput` → client-core
  `promptDraftToInput`; drafts stored as web `PromptDraftState` JSON under
  the web's MMKV keys, debounced, flushed on background/unmount),
  attachments (photo library / camera / document picker → XHR multipart to
  `POST /projects/:id/attachments`, thumbnails, size limits), voice
  (`expo-audio` + keep-awake → `POST /system/voice-transcription`, shown only
  when the server enables it), the "+" actions menu (attach rows, provider
  composer actions, automation/plugin prompts, screen-supplied rows),
  `ExecutionControls` pills over the Phase 3 pickers, a submit button driven
  by `resolveSubmitAffordance` (ready / queue + long-press steer / stop-only
  / blocked), and `ComposerHandle` (focus / insertText). Dev route
  `/dev/composer`.
- **Interactions** (`src/data/interactions/`, `src/screens/thread/interactions/`):
  `PendingInteractionBanner` for approvals (Allow once / for session / Deny,
  plan approvals), native user questions (`QuestionForm`: tabs, single/multi
  select, Other…, Back/Next/Submit, Cancel = stop), plugin forms for
  `ask-user-question` and `secret-request` through the new shared
  `@bb/plugin-interaction-contracts` package (both plugins re-export their
  contracts from it), an "open on desktop" card with Cancel for any other
  renderer; child-thread pending rows (`ChildThreadPendingInteractions`,
  `useChildThreadPendingInteractions`). Mutations write the returned
  interaction into the pending list then invalidate. Haptics on
  approve/submit/deny/resolve.
- **Runtime + queue** (`src/data/thread-runtime/`, `src/screens/thread/queue/`):
  port of the web thread-runtime cache owner (optimistic user row / queued
  message, rollbacks, realtime-aware success invalidation, stop flips the
  thread to stopping + the client-only "Stop requested" row, plan-cancel /
  goal-clear authoritative writes, queued create/update/send-now/delete/
  reorder/group-boundary transactions), `useSendThreadMessage`,
  `useEditThreadMessage`, `useStopThread`, `useCancelThreadPlan`,
  `useClearThreadGoal`, the queued-message CRUD hooks,
  `useThreadDefaultExecutionOptions` (invalidated after an accepted send, a
  history rewrite, and realtime `environment-changed` / `history-rewritten`);
  `QueuedMessagesList` (Send now, Edit → the composer's edit mode, "…" →
  Move up/down, group toggle, Delete, dashed lead-group divider, inline
  error). Dev route `/dev/interactions` (synthetic variants + a live thread).
- **Context banner + actions** (`src/data/environments/`,
  `src/screens/thread/banner/`, `src/screens/thread/actions/`): environment
  record / status / PR / merge-base queries with realtime mapping,
  `useEnvironmentAction` (commit, PR ready/draft/merge with
  loading → success / 409 blocked / error toasts), `ThreadContextBanner`
  (children card; parent / fork / side-chat row; PR row with status pill,
  Mark ready, Merge sheet; changed-files row → `WorkspaceChangesList` +
  merge-base picker; archived → Unarchive; environment gone),
  `MessageActionSheet` (Copy text, Quote paragraph on a long-pressed block,
  Add to chat, Edit message behind the experiment, Fork from here, Send to
  main thread), `ThreadActionsSheet` (Handoff, New thread in this worktree,
  Rename, Pin, read state, Move to section, Copy link, Open in web, Archive
  with undo, Delete), `ThreadGitActionSheet` (branch, status, changed files,
  Commit), `ThreadDetailHeader` now owns
  title-tap rename, the "…" button and the git button. Compose seeds:
  `buildForkComposeParams` / `buildHandoffComposeParams` /
  `buildNewThreadInWorktreeComposeParams` + readers; `useComposeController`
  seeds the handoff draft and submits forks through client-core
  `buildForkThreadRequest`.
- **Thread screen integration** (`src/screens/thread/prompt-area/`,
  `ThreadDetailScreen.tsx`): `ThreadPromptArea` replaces the Phase 4a
  placeholder and mirrors the web ThreadDetailPromptArea order — when the
  thread has a pending interaction: child rows + plan / goal cards + the
  banner instead of the composer; otherwise the prompt stack (child rows,
  `ThreadWorkflowCard` per running workflow with the phase strip,
  `ThreadBackgroundCommandsCard`, plan card with Exit, goal card with Clear,
  to-dos, the context banner, model fallback, `QueuedMessagesList`) in a
  scroll area capped at 60% of the window above the follow-up `Composer`
  (execution pills from `useThreadExecutionOptions`: the thread's resolved
  defaults seed model / reasoning / permission / Fast mode; picks ride with
  the next message as overrides with `component-local` attribution, a model
  fallback shows until overridden; context-window readout; "+" → Handoff).
  `useFollowUpComposer` owns the per-thread draft, `buildFollowUpSubmitMode`
  (ready / queue / stop-only / blocked with reason), tap = `queue-if-active`
  send or queued-message create while busy, long-press = steer (swapped by
  the `steerActiveThreadOnEnter` setting; an empty steer sends the queue
  head), stop, queued-message edit mode and sent-message edit mode (header
  with Cancel; the session is dropped with a toast if the target vanishes;
  the edit experiment gating mirrors web `canEditSentMessages`), "Add to
  chat" quoting, and the queue list's disabled states. Archived threads and
  gone environments keep the stack but hide the composer. The screen wraps
  list + prompt area in the new `KeyboardPaddingView` (`src/ui/`): bottom
  padding from plain React state on iOS `keyboardWillChangeFrame` /
  `keyboardWillHide`, animated with the keyboard's curve, so the list shrinks
  and stays anchored; the compose screen and the composer showcase use it
  too. It replaced react-native-keyboard-controller's `KeyboardAvoidingView`
  after that one (and a shared-value-driven padding) was reproducibly left
  with a keyboard-sized gap and no keyboard once a sheet's text input closed
  while another sheet opened (git sheet → rename → "…" → Copy link): the
  keyboard-controller events and shared values did reach zero, but the
  final Reanimated style update never landed on the view. The screen also
  appends the pending stop row while `status === "stopping"`, passes quote /
  edit into the message action handlers, and scrolls to the end after a
  submission. The compose screen runs on the shared composer (mentions,
  attachments, voice, fork / handoff seeds) through `useComposeController`.
- Pure, tested policy (`prompt-area/follow-up-submission.ts`):
  `resolveFollowUpSubmitIntent`, `buildFollowUpSubmission`,
  `buildFollowUpExecutionInputSources`, `followUpPlaceholder`,
  `canEditSentMessages`.
- **e2e**: `phase4b-send.yaml`, `phase4b-ask-user.yaml`,
  `phase4b-approve.yaml` (allow once, then deny), `phase4b-queue.yaml`,
  `phase4b-actions.yaml` (each opens a thread titled "P4b <flow>" that must
  exist on the backend — create it through the API first; Maestro ignores
  `-e` overrides for keys a flow's `env:` block defines), plus the agents'
  `phase4b-composer.yaml`, `phase4b-interactions.yaml`,
  `phase4b-approval.yaml` (`-e THREAD_ID=`), `phase4b-thread-actions.yaml`.

How verified (integration pass, shared harness backend on 41999 + Metro 8082
with `EXPO_PUBLIC_BB_E2E=1`, iPhone 17 Pro iOS 26.3):

- `pnpm exec turbo run typecheck lint test --filter=@bb/mobile`: green (81
  test files / 518 tests, 0 lint warnings); prettier clean on touched files.
- Maestro, all PASS on own threads created through the API:
  `phase4b-send.yaml` (type hello → optimistic row → "Response to: hello" →
  draft cleared), `phase4b-ask-user.yaml` (question banner replaces the
  composer → Staging → Submit → composer back, "Question answered: …"),
  `phase4b-approve.yaml` (approval banner with `$ echo hi` → Allow once →
  "Response to: approve:command echo hi"; again → Deny → "Denied"),
  `phase4b-queue.yaml` (`delay:30000 first` → Stop + queue affordances →
  "second" queued → list row → Send now → steered user row in the timeline →
  the turn finishes), `phase4b-actions.yaml` (environment line, "…" → Rename,
  long-press → Copy text "Copied", Add to chat quotes "> Reply with exactly
  READY…" into the composer). Regression after the integration:
  `phase4b-thread-actions.yaml`, `phase3-compose.yaml`,
  `phase4a-timeline.yaml` (its last step now asserts `thread-prompt-area`
  instead of the removed composer placeholder; the Rich thread must be
  marked unread again between runs) all PASS.
- Ad-hoc: Fast mode toggled in the model pill → next send carried
  `serviceTier: fast` (the thread's default-execution-options flipped to
  fast; the fake adapter then rejected the turn with "Provider fake does not
  support service tiers" although it advertises the capability — harness
  inconsistency, not mobile); queued-message Edit → "Editing queued message"
  header → Save → "second edited" in the queue → delivered as its own turn
  once the first finished; Stop from the composer → "Stopped manually" row,
  Idle, composer ready. Screenshots in `/tmp/p4b-shots/`.
- Independent verification pass (fresh harness backend, iPhone 17 Pro):
  `pnpm exec turbo run typecheck lint test` green for `@bb/mobile` (81
  files / 518 tests, 0 lint warnings), `@bb/plugin-interaction-contracts`,
  `@bb/client-core`, `bb-plugin-ask-user-question` (36) and
  `bb-plugin-secrets` (8); `@bb/integration-tests test:smoke` green (28);
  the server's builtin/official plugin bundling tests still pass with the
  shared contracts package; prettier clean. Every Maestro flow PASS on one
  fresh backend in this order: `phase1-shell`, `smoke`, `phase4a-timeline`,
  `phase4a-conversation-rows`, `phase4a-work-rows`, `phase4a-diff-showcase`,
  `phase3-threads`, `phase3-compose`, `phase4b-send`, `phase4b-ask-user`,
  `phase4b-approve`, `phase4b-queue`, `phase4b-actions`,
  `phase4b-thread-actions`, `phase4b-composer`, `phase4b-interactions`,
  `phase4b-approval`. Two fixes from that pass: (1)
  `phase4a-conversation-rows.yaml` long-pressed an assistant row on the Rich
  thread, whose pending question now puts the interaction banner over the
  bottom third of the screen — rows the list pre-renders under the banner
  still count as "visible" to Maestro, so the long-press landed on the
  banner; the Copy-text check moved to the Rows thread (no pending
  interaction). (2) Photo-library picks arrived as HEIC (the simulator's
  sample photos are HEIF; `expo-image-picker` preserves the format) and the
  runtime labels unknown extensions `image/png` for the provider, so
  `launchImageLibraryAsync` now asks for the `Compatible` asset
  representation — the upload lands as JPEG (verified on device: the stored
  attachment is `JPEG image data`, previously `HEIF Image`).

Carried forward:

- Fake-provider / harness quirks seen through mobile (not mobile bugs): a
  steer ("Send now" during a turn) is recorded as a pending steer row that
  disappears when the turn completes and gets no "Response to:" of its own;
  `approve:command` rows never complete; the fake provider's catalog exposes
  one reasoning level; `serviceTier: fast` is rejected at turn.submit despite
  `supportsServiceTier: true`; after `POST /threads/:id/stop` the timeline
  can 500 for that thread (reused turn ids).
- Voice could not be exercised on the simulator (the harness reports
  `voiceTranscriptionEnabled: false`); the sent-message edit path runs only
  behind the `editMessages` experiment + `supportsSessionRewind`, so it is
  unit-tested (submit mode, gating) but not driven on device; PR banner
  actions and the secret-request plugin form have no harness fixture (unit
  tests + synthetic showcase only).
- Maestro env precedence: values in a flow's `env:` block win over `-e`, so
  the Phase 4b screen flows use fixed thread titles ("P4b send", …) that
  must exist; flows that need an id (`phase4b-interactions.yaml`,
  `phase4b-approval.yaml`) leave `THREAD_ID` undefined and take `-e`.
- The model pill truncates at 220 px ("Fake Model · Fast Medium" clips).
  `KeyboardPaddingView` is iOS-only (Android resizes the window itself) and
  assumes the view reaches the window's bottom edge; the underlying
  keyboard-controller `KeyboardAvoidingView` gap is worth an upstream issue
  (repro: `/tmp/p4b-adhoc/kav.yaml` sequence on a thread with a git banner).
  Under `EXPO_PUBLIC_BB_E2E=1` any Metro reload (a file save) wipes the
  profile mid-flow, so do not edit sources while Maestro runs.
- The prompt stack (child rows, workflows, background commands, cards,
  banner, queue) scrolls inside a 60%-of-window cap; per-workflow expansion
  is local to the card. Android remains unverified (styled-range
  `TextInput` is iOS children-mode; Android renders plain text with the same
  model).
- Still open from earlier phases: `onlineManager`/NetInfo wiring, connect
  enrollment UI (Phase 5), native header font on iOS 26, Expo/EAS account,
  `getThreadDisplayTitle` duplication, `systemVersionQueryKey` location.

## Merge of origin/main (2026-08-19)

Merged 32 commits from `origin/main` (web perf work, WebSocket ping/pong +
reconnect watermark + visibility-gated realtime flushes #1883, timeline delta
snapshot ring and tool-output preview cap #1888, phone interactions #1900,
plugin boot changes, icon map split #1892, browser SDK without `guide`).

Conflict resolutions:

- `apps/app/src/components/promptbox/mentions/find-active-trigger.ts`: main's
  256-char trigger scan window applied to the `@bb/client-core` copy
  (`packages/client-core/src/prompt/mentions/find-active-trigger.ts`); the
  web shim stays. Its test moved with it (git rename detection).
- `apps/app/src/lib/fixed-panel-tabs-state.ts`: main's cheap prune decision
  (`shouldPruneStoredFixedPanelTabsState`) needs the private zod schema, so
  it lives in `packages/client-core/src/panel/fixed-panel-tabs-state.ts`
  (exported) and the web module re-exports and calls it from
  `pruneFixedPanelTabsStorage`.
- `apps/app/src/lib/route-paths.ts`: main's `getPluginPanelRoutePluginId`
  uses react-router `matchPath`, so it stays in the web module next to the
  other `matchPath` consumers; constants keep coming from client-core.

Mobile adaptations:

- Realtime protocol (`src/lib/realtime/mobile-realtime.ts`): the manager
  now sends `{type:"ping"}` every 25 s while connected (skipped when any
  frame arrived within 5 s), treats any inbound frame as proof of life,
  ignores `pong`, and replaces a socket whose probe goes unanswered
  (immediately, no backoff; a close that arrives while a probe is
  outstanding also reconnects at once). `onConnected` events are now
  `{reconnected:false} | {reconnected:true, disconnectedAt}` where
  `disconnectedAt` is the last moment the previous socket was trusted (last
  inbound frame after a failed probe, the close/suspend/disconnect time
  otherwise). `resume()` on a never-suspended manager (iOS `inactive` →
  `active`) probes an open socket and reconnects a closed one right away.
  `reconnectNow()` is public.
- Reconnect catch-up (`src/lib/query/realtime-invalidation.ts`): instead of
  invalidating the whole cache, a reconnect invalidates queries whose
  `dataUpdatedAt < disconnectedAt` with `cancelRefetch: false` (mirrors the
  web's `invalidateRealtimeQueriesAfterServerReconnect`); pending
  fine-grained invalidations are kept rather than dropped.
- `createMobileSdk` returns `BrowserBbSdk` (main split the local `guide`
  area out of the browser SDK).
- Icon map: main pruned ten unused names and split the web map into
  `icon.tsx` (core) + `icon-extended.tsx`; the mobile map dropped the same
  names (`CircleDashed` usages became `Circle`) and `icon-map.test.ts` reads
  both web files.

Not adopted (follow-ups): the web's compact-viewport
`segmentLimit: 8` first timeline window (mobile still takes the server
default; the unread-divider e2e flow expects the first message in the first
window), the on-demand full output for `outputPreview` command/tool rows
(mobile renders the server's head+tail preview as the row output), and the
visibility-gated flush of realtime invalidations (mobile closes the socket in
the background, so nothing arrives while hidden).

## Phase 5 — bb connect, push notifications, deep links (done 2026-08-19) → M2.5

Built by four parallel agents (mobile connect UX + e2e stub; web/CLI pairing
surfaces; push server/SDK/CLI; mobile push client + deep links + `.well-known`
gate files) plus an independent verification/integration pass; nothing
committed at the time of this entry.

What landed:

- **Pairing surfaces (web + CLI)**: Settings → Remote access (connected
  state) gained a "Mobile app" subsection with "Add mobile device" → QR
  (`encodeMobilePairingPayload({code, serverUrl, apex, expiresAt})`, compact
  JSON) + copyable code + 1 s countdown + expired → "Generate a new code",
  typed `machine_limit` (409, names the dashboard) / `not_paired` /
  `network` errors (`plugins/connect/app.tsx`). The CLI command
  `bb connect machine-code [--json]` prints code / server / apex / expiry
  (JSON = the QR payload; `plugins/connect/src/cli.ts`).
  `@bb/connect-client` gained zod-free
  `src/urls.ts` (`deriveConnectBaseUrl`, `serverUrlForHandle`,
  `connectPublicProtocol`) and `src/mobile-pairing.ts`
  (`mobilePairingPayload` / `encode` / `parseMobilePairingPayload`) so the
  plugin bundle tree-shakes to those two files; `"sideEffects": false`.
  Guide templates (`bb-guide-environments`, `bb-guide-overview`), the bb-cli
  skill, `docs/configuration.md` ("Pairing the bb mobile app") and
  `docs/multiple-devices.md` ("Use the bb mobile app") describe both.
- **Mobile enrollment** (`src/data/connect/`, `src/screens/connect/`,
  route `/connect`): `parseConnectPairingPayload` (QR JSON, `bb://connect?…`
  URLs, bare codes), `resolveEnrollmentTarget` (handle or URL → apex;
  "Self-hosted bb connect…" reveals the apex field), `redeemEnrollment` →
  `redeemMachineCredential` → connect profile `{handle, credential}`,
  `describeEnrollmentError` (invalid/expired/already-used/machine-limit/
  network/unauthorized copy), `ConnectScanner` (`expo-camera`, QR only,
  in-app permission card → OS prompt only on "Allow camera"),
  `AccountServersList` over `useAccountServers` (`listAccountServers` with
  the machine credential: the enrolled server is marked, every other server
  on the account is one tap away — the credential and the desktop-session
  cookie are account-scoped, so one pairing covers the account; no second
  code). Add server offers "Connect with bb connect" above the direct form;
  Servers shows mode pills + `@handle`; the auth-required banner is one
  pressable ("Sign in again") that opens `/connect?profileId=…` in re-pair
  mode and replaces the profile's credential in place.
- **Session + re-auth hardening** (`src/lib/connection/`,
  `src/lib/realtime/`, `src/lib/sdk/`, `src/lib/query/`,
  `src/lib/session/`): queries that errored before the first desktop-session
  cookie landed are refetched on every `authenticated` transition
  (`refetchQueriesRejectedBeforeSession`); a 401 within 2 s of a mint is
  treated as the stale-cookie race (debounced refetch, no second mint);
  `MobileRealtime.probeOrReconnect()` after a verify instead of tearing down
  a connecting socket; auth-rejected `/ws` upgrades are detected from the
  close reason (RN 0.86 puts "Received bad response code from server: 401"
  there) so revoke → banner takes ~3 s instead of the 30 s throttled path;
  `ProfileClient.onAuthFailure` (fetch status | realtime message);
  `sessionCookieSpec` sets `Secure` only for https server URLs (the local
  stub gate).
- **Push, server side** (`packages/db` migration `0102_push_subscriptions`
  with the regenerated snapshot, `packages/domain/src/push-subscription.ts`,
  `packages/server-contract/src/api/notifications.ts`,
  `apps/server/src/routes/notifications.ts`,
  `apps/server/src/services/notifications/{push-subscriptions,push-sender}.ts`):
  `GET/POST /api/v1/notifications/push-subscriptions`,
  `DELETE …/:id` (upsert by token, 201 new / 200 refreshed, strict body
  `{expoPushToken, platform: ios|android, deviceLabel}`), SDK area
  `sdk.notifications.pushSubscriptions.{add,list,remove}` (core + browser +
  node), CLI `bb notifications push-subscriptions list|add|remove [--json]`,
  env `BB_PUSH_NOTIFICATIONS` (default true) + `BB_EXPO_PUSH_URL`
  (startup-only; `packages/config`, bb-app launcher list, docs/guide/skill).
  The sender subscribes to the hub's change stream: `interactions-changed`
  with a pending interaction → `pending-interaction`; `status-changed` /
  `read-state-changed` re-read the thread and fire `turn-finished` /
  `thread-error` when `latestAttentionAt` advanced; coalesced per thread for
  2 s (kinds merge, priority pending-interaction > thread-error >
  turn-finished); dropped at flush when the thread was read after the
  trigger, the interaction was resolved, the agent is working again, or the
  thread is archived/deleted/hidden. Title = thread title (≤ 80), body =
  question prompt / "Approve command: …" / plugin title / first line of the
  last assistant message / last error (≤ 180), data
  `{kind, projectId, threadId}`, batches of ≤ 100 to the Expo Push API,
  `DeviceNotRegistered`
  tickets delete the row. Tokens are never logged (row ids only).
- **Push, app side** (`src/data/notifications/`, `src/notifications/`):
  pure registration policy (`decidePushSync`, `shouldReregister`,
  `syncPushRegistration`, `unregisterPushRegistration`,
  `enablePushForProfile`, `describePushStatus`), coalescing controller,
  MMKV push store on `bb.preferences`, `createPushSubscriptionsApi` over
  the real SDK area keyed by server URL (so a removed profile's row can
  still be deleted), `PushNotificationsHost` (sync on connect / AppState /
  token roll / toggle, removed-profile cleanup, tap routing incl. cold-start
  `getLastNotificationResponse`, foreground toast with Open, one-time
  "Get notified…" sheet after the first successful connection — never on
  launch, and the OS prompt only fires from "Turn on notifications"),
  `AppBadgeSync` (client-derived count from the sidebar, cleared on
  foreground to the home list), `PushSettingsRows` per-profile toggle in
  Settings → Notifications (`usePushRegistration(profile)`; shows "Push
  unavailable until the app is built with EAS" until
  `extra.eas.projectId` exists).
- **Deep links** (`src/lib/links/incoming-link.ts`, `app/+native-intent.tsx`,
  `app.json`): `bb://` scheme + universal links (`applinks:getbb.app`,
  `applinks:*.getbb.app`; Android `intentFilters` autoVerify for
  `/threads/`, `/projects/`, `/settings/`) resolve to the web paths via
  `mapWebPathToMobilePath` (`/projects/:p/threads/:t` → `/threads/:t`),
  match a profile by server URL (+ path prefix), switch profile and wait for
  the connection, or land on Add server with `?serverUrl&next` for an
  unknown server; the realtime `thread-open` signal navigates to the thread
  (`ThreadOpenSignalHandler`). Cloud: `@bb/connect-db/src/app-links.ts` is
  the single source of truth for `/.well-known/apple-app-site-association`
  and `/.well-known/assetlinks.json` (static JSON, GET/HEAD only, 405
  otherwise), served by the gate worker for every host before label
  resolution and the session gate (never proxied) and by the apex TanStack
  routes; `ASSETLINKS_SHA256_FINGERPRINTS` optional on both workers.
- **Connect e2e stub** (`tests/integration/mobile-e2e/connect-stub.ts`,
  `pnpm --filter @bb/integration-tests e2e:mobile-connect-stub`): TLS apex
  `https://localhost:42998` (`POST /api/connect/redeem-machine`; code
  `STUB-PAIR`, sentinels `EXPIRED-CODE` / `USED-CODE` / `LIMIT-CODE`) + gate
  `https://stub.localhost:42998` (desktop-session cookie, account servers
  `stub` + `other`, everything else proxied HTTP + WebSocket to the harness
  backend only with a valid `__Secure-bb-connect.desktop_session` cookie,
  else the HTML 401 page; `Origin` rewritten to loopback like the real
  tunnel client). Control `GET /__stub/state` and
  `POST /__stub/{expire-session,revoke-machine,reset}` on the TLS port and on
  plain `http://127.0.0.1:42997`; a local CA under
  `~/.bb-mobile-e2e/connect-stub-certs` installed into the simulator with
  `BB_MOBILE_E2E_SIMULATOR=<udid>`. TLS + `*.localhost` are required because
  `@bb/connect-client` insists on `<label>.<apex host>` and ATS refuses plain
  http to a qualified hostname.

Verification (independent pass, fresh harness backend on 41999 + stub +
Metro 8082, iPhone 17 Pro `5E5752AC`):

- `pnpm exec turbo run typecheck lint` green for `@bb/mobile`, `@bb/server`,
  `@bb/server-contract`, `@bb/sdk`, `@bb/cli`, `@bb/db`, `@bb/config`,
  `@bb/templates`, `@bb/integration-tests`, `@bb/app`, `bb-plugin-connect`,
  `@bb/connect`, `@bb/connect-client`, `@bb/connect-db`, `@bb/web`,
  `@bb/domain`; `turbo run test` green for `@bb/mobile` (90 files / 596
  tests), `@bb/db` (30 files), `@bb/sdk`, `@bb/cli` (49 files), `@bb/config`,
  `@bb/connect` (worker tests incl. the four `.well-known` cases),
  `bb-plugin-connect`, `@bb/connect-client`, `@bb/connect-db`,
  `@bb/server-contract`, `@bb/domain`, `@bb/templates`, `@bb/web`; server
  `test/services/push-sender.test.ts` + `test/public/public-notifications.test.ts`
  (13); `@bb/integration-tests test:smoke` (28). `drizzle-kit generate`
  reports "No schema changes" (snapshot regenerated, not hand-edited);
  prettier clean on every touched file (`turbo.json`, `wrangler.jsonc`,
  `migrate.test.ts` were already unformatted at HEAD and were left alone).
- Review: no accepted-but-ignored route/command fields (the push request is
  `.strict()`; every field lands in the row); SDK + CLI + guide/skill/docs
  parity for the notifications routes and `bb connect machine-code`; no
  daemon-boundary change (`HOST_DAEMON_PROTOCOL_VERSION` untouched);
  secrets never logged (the sender and the register/remove services log row
  ids and platforms only; the stub's verbose log is opt-in and test-only);
  the gate `.well-known` exemption answers two exact paths with static JSON
  before any label lookup and cannot reach the tunnel; the session cookie is
  `httpOnly`, `Secure` follows the server URL scheme; push permission is
  requested only from the in-app sheet/toggle, camera permission only from
  the scanner's "Allow camera".
- Maestro on one backend, in this order, all PASS: `phase5-connect` (first
  run → Connect with bb connect → EXPIRED-CODE inline error → STUB-PAIR +
  handle `stub` + self-hosted apex → enrolled, session authenticated,
  account servers listed, "other" added with one tap → home through the
  gate → Servers pills → expire-session: banner then self-heal → revoke:
  "needs to be paired again" → tap banner → re-pair → home connected),
  `phase5-links` (`bb://threads/<id>`, `bb://projects/<p>/threads/<t>`,
  `bb://settings/servers`, `bb://settings` with the push row),
  `phase1-shell`, `smoke`, `phase4b-send` (after creating the "P4b …"
  threads through the API), plus `phase3-threads`, `phase3-compose`,
  `phase4a-timeline`, `phase4a-work-rows` after the keyboard fix below.
  Screenshots: `/tmp/p5-verify/` (Add server with the bb connect row, the
  enrollment form, expired-code error, enrolled screen with account servers,
  home through the gate, Servers pills, session renewed, auth-required
  banner, re-pair, QR scanner, Settings push row, deep-link landings).
- Earlier in the phase (connect agent): a real enrollment against
  `bee.getbb.app` with a code minted through the connect plugin RPC — home
  shows the real threads with realtime through the gate, no banner.
- Fix from this pass: Maestro's `hideKeyboard` stopped working on the Add
  server screen once the bb connect row lengthened it (the swipe no longer
  finds a Return key). `phase1-shell`, `phase3-threads`, `phase3-compose`,
  `phase4a-timeline`, `phase4a-work-rows` now tap the static "Server URL"
  label like the shared `launch-to-home.yaml` subflow already did.

Not verifiable on this Mac (carried forward):

- Real push delivery: no Expo/EAS account yet, so `extra.eas.projectId` is
  unset, the dev client reports "Push unavailable until the app is built
  with EAS" and nothing registers with the real server. Acceptance (token →
  `POST /notifications/push-subscriptions` → exp.host → APNs) needs an EAS
  project + a signed build on a physical iPhone. The app side was exercised
  with a temporary fake project id (first-run sheet, OS prompt, failure
  surfaced in Settings) and `xcrun simctl push` (foreground toast with Open,
  background banner + badge, tap → thread).
- Universal links: `associatedDomains` / `intentFilters` /
  `expo-notifications` plugin config are native config → prebuild + rebuild
  of the dev client; the AASA/assetlinks files are unit-tested and served by
  the gate + apex but Apple's CDN fetch of `applinks:*.getbb.app` and a
  signed build are needed to see a `https://<handle>.getbb.app/threads/…`
  link open the app. Android fingerprints stay empty until the app is
  signed (`ASSETLINKS_SHA256_FINGERPRINTS`).
- The simulator machine enrolled against `bee.getbb.app` (handle `bee`)
  should be revoked in the getbb.app dashboard under Machines.

Carried forward:

- Removing a connect profile does not clear the account-wide desktop-session
  cookie from the native jar (it expires within the hour); documented.
- The stub is TLS on `*.localhost` rather than `http://127.0.0.1` (see
  above); the simulator must trust the CA once. Metro must not run with
  `CI=1` (file watching off → stale bundles). Maestro: a flow's `env:` block
  wins over `-e`, so the Phase 5 flows hardcode `METRO_URL` 8082 like the
  others; `hideKeyboard` fails on fields whose return key is "next", so
  flows tap static labels.
- The one-time push sheet can cover screens in any flow after the first
  connection once a project id exists; `phase5-connect.yaml` dismisses it
  conditionally ("Not now"), other flows do not yet.
- `openLink bb://…` from a thread pushed via `router.push` sometimes lands
  with the drawer open (seen once; not reproduced in the flows).
- Still open from earlier phases: `onlineManager`/NetInfo wiring, native
  header font on iOS 26, Expo/EAS account, Android SDK.

## Phase 6 — workspace surfaces: panel, Info, Diff, Files, Terminal (done 2026-08-19) → M3

Built by four parallel agents (panel shell + Info tab + thread-tabs sync;
Diff tab; Files tab + previews + local file links; terminal) plus an
independent verification/integration pass; nothing committed at the time of
this entry.

What landed:

- **Workspace panel shell** (`src/screens/panel/`, `src/data/thread-tabs/`):
  a 92% bottom sheet (`@/ui` Sheet, deferred content) with a horizontal tab
  strip — fixed Info · Diff · Files · Terminal entries + the thread's synced
  closable file tabs ("x", long-press Close / Close others / Close all) —
  and one content view. `WorkspacePanelProvider` owns the client-core
  `FixedPanelTabsState` (device-local MMKV under the web's storage key;
  thread scope mirrored against `GET/PUT /threads/:id/tabs` through a
  per-profile write queue with the cached revision, 409 rebase-and-retry
  once, second 409 → server wins, first-sight local→server migration at
  revision 0, realtime `tabs-changed` → invalidate), the transient selection
  (launchers, `diffPath`, `filesParams`) and the `usePanel()` controller
  (`open / openInfo / openDiff(path) / openFiles(params) / openTerminal(id,
target) / openFile(request) / openTab / activate / closeTab /
closeOtherTabs / closeAllTabs / consume* / updateTabsState`). Contents are
  registered per tab kind / launcher from one manifest
  (`panel/contents/index.ts` imports the built-ins and the Diff / Files /
  Terminal `register.ts` files, each importing the leaf
  `@/screens/panel/registry`); `retainWhenInactive` keeps terminals, the
  diff list and the Files launcher mounted while hidden. `browser` /
  `plugin-panel` / `plugin-page-fixed` render the "Available on desktop/web"
  card; `side-chat` is dropped on read like the web. Entry points:
  `ThreadDetailHeader` panel button (`thread-panel-button`), the compose
  screen's "Workspace" button (`compose-workspace-button`, project scope:
  Files + Terminal only, state `root-compose:<profileId>`, no sync).
- **Info tab** (`ThreadInfoTabContent`): parent, forks, environment + host
  - managed pill, directory (copy), branch / checkout (copy), merge base →
    picker sheet, git status, PR pill + link, archived + Unarchive, commits,
    changed files → Diff tab focused on the file, storage → Files launcher.
- **Diff tab** (`src/data/diff/`, `src/screens/diff-tab/`,
  `src/lib/query/diff-patch-cache.ts`): `useEnvironmentDiffFiles`
  (`/diff/files?target=`, placeholder across target switches, 5 s stale,
  `environment-detail` subscription only while the tab is on screen),
  `useEnvironmentDiffPatches` (port of the web hook: viewport + overscan
  `auto` paths, 80 ms debounce, `POST /diff/patch` pages ≤ 50, observer-less
  per-(env, target, path) cache with eviction generations + retention lease,
  per-path loading / error, `loadPath` for `on_demand`, `retry`,
  `seedInitialPatches`), `useDiffTarget` (all / committed / uncommitted /
  commit picker over the merge base), collapse store, pure `diff-target.ts`
  / `diff-patch-state.ts` / `add-to-chat.ts`. Realtime: every environment
  change evicts the patch cache before invalidating the TOC / diff-file
  keys; commit does the same. UI: `DiffTabContent` (target
  picker, N files +A −D pills, collapse-all, refresh that also refetches the
  work status; FlashList of `DiffTabFileCard` over `@/diff` `DiffFileCard`
  with hunks / skeleton / "Load diff" / "Too large" / error + Retry / "No
  renderable diff" / truncated note / binary-added-deleted-renamed labels /
  per-file "Add to chat" that closes the panel and quotes into the thread's
  composer host), `DiffTargetPickerSheet` (+ merge-base row, `stackBehavior
"push"`), empty / unavailable / not-git states. The banner's changed-files
  row has "Open diff" and its file rows focus the card; timeline file-change
  rows have "Open in Diff tab".
- **Files** (`src/data/files/`, `src/screens/files/`, route
  `/threads/[id]/files`): URL builders for the raw / content routes,
  `loadFilePreview` (raw route → client-core `buildFilePreview` + size; 413
  `file_too_large`), `buildEnvironmentFilePreview` (`/diff/file` JSON →
  preview; images / videos → `data:`), preview queries per source
  (workspace via `sdk.environments.diffFile` so deleted / merge-base sides
  read too, thread storage, host file, project file; heavy-payload gc
  policy; realtime mapping), `useThreadStorageFiles`, `useFileSearch`
  (debounced env / project paths + storage paths → ranked sections with
  highlight segments), `storage-tree.ts`, `local-file-links.ts`
  (`resolveThreadLocalFileLink`: workspace root → storage root → host file;
  relative candidates → root picker), MMKV recents under the web's key,
  `registerThreadComposerHost` / `resolveThreadComposerHost`. UI:
  `FilesTabContent` (search → Workspace files / Thread storage sections;
  idle → Recent + storage browser with breadcrumbs; long-press → copy
  path / name), `FilePreviewView` (header: name, source pill, size, path →
  copy, Preview / Source toggle for md / csv / html, Jump to line, Open in
  browser, Reload; bodies: virtualized mono text with line numbers,
  horizontal scroll, range highlight, long-press line → Add to chat / Copy
  line / Copy `path:line`, "Show whole file" past 2000 lines / 256 KiB;
  markdown with sibling links + images; CSV grid; HTML in a WebView on the
  CSP-sandboxed raw route; image (expo-image + lightbox); video →
  open-externally card; loading / not-found / too-large / error / empty /
  binary), `FilePreviewScreen` (full screen, or `?kind=workspace|host|
storage|project&path=&line=[&source=&status=]`), `useThreadFileOpener`
  (context override → panel tab → route push; records recents),
  `useThreadLocalFileLinks` (+ root picker sheet) wired into the timeline
  host so markdown `path[:line]` links and relative references open the
  preview. Panel registration: the `files` launcher + the three preview tab
  kinds.
- **Terminal** (`src/data/terminals/`, `src/screens/terminal/`,
  `assets/terminal/index.html`, routes `/threads/[id]/terminal` +
  `/threads/[id]/terminal/[terminalId]`): terminal list / session queries
  (scope-keyed like the web), create / restart / close / rename mutations
  (`meta.errorMessage`), `useFetchTerminalOutput`, cache writers fed by the
  socket (`attached` / `session-updated` / `exited`), realtime
  `terminals-changed`. `@bb/client-core` `TerminalWebSocketTransport` gained
  `suspend()` / `resume()` (background / foreground; reattach from the last
  seen chunk) — the one shared-code change. `TerminalView` builds
  `ws(s)://<server>/ws/terminals/:id?sinceSeq=N` from the profile URL
  (cookies from the native jar), binds suspend / resume to `AppState`, and
  batches output into `postMessage` (≤ 16 KiB / 16 ms, never mixing replay
  with live); pure `terminal-bridge.ts` (message contracts, base64 encode /
  split at the 64 KiB wire limit, replay-write suppression so a replayed
  `CSI 6n` never produces a second DA1 reply, accessory keys → escape
  sequences with DECCKM + `1;5` Ctrl, sticky Ctrl, the write batcher) and
  `terminal-stream.ts` (attached / output / error / exited, connection
  notices, a replay gap after resume filled from `GET /terminals/:id/output`
  with reset + "Some terminal output was unavailable after reconnect" as the
  fallback). The WebView page (`page/terminal-page.ts` + CSS, xterm + fit +
  unicode11 + web-links) is bundled by `scripts/build-terminal-page.ts`
  (`pnpm --filter @bb/mobile terminal:build`, esbuild, deterministic) into
  the committed self-contained `assets/terminal/index.html` (a vitest
  rebuilds it in memory and fails when stale); loaded as `source={{ html }}`
  with `originWhitelist ['*']`, `setSupportMultipleWindows={false}`, and an
  `onShouldStartLoadWithRequest` that refuses every navigation other than
  the inline document (links go to RN as `link` messages, accepted only for
  http(s)). UI: `TerminalTabContent` (terminal + accessory bar + not-running
  card), `TerminalAccessoryBar` (esc, tab, sticky ctrl, arrows, home / end,
  `-` `/` `|`, paste, keyboard, "…" menu), `TerminalSessionsList`, the
  `terminal` tab kind + launcher, the full-screen route (any orientation,
  rename / restart / new / close menu). Maestro reads the page through a
  dev/e2e-only one-line text mirror (`terminal-text-mirror`).
- **Query / realtime plumbing**: new query keys + realtime mappings for
  thread tabs, diff files / patches / file sides, file previews (workspace,
  storage, host, project), storage files, terminals; `@/data/shared`
  policies `REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY`,
  `EXPENSIVE_MANUAL_QUERY_POLICY`, `HEAVY_PAYLOAD_QUERY_POLICY`;
  `ProfileClient.fetch` (the SDK's fetch with the app-surface header and
  401/403 reporting) for the raw content reads.
- **E2E**: `phase6-panel.yaml`, `phase6-diff.yaml` (+
  `e2e/scripts/phase6-diff-setup.sh`, `phase6-commit.js`),
  `phase6-files.yaml` (+ `phase6-files-setup.sh`), `phase6-terminal.yaml`,
  `phase6-terminal-resume.yaml`.

Verification (independent pass, fresh harness backend on 41999 + Metro 8082
with `EXPO_PUBLIC_BB_E2E=1`, iPhone 17 Pro `5E5752AC`):

- `pnpm exec turbo run typecheck lint test --filter=@bb/mobile
--filter=@bb/client-core` green (mobile 112 files / 747 tests, 0 lint
  warnings; client-core 20 / 236); prettier clean on every touched file.
- Review: every tab content registers once from the manifest
  (`panel/contents/index.ts`) through the leaf registry module (the Files
  registration was switched off the barrel, which logged Metro
  require-cycle warnings); Info / Diff / Files / Terminal open from the
  thread header, the banner's changed-files row opens the Diff tab, markdown
  - timeline file links open the preview, the compose screen's project panel
    works. Terminal WebView: bundled asset only, no remote content, page ↔ RN
    payloads are JSON-encoded both ways and parsed with zod on the RN side,
    `link` messages restricted to http(s) (new test), navigation refused by
    `onShouldStartLoadWithRequest`. HTML preview WebView: main-frame
    navigations away from the raw URL go to the system browser instead of
    steering the cookie-sharing WebView elsewhere. Raw content reads use the
    profile fetch (app-surface header + auth-failure reporting) and the native
    cookie jar; size limits come from the server (413 `file_too_large`) plus
    the text body's 2000-line / 256 KiB render budget. Diff FlashList: memoized
    cards with a structural `patchState` comparator, parse keyed on the patch
    text, viewport-driven patch requests paused while the tab is hidden;
    `environment-detail` subscription enabled only while the Diff tab is on
    screen. No DOM APIs outside `src/screens/terminal/page/`; icon-only
    controls carry accessibility labels.
- Fixes from this pass: (1) `retainWhenInactive` did not retain — the
  active view rendered in a separate slot from the retained views, so
  every tab switch remounted the content (terminal socket + WebView, diff
  scroll, Files search text); the content host now renders active + retained
  views in one keyed sibling list. (2) The sheet content was 70–80 pt
  taller than the visible sheet (`BottomSheetView` with `bottom: 0` spans
  @gorhom's over-drag padding), pushing the terminal accessory bar and the
  text mirror below the screen in the panel; the panel now uses a plain
  flex-1 `View` with the bottom safe-area inset, and the panel terminal tab
  wraps in `KeyboardPaddingView` so the accessory bar rides above the
  keyboard (the sheet only resizes for its own text inputs). (3)
  `phase6-files.yaml` clears the retained search query before expecting the
  storage browser. Documented in `src/screens/panel/README.md`.
- Maestro, all PASS in this order: `phase6-panel` (Info rows, Changed files →
  Diff tab selected, Files launcher, swipe away), `phase6-diff` (banner
  "Open diff" → modified / deleted / added cards with the hunk, target
  picker + merge base, collapse-all, Add to chat closes the panel and quotes
  `> diff --git …`, banner file row focuses the card, API commit + refresh →
  "Committed changes"), `phase6-files` (storage browser → search README →
  markdown tab → Source → Jump to line 60 → storage `notes/plan.md` → deep
  link `…/files?kind=workspace&path=src%2Fapp.ts&line=12` → long-press →
  Copy line), `phase6-terminal` (panel → Start → full screen → `echo bb-42`
  → sticky Ctrl+c interrupts `sleep 45` → ArrowUp recall → rename),
  `phase6-terminal-resume`, then `smoke`, `phase1-shell`, `phase4b-send`
  ("P4b send" created through the API), `phase4a-timeline`; plus an ad-hoc
  flow: image preview (`assets/dot.png`) by deep link, the compose screen's
  Workspace button → project panel (Files + Terminal, no Info) → Start
  terminal (`host_path`, `~`) → `echo hi` with the accessory bar above the
  keyboard. Screenshots in `/tmp/p6-verify/` (Info tab, Diff tab with a
  hunk, file preview text + image, storage browser, markdown / storage
  previews, terminal with `echo hi` + accessory bar, terminal menu, project
  panel from compose).

Carried forward:

- Realtime workspace events do not arrive in the integration harness (no
  `changed` on an `environment-detail` / `thread-detail` subscription after
  editing or committing in the worktree; verified with a raw WS probe), so
  realtime-driven Diff refresh is unit-tested only and on device the Diff
  tab refreshes on Refresh / remount. Likely the harness daemon's watcher.
- Terminal deviations from the web controller: no auto-close of "clean"
  UI-created terminals when the panel closes, no auto-replacement of a
  disconnected session, an exited session keeps its tab (exit notice +
  Restart / New); no text selection / "add to chat" from the terminal (the
  WebView bridge exposes no selection); the project-scope (compose) panel
  has no full-screen terminal route (routes live under `/threads/[id]`).
- Not verified here: Android, a physical device, the terminal socket
  through the bb connect gate (`wss://<handle>.getbb.app/ws/terminals/…`;
  same native cookie jar as `/ws`, which Phase 5 verified), a session that
  exits while attached, the Files launcher's project-file previews in the
  compose panel beyond unit tests.
- Video files open externally (no expo-av / expo-video in the dev build);
  connect-mode "Open in browser" URLs open in Safari without the app's
  session cookie; relative `path[:line]` links only get the workspace /
  storage picker once the thread-storage list is cached (before that they
  open in the workspace).
- Panel contents render through the root portal host: only app-root
  contexts + `PanelContext` reach them, and they can re-render while
  `useProfiles().connection` is null (the terminal surfaces guard this;
  Diff / Files rely on the provider unmounting with the screen).
- Maestro: a flow's `env:` block wins over `-e`, so non-default ports need
  a copied flow; under `EXPO_PUBLIC_BB_E2E=1` a Metro reload mid-flow wipes
  the profile (run Metro without the flag while sources are being edited).
- Still open from earlier phases: `onlineManager`/NetInfo wiring, native
  header font on iOS 26, Expo/EAS account, Android SDK, the enrolled
  simulator machine on `bee.getbb.app`.

## Phase 7 (agent C) — CI, release prep, docs (2026-08-19)

The CI / release / docs slice of Phase 7 (the settings, machines, updates,
plugins, extensions, share and haptics screens are the other two agents'
entries). Nothing committed at the time of this entry.

What landed:

- **Runner probe**: `gh workflow run mobile-runner-probe.yml --ref <branch>`
  fails with `HTTP 404: workflow mobile-runner-probe.yml not found on the
default branch` — `workflow_dispatch` needs the file on `main`, and the
  branch is not pushed either, so the probe could not run. The e2e job is
  written against the image Blacksmith says it mirrors (GitHub's `macos-15`
  runner image, 2026-07-27: Xcode 16.4 default + 26.0.1 / 26.1.1 / 26.2
  (17C52) / 26.3, iOS 26.2 simulator runtime with iPhone 17 / 17 Pro, JDK 11 /
  17 / 21 (default) / 25, CocoaPods 1.17, no Maestro) and the desktop build
  log of that runner (macOS 15.7.4, Apple silicon, rootfs `15-20260730`).
  The probe now selects Xcode 26.2 the same way and lists the installed
  Xcodes; dispatch it once the branch is on `main`.
- **`.github/workflows/mobile-e2e.yml`** ("Mobile E2E"): `pull_request`
  (opened / synchronize / reopened / labeled, job gated on the `mobile-e2e`
  label), `workflow_dispatch` (optional `flows` input), nightly cron; one job
  on `blacksmith-6vcpu-macos-15` (90 min): setup-workspace (no Turbo cache),
  Xcode 26.2 via `DEVELOPER_DIR` (falls back to the newest 26.x, then the
  default), `e2e/scripts/pick-simulator.mjs` + `simctl boot`/`bootstatus`,
  JDK check (Temurin 17 through `actions/setup-java` only when the image has
  no 17+), Maestro 2.8.0 from the curl installer, `actions/cache` restore /
  save of `ios/Pods` + `ios/Podfile.lock` and — behind the
  `CACHE_DERIVED_DATA` workflow env knob — the DerivedData `Build/` dir,
  keyed on `pnpm-lock.yaml` + `app.json` + `package.json` + `patches/**`
  (no commit in the key: one entry per native dependency set, saved only
  after a successful build; a local Release build measured 6.9 GB of
  DerivedData, so the knob exists to protect the Turbo caches' quota),
  `expo prebuild --no-install` + `pod install`, `expo run:ios --configuration
Release --no-bundler --device <udid>` with `EXPO_PUBLIC_BB_E2E=1` and
  `EXPO_PUBLIC_BB_SERVER_URL` in the env (the Xcode bundle phase runs `expo
export:embed`, which inlines them — verified locally: the Release bundle
  contains `EXPO_PUBLIC_BB_E2E:"1"` and the 41999 URL), the harness backend
  through `turbo run e2e:mobile-backend` in the background (waits for
  `/health`), `e2e/scripts/ci-run-flows.sh`, then simulator log + artifact
  upload (`e2e-artifacts/`: per-flow Maestro output dirs with screenshots /
  logs / JUnit, backend log). Linux typecheck / lint / unit tests for
  `@bb/mobile` already run in `ci.yml` (`Checks` builds + typechecks + lints
  every workspace package; the `packages` test shard is everything but
  server / app / integration) — nothing to add there.
- **Flows without Metro**: a Release build embeds the bundle and
  `ExpoDevLauncherReactDelegateHandler` returns early when
  `EXAppDefines.APP_DEBUG` is false, so the dev-client deep link cannot be
  used. New `e2e/subflows/launch-app.yaml` cold-starts either way: `-e
BB_E2E_EMBEDDED_BUNDLE=1` → `launchApp`; otherwise the dev-client
  `openLink` + "Open" / "Continue" / "Close" handling that every flow used to
  inline. It is a `-e` variable (not `METRO_URL`) because Maestro applies the
  CLI env first and a flow's `env:` block overrides it
  (`Env.withEnv` / `DefineVariablesCommand`; undeclared variables evaluate to
  `undefined` in GraalJS, so `typeof` guards work). `launch-to-home.yaml`
  and the eight flows that inlined the block (`smoke`, `phase1-shell`,
  `phase3-threads`, `phase3-compose`, `phase4a-timeline`,
  `phase4a-work-rows`, `phase4a-diff-showcase`, `phase5-connect`) now call
  it; `smoke.yaml` also handles the first-`bb://`-link "Open" prompt. The
  Server status card's "Poke" button is gated on `e2eModeEnabled` instead of
  `__DEV__` so `phase1-shell` passes on the Release build.
- **Scripts**: `e2e/scripts/create-idle-thread.sh` (idempotent "P4b …"
  thread on the harness host, waits for idle), `e2e/scripts/ci-run-flows.sh
<udid> <artifacts dir> [flow…]` (seeds "P4b send" and "P6 panel thread" —
  the latter via `phase6-diff-setup.sh` with `THREAD_TITLE` —, runs `smoke`,
  `phase1-shell`, `phase4a-timeline`, `phase3-compose`, `phase4b-send`,
  `phase6-panel` one `maestro test` each with `--test-output-dir` + JUnit,
  continues past failures, `--dev-client` switch for local Metro runs),
  `e2e/scripts/pick-simulator.mjs` (newest iOS runtime with iPhone 17 Pro /
  17 / 16 Pro / 16, else any iPhone).
- **Release prep**: `apps/mobile/eas.json` (`development` simulator dev
  client, `development-device`, `preview` internal, `production` with
  `autoIncrement`; `appVersionSource: remote`; no update channels because
  `expo-updates` is not installed) and the README "Release (EAS)" steps
  (`eas init` → `extra.eas.projectId`, `eas credentials` incl. the APNs key,
  builds / submit, universal-link + Android follow-ups).
- **Docs**: `docs/platform-support.md` gained a "Mobile app" section
  (platforms, Direct vs bb connect, distribution, push prerequisites, what
  the phone cannot do) and a CI bullet; `docs/repository-overview.md`
  `apps/mobile` row; `docs/multiple-devices.md` mobile subsection links it;
  `apps/mobile/README.md` structure / E2E (Release-build flows) / CI /
  Release sections; `plans/bb-mobile-expo.md` status line + "Status
  (2026-08-19)" block (shipped per M0–M4, deferred M5, user-action items).
  `CHANGELOG.md` keeps no Unreleased section (entries are written by the
  release PR, `docs/bb-release-process.md`), so no entry was added.

How verified:

- `actionlint` on both workflows: clean apart from the expected unknown
  custom runner label (`blacksmith-6vcpu-macos-15`, same as ci.yml).
- `expo export:embed --dev false` with the CI env: 13.9 MB bundle with the
  inlined `EXPO_PUBLIC_BB_E2E:"1"` / server URL. A niced Release build of
  the workspace with the same env from this Mac (Xcode 26.2, `xcodebuild`
  with `-scheme bb -configuration Release -sdk iphonesimulator`):
  BUILD SUCCEEDED in about 9 minutes; the bundle phase ran
  `expo export:embed` into `bb.app/main.jsbundle` (Hermes bytecode, 15.9 MB,
  contains the 41999 URL); DerivedData 6.9 GB.
- The seeding scripts ran against a private harness backend on 43999
  (`create-idle-thread.sh` twice → same id; `phase6-diff-setup.sh` with
  `THREAD_TITLE="P6 panel thread"`); `ci-run-flows.sh` dry-run with a stub
  `maestro` (ordering, per-flow dirs, non-zero exit on one failure). The
  flow YAML parses; the `launchApp` branch itself was not driven on a
  simulator in this pass (no simulator was assigned to this slice) — the
  first `Mobile E2E` run on GitHub is the real test.
- `pnpm exec turbo run typecheck lint test --filter=@bb/mobile`: typecheck +
  lint green; one test (`realtime-invalidation.test.ts` system config
  mapping) failed against another agent's in-flight `query-keys` /
  `realtime-invalidation` edits, unrelated to this slice.

Carried forward:

- First real run of `Mobile E2E` (after the merge, or label a PR): confirm
  the Blacksmith image matches (Xcode 26.2, iOS 26.2 runtime, JDK), the
  Release build time on 6 vCPUs, and the `actions/cache` sizes (DerivedData
  may be several GB; drop that cache if it starves the Turbo caches).
- `phase5-connect` needs the TLS stub + simulator CA install and is not in
  the CI set; the remaining flows need seeds the CI script does not create
  yet (`phase6-diff` / `phase6-files` setup scripts, `-e THREAD_ID` flows).
- Android: no emulator job (no SDK, no KVM check yet).

## Phase 7 (agent B) — plugins, marketplaces, skills, share, haptics (2026-08-19)

What landed (nothing committed at the time of this entry):

- **Data** (`apps/mobile/src/data/plugins/`, `src/data/skills/`, see
  `src/data/README.md`): plugin list / settings / updates / logs / catalog
  search + install plan / marketplaces queries over `sdk.plugins.*` (logs via
  the profile fetch: `GET /plugins/:id/logs` is not in the SDK), every
  management mutation (enable / disable, settings PUT with changed keys only
  and write-only secrets, check / apply updates, remove, reload, install from
  a source or a catalog entry with the third-party `confirmedSource`, add /
  refresh / remove marketplaces), `useServerSvgAsset`; the skills library
  (personal project), skill files / content, skills.sh registry search /
  entry / detail, install / delete. New query keys in
  `src/lib/query/query-keys.ts` ("Plugins, marketplaces, skills (Phase 7)" +
  `serverSvgAsset`); `plugins-changed` now also invalidates the plugin list,
  every settings view, the update results, the catalog search and the
  project skills (test added to `realtime-invalidation.test.ts`). Pure,
  vitest-tested models: `plugin-model.ts` (row-signal precedence, health
  presentation + recovery, settings availability — a disabled plugin reports
  `hasSettings: false` because no factory ran, so "disabled" is decided
  before "none" —, the secret-aware change set, update summaries, catalog
  grouping, source normalization), `skill-model.ts` (scope labels,
  grouping, registry page accumulation, installed-entry resolution).
- **Screens** (`src/screens/plugins/`, `src/screens/extensions/`, routes
  `/settings/plugins`, `/settings/plugins/browse`,
  `/settings/plugins/[pluginId]`, `/settings/plugins/[pluginId]/logs`,
  `/settings/marketplaces`, `/settings/skills`, `/settings/skills/[skillId]`,
  `/settings/skills/registry`, `/settings/skills/registry/[registrySkillId]`;
  hrefs in `shell/hrefs.ts`, titles in `RootNavigator`): installed plugins
  (filter, one signal pill per row, long-press enable / disable / reload /
  uninstall, header "+" and an "Add from source" row → `AddPluginSheet` with
  the full-trust warning, "Check for updates" / "Reload all"); plugin detail
  (identity pills, enable switch, health banner + recovery, update card with
  check / apply, `PluginSettingsForm` for string / secret / boolean / select
  (option sheet) / project (`ProjectPicker`), includes, runtime (CLI,
  services, schedules), source with copyable path, reload / logs /
  uninstall with confirmation); logs viewer (numbered mono lines, tail
  100 / 200 / 1000, header refresh, long-press copies a line); catalog browse
  grouped by publisher with installed / incompatible markers and the
  third-party resolved-source disclosure before install; marketplaces (list
  with refresh state, add sheet, tap / long-press → refresh / remove, "Add
  marketplace" + "Refresh all" rows because the header "+" sits under the
  dev client's gear on larger simulators); skills library grouped by scope
  with a filter (the in-process harness daemon discovers this Mac's real
  skill folders, 100+ entries), read-only skill detail (file chips, SKILL.md
  via `@/markdown`, copy path, delete for user-owned skills), registry browse
  (debounced search, trending / all-time label, Load more, 503 → "skills.sh
  is unavailable") and registry detail with "Install to my skills" →
  "Installed — open". Shared pieces: `ServerSvgIcon` / `PluginIcon`
  (`currentColor` SVGs rendered through react-native-svg `SvgXml` with the
  theme foreground — used by the plugin rows, the catalog, and now the
  provider picker's logos via the new `leading` slot on `PickerTrigger` /
  `PickerOption`), `plugin-ui.tsx` (SettingsSection, DetailRow, CardNote,
  NoticeCard, PluginSignalPill). Settings home rows for Plugins / Skills /
  Marketplaces come from agent A's Extensions section.
- **Share**: "Share link" in the thread "…" menu (`src/lib/share/share-thread.ts`,
  RN `Share.share`; verified on the simulator — the iOS share sheet opens with
  the thread URL). Inbound "Send to bb": `share-intent.ts` loads
  `expo-share-intent` optionally + `ShareIntentHandler` (mounted in
  `app/_layout.tsx`) → `/compose?initialPrompt=` for text / URLs; the native
  module is **not** installed (config plugin + `pnpm ios` rebuild documented
  in the README "Share sheet and haptics" section), so the handler is inert in
  the current dev client. Pure `composeSeedFromShareIntent` tested.
- **Haptics**: `src/lib/haptics/` (`haptic(kind)`, `useHapticsEnabled`,
  pure `haptics-policy.ts` + test); `Button`, the composer send, the
  approval banner, picker rows (selection), destructive ActionSheet rows
  (warning) and long-press menus (heavy) go through it; Settings →
  Preferences → Haptics toggle (`HapticsSettingsRow`, MMKV
  `bb.haptics.enabled`).
- **E2E**: `e2e/flows/phase7-plugins.yaml` (harness: Settings → Plugins empty
  state → Marketplaces (`bb-community`) + add sheet → Browse (BB Official
  group from the harness catalog) → Skills → filter `bb-cli` → detail
  renders SKILL.md → skills.sh registry list / empty / unavailable) and
  `e2e/manual/phase7-plugins-devserver.yaml` (dev server 20304: installed
  list with 14 builtins → Automations detail → no-settings + bundled-update
  notes → logs → provider-retry "Enable this plugin to see and edit its
  settings" → Browse). Both PASS on iPhone 17 (`245F0F36`) with Metro 8082;
  an ad-hoc flow enabled provider-retry on the dev server, changed its
  `maximumWait` select to "24 hours" through the form, saved (toast "Plugin
  settings saved", `GET /plugins/provider-retry/settings` returned the new
  value), then the state was restored through the API (value back, plugin
  disabled). Screenshots `/tmp/p7-plugins-*.png` (list, marketplaces, add
  marketplace, browse, skills, skill detail, registry, dev list / detail /
  logs / disabled settings / browse, settings form + saved, share sheet).
- `pnpm exec turbo run typecheck lint test --filter=@bb/mobile`: typecheck +
  lint green; tests green except the pre-existing
  `realtime-invalidation.test.ts` config-changed case that agent A's
  `themeCatalog` key extends (their test to update).

Carried forward:

- The harness runs no plugin service, so the plugin detail / settings form /
  logs are only exercised against the dev server (manual flow) — a harness
  plugin fixture would let `phase7-plugins.yaml` cover them.
- Inbound share needs the native rebuild (above); media / file shares are
  declined until the composer's attachment path accepts them.
- Plugin frontends (nav panels, settings sections, directives) remain web
  only (plan A5 / M5 SPA-in-WebView).
- Metro caveats hit here: `CI=1` disables file watching (stale bundle); with
  `EXPO_PUBLIC_BB_E2E=1` a Fast Refresh caused by another agent's edits
  wipes the profile mid-flow, so the flows were run with Metro started
  without the flag (the launch subflow's conditional add-server handles a
  persisted profile; `bb://e2e/reset` on a running app returns to first run
  — a cold `bb://` link lands on the dev-client launcher, and a reset under
  a mounted server-backed screen red-boxes in dev).
- Maestro: a `testID` View taller than the screen does not count as visible
  (assert text inside it instead); text assertions on `ListRow` titles need
  a `.*…*` regex because the row's accessibility label merges title and
  subtitle.

## Phase 7 (agent A) — settings, machines, updates (2026-08-19)

The settings-bucket slice of Phase 7; nothing committed at the time of this
entry (the integrator wrote this entry from agent A's report plus a read of
the files).

What landed:

- **Data** (`src/data/settings/`, `src/data/updates/`, `src/data/hosts/`
  extended; see `src/data/README.md`): `useUpdateGeneralSettings` /
  `useUpdateExperiments` / `useUpdateAppearance` (full-object `PUT
/settings/*` with an optimistic write into the cached `/system/config` and
  rollback, `meta.errorMessage`), `useThemeCatalog` (`GET /settings/themes`),
  `useSystemUsageLimits`, `useCliSkillsStatus` / `useInstallCliSkills`, the
  device-local preferences store (`bb.rewriteLocalhostLinks` in MMKV;
  `<Markdown>` / `<MarkdownText>` default their `rewriteLocalhostLinks` prop
  to it), pure models for usage limits, CLI skills, appearance (built-in
  palettes render natively; custom / plugin palettes fall back to the default
  palette on mobile with a footnote) and the update inventory
  (`buildUpdateInventory`, `actionableProviderIssues`,
  `summarizeMachineUpdates`, `bbAppRowState`; `useCheckForUpdates` =
  `version?force=true` + provider CLI status + CLI skills invalidation).
  Hosts: `host-update-status.ts` (daemon vs bundled
  `HOST_DAEMON_PROTOCOL_VERSION`), `host-display.ts` (platform labels,
  permission short labels, relative age, presence, meta lines),
  `select-primary-host.ts` (pure), `host-availability.ts` (loading /
  no-host / offline / ready), `permission-ceiling.ts` (`PATCH
/hosts/:id/permission-ceiling` through the profile fetch — owner-session
  route absent from the SDK), `add-machine.ts` + `use-add-machine.ts`
  (connect plugin RPC → machine code, `pairingCommand` mirroring
  `AddMachineDialog`, local-only URL / connect-unavailable presentation,
  countdown, "connected" detection from the host list), provider CLI install
  (`provider-cli-install.ts` issue model + accumulator + log truncation,
  `provider-cli-install-store.ts` pure queue-of-one with sequenced "View log"
  requests, `use-provider-cli-install.ts` bound to
  `sdk.hosts.installProviderCli` per profile with success / failure toasts),
  `useHostProviderCliStatus` / `useHostsProviderCliStatus`, `useRemoveHost` /
  `useRetryHostUpdate` / `useUpdateHostPermissionCeiling`. Query keys
  `systemUsageLimits`, `systemCliSkills`, `hostProviderCliStatus`,
  `themeCatalog` + realtime mapping (host changes → provider CLI status /
  CLI skills / usage limits; system `config-changed` | `plugins-changed` →
  theme catalog). `apps/mobile/package.json` adds
  `@bb/host-daemon-contract` (pure zod) for the provider CLI / usage types.
- **Screens** (`src/screens/settings/`, `src/screens/machines/`, routes
  `/settings/{general,appearance,experiments,usage,updates}`,
  `/settings/providers/[providerId]`, `/settings/machines`,
  `/settings/machines/[hostId]`; hrefs `settingsSectionHref`,
  `providerSettingsHref`, `machinesHref`, `machineDetailHref`): the settings
  home rewritten as the web buckets (Server, Preferences with General /
  Appearance / Experiments / Haptics, Providers with Codex / Claude Code /
  Usage limits, Machines and updates, Extensions with Plugins / Skills /
  Marketplaces, Notifications, Threads, Community, Developer, About) over
  the shared row primitives `SettingsSection` / `SettingsControlRow` /
  `SettingsSwitchRow` / `SettingsValueRow` / `SettingsHint`
  (`SettingsRows.tsx`); General (navigate after create, "Steer running
  threads on send" = `steerActiveThreadOnEnter` with the tap / long-press
  note, rewrite localhost links device-local, unhandled provider events);
  Experiments; Provider settings (memory, subagents disabled, workflows
  disabled for Claude Code); Appearance (mode buttons, palette option sheet
  from the catalog, favicon colour sheet with swatches); Usage limits
  (primary / picked machine, offline / no-host hints, bars, resets, plan /
  account); Updates (bb-app row with copy upgrade command + "Check for
  updates" + "What's new", per-machine provider CLI rows with Install /
  Update / Retry / View log + "Update all", stranded daemon "Retry update",
  CLI skills install with a machine picker); Machines (presence dot, meta
  line, permission pill, tap → detail, long-press rename / retry / remove
  with confirmation, "+" / button → `AddMachineSheet` with the command, Copy,
  countdown, "Generate new code", unreachable / connect-unavailable notices
  and the waiting / connected row); Machine detail (header meta, rename row +
  header pencil → `MachineRenameSheet`, `PermissionModePicker` → ceiling
  PATCH, projects on this machine, bb agent update status + Retry, provider
  CLIs with refresh + install runner + `ProviderCliInstallLogSheet`, Remove
  with confirmation). `src/screens/shell/use-now.ts` (`useNow`).
- **Tests** (vitest, pure): `host-display`, `add-machine`,
  `provider-cli-install` (issues, accumulator, store), `permission-ceiling`,
  `settings-models`, `update-inventory-model`, `realtime-invalidation`
  (updated).
- **e2e**: `phase7-settings.yaml` (+ `phase7-settings-reset.js`,
  `phase7-settings-assert.js`, `phase7-machine-name.js`): experiment toggle
  persisted (UI re-open + API), palette → Nord (row, API, re-tint), Machines
  → detail → rename → list, then everything restored, safe on a shared
  backend.

Carried forward (agent A): provider CLI Install / Update, Remove machine,
Retry update, the permission-ceiling write and the CLI skills install were not
driven on device (the harness host is this Mac's in-process daemon with every
CLI up to date; installing CLI skills would write to `~/.agents/skills`) —
unit-tested and mirrored from the web; `hostNeedsUpdate` /
`hostCanRetryUpdate` compare against the app's bundled
`HOST_DAEMON_PROTOCOL_VERSION` like the web, so a server on another version
still relies on the server's 409.

## Phase 7 — integration + verification pass (2026-08-19) → M4

Independent verifier / integrator for the three Phase 7 agents and the whole
branch. Nothing committed.

- Integration: agents A and B had already landed their shared edits on the
  same files (`SettingsScreen.tsx` Extensions rows + Haptics row,
  `hrefs.ts`, `RootNavigator.tsx`, `query-keys.ts`,
  `realtime-invalidation.ts` + test); no conflicts remained. Every
  `Stack.Screen` has its route file. `pnpm exec turbo run typecheck lint
test --filter=@bb/mobile --filter=@bb/client-core
--filter=@bb/plugin-interaction-contracts`: green (mobile 122 files / 822
  tests, 0 lint findings — the three warnings and the rule-not-found error
  the agents reported were already gone); `typecheck lint` for `@bb/app`,
  `@bb/server`, `@bb/sdk`, `@bb/cli`, `@bb/integration-tests`: green (the
  144 `@bb/app` lint warnings are pre-existing on `main`). Prettier check on
  every changed file: clean except `docs/repository-overview.md` and the
  regenerated `packages/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`, both
  already unformatted at `HEAD`. `actionlint` on `mobile-e2e.yml` +
  `mobile-runner-probe.yml`: only the expected custom runner label.
- Full on-device regression, one fresh harness backend (41999) + Metro 8082
  with `EXPO_PUBLIC_BB_E2E=1`, iPhone 17 Pro (`5E5752AC`), Maestro 2.8.0;
  seeds: `/tmp/verify-setup-threads.sh` (the "P4b …" threads; `ask_user` /
  `approve:command echo hi` sent to "P4b live" / "P4b approval live"),
  `phase6-diff-setup.sh` for "P4b banner parent" / "P6 panel thread" / "P6
  diff", `phase6-files-setup.sh` for "Idle thread", `unread` restored on the
  Rich thread between the 4a flows, the connect stub for `phase5-connect`.
  Result, in run order:

  | flow                                                                            | result                                                                                         |
  | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
  | phase1-shell                                                                    | PASS                                                                                           |
  | smoke                                                                           | PASS                                                                                           |
  | phase5-links                                                                    | PASS                                                                                           |
  | phase4a-timeline                                                                | PASS                                                                                           |
  | phase4a-conversation-rows                                                       | PASS                                                                                           |
  | phase4a-work-rows                                                               | FAIL once (tap on "Failed workflow" did not expand), PASS on re-run; flow hardened, PASS again |
  | phase4a-diff-showcase                                                           | PASS                                                                                           |
  | phase3-threads                                                                  | FAIL (Archived row below the fold of the new settings home), PASS after the flow fix           |
  | phase3-compose                                                                  | PASS                                                                                           |
  | phase4b-send / ask-user / approve / queue / actions / thread-actions / composer | PASS                                                                                           |
  | phase4b-interactions / phase4b-approval (`-e THREAD_ID`)                        | PASS                                                                                           |
  | phase6-panel / diff / files / terminal / terminal-resume                        | PASS                                                                                           |
  | phase7-settings                                                                 | PASS                                                                                           |
  | phase7-plugins                                                                  | PASS                                                                                           |
  | phase5-connect                                                                  | FAIL 3 of 4 (see below), PASS after the flow change                                            |

  Flow fixes: `phase3-threads.yaml` scrolls to `settings-archived` (the
  Threads section moved below the fold once the Phase 7 buckets landed);
  `phase4a-work-rows.yaml` wraps the "Failed workflow" tap + status-pill
  scroll in a `retry` (the tap occasionally lands while the list is still
  settling); `phase5-connect.yaml` opens the drawer from the header toggle.

- **Bug found (not fixed): edge swipe presses the home row on a bb connect
  profile.** On a freshly enrolled connect profile, the left-edge swipe that
  opens the drawer also fires the press of the home-list row under the touch,
  so the row's thread is pushed over the open drawer (the thread at the
  swipe's y: "P4b send" at 50%, "P4b live" at 30%). Reproduced 6 of 7 times
  through the stub (single or two profiles, right after enrollment, 16 s
  later, and after a Settings round trip); never on a Direct profile (0 of
  4, same list, same swipe, same timing); a vertical drag on a row never
  presses in either mode; a 1.5 s swipe did not press (the row's 350 ms
  long-press fires first). The home hierarchy is identical in both modes and
  a JS event-loop probe showed no sustained stalls, so the drawer pan's
  native touch cancellation (`RNGestureHandlerManager
didActivateInViewWithTouchHandler`) is not reaching the row's `Pressable`
  in connect mode for a reason that was not found in this pass. Repro: run
  `phase5-connect.yaml` up to the "Done" tap, then `swipe 2%,50% → 70%,50%`
  and watch for a thread screen. Worth an upstream-style investigation
  (react-native-drawer-layout pan vs the RN responder) before a release:
  a user who pairs through bb connect and edge-swipes will open a thread
  they did not tap.
- Screenshots in `/tmp/p7-verify/`: settings home (two pages), Appearance +
  palette sheet + Nord applied, Machines, machine detail, Add machine sheet,
  Updates, Usage limits, General, Marketplaces, Skills library, Plugins
  (harness: empty state; dev server: the 14 builtins, Provider retry detail
  with the settings form enabled and the disabled-settings state,
  Automations detail + logs), Browse catalog; contact sheets
  `contact-sheet.png` / `contact-sheet-plugins.png`. The provider-retry
  plugin on the checkout's dev server (20304) was enabled for the settings
  form screenshot and disabled again through the API.
- Docs: this entry + the "Status" block at the top of this log, the README
  status paragraph and the `phase5-connect` note.

Carried forward: the connect-mode edge-swipe press-through above; the Phase
7 agents' items (harness has no plugin service → plugin detail / settings
form / logs covered by the manual dev-server flow only; inbound share needs
the `expo-share-intent` native rebuild; provider CLI install / remove machine
/ CLI skills install not driven on device; the runner probe and the first
`Mobile E2E` run need the workflows on `main`); a CI flow set that also runs
the Phase 7 flows would need the harness seeds `ci-run-flows.sh` does not
create yet.

## Navigation — drawer removed, home is the root (2026-08-20)

What changed: the left drawer (`app/(drawer)/`, `expo-router/drawer`,
`DrawerContent.tsx`) is gone. Home (`app/index.tsx`) is the root of the
native stack. The drawer duplicated the home thread list; its only unique
jobs — server switcher, Settings, display options, archived — moved to a
**workspace menu**: the header's left avatar (the active server's initials
with the realtime dot, `home-workspace-menu`) opens a bottom sheet
(`src/screens/shell/WorkspaceMenu.tsx`) with the server rows, Add server,
Archived threads, Settings (and UI gallery under E2E). Search and display
options stay in the header's right slot. `SidebarActionsProvider` lost
`onBeforeNavigate` and `SidebarThreadList` / `SidebarThreadRowView` lost
`selected` (only the drawer highlighted the open thread).

Why: on a phone the thread list is the home screen; a second copy of it in a
drawer costs an edge gesture and a scrim, and the connect-mode edge-swipe
press-through (Phase 7 integration note) goes away with it. Concept
mockups for the alternatives (root home, bottom tabs, title thread switcher,
inbox-first home) were made in this thread; "root home" was chosen as the
smallest change. A title-tap thread switcher is the follow-up if
thread-to-thread jumps turn out to be frequent.

Flows: every `drawer-*` step now runs `e2e/subflows/open-settings.yaml`
(avatar → `workspace-settings`); `phase1-shell` asserts the sheet's profile
label / "Connected" / Add server; `phase3-threads` searches from
`home-search`; `phase5-connect` no longer needs the header-toggle workaround.
Verified: `turbo run typecheck lint test --filter=@bb/mobile` (813 tests).
Not driven on device in this pass: the Maestro flows above.
