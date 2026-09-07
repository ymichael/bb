## Settings surface (apps/app)

Settings buckets are declared in `apps/app/src/components/settings/settings-nav.tsx:18-34`: general, appearance, keyboard, usage, files, machines, updates, marketplaces, experiments, community, archived; plus per-provider pages `codex`/`claude-code` (`:40-43`) and per-plugin pages `/settings/plugins/:pluginId` for enabled plugins with `hasSettings` or a `settingsSection` slot (`:130-142`). The `files` bucket is hidden unless a local daemon is reachable, loopback access is available, or a plugin file opener exists (`:120-127`). Route constants: `apps/app/src/lib/route-paths.ts:6-16` (`/settings`, `/settings/:section`, `/settings/plugins/:pluginId`, `/settings/providers/:providerId`, `/settings/machines/:hostId`). `SettingsView` dispatches per bucket at `apps/app/src/views/SettingsView.tsx:1068-1309`.

### Server-persisted (visible to any client)
All served by `GET /system/config` (`packages/server-contract/src/api/system.ts:197-233`) and written by `PUT /settings/general|keyboard|experiments|appearance` (`packages/server-contract/src/public-api.ts:1332-1358`; SDK `packages/sdk/src/areas/system.ts:207-217`, `theme.ts:53`):
- `AppSettings` (`packages/domain/src/app-settings.ts:7-51`): showKeyboardHints, steerActiveThreadOnEnter, showUnhandledProviderEvents, codexMemoryEnabled, claudeCodeMemoryEnabled, codexSubagentsDisabled, claudeCodeSubagentsDisabled, claudeCodeWorkflowsDisabled, onboardingCompletedAt. Used by General (`SettingsView.tsx:1256-1299`), Provider pages (`:930-991, 1107-1150`), Debug (`:903-917`).
- Experiments (`packages/domain/src/experiments.ts`): changelogPreview, editMessages, mobileApp, timelineWindowing.
- Appearance palette + favicon color (`packages/domain/src/app-theme.ts:122-134, 145-160`); custom themes are server-resolved CSS strings; built-ins are CSS-with-`color-mix` in `apps/app/src/lib/themes/*.ts` (e.g. `nord.ts:9-45`).
- Keybinding overrides (`packages/domain/src/app-keybindings.ts:232-249`; `KeyboardSettingsSection.tsx`, uses `navigator.platform` at `:63-65`).
- Hosts: `GET/PATCH/DELETE /hosts/:id`, `PATCH /hosts/:id/permission-ceiling`, `POST /hosts/:id/retry-update`, `POST /hosts/join-codes` (`packages/server-contract/src/api/hosts.ts:59-100`; `MachinesSettingsSection.tsx:200-375`; `MachineSettingsView.tsx:165-471`).
- Plugin settings: `GET/PUT /plugins/:id/settings` with descriptors `string|boolean|select|project` (`packages/server-contract/src/api/plugins.ts:318-368`; `apps/server/src/routes/plugins.ts:477-483`); marketplaces `GET/POST/DELETE /marketplaces`, `POST /marketplaces/refresh` (`apps/server/src/routes/plugin-catalog.ts:113-148`).
- Usage limits `GET /system/usage-limits?hostId` (`UsageLimitsSettingsSection.tsx:41-63`: codex, claude-code, acp-cursor). Version `GET /system/version?force` (`system.ts:258-278`). CLI skills `GET /system/cli-skills`, `POST /system/cli-skills/install` (`system.ts:297-356`).
- Archived threads: thread list/search/unarchive (`ArchivedThreadsSettingsSection.tsx:102-119`).

### Browser-local (NOT visible to native unless re-implemented)
Backed by `window.localStorage` via `apps/app/src/lib/browser-storage.ts:32-45` (jotai `atomWithStorage`): light/dark mode `bb.theme` (`hooks/useTheme.ts:11`), `bb.openLinksInAppBrowser` (desktop-only toggle, `SettingsView.tsx:859-864`), `bb.rewriteLocalhostLinks`, `bb.promptbox.rich-text-editing`, `bb.root-compose.navigate-after-create`, `bb.fileOpenerByExtension`, `bb.voiceInput.audioInputDeviceId`, `bb.workspaceOpenTarget`/`bb.fileOpenTarget`, `bb.sidebar.threadListProvider`, `bb.splitLayout.*` (`lib/split-layout/atoms.ts:38-77`), sidebar collapse/order keys (`components/sidebar/sidebarCollapsedAtoms.ts:7-21`), prompt drafts, thread-creation selections, browser history. Voice input mic picker uses `navigator.mediaDevices` (`hooks/useAudioInputDevices.ts:17-109`).

## Host-daemon–coupled flows (cannot work from a phone)
- Local daemon probe: loopback `http://127.0.0.1:<hostDaemonPort>` (`lib/api-host-daemon.ts:24-31`; `lib/system-config-atoms.ts:169-283`); requires browser local-network permission. Phones: "no helper; editor-launch actions are simply unavailable" (`docs/multiple-devices.md:70`).
- Native folder picker `POST /hosts/:id/pick-folder` returns 409 unless `clientHostId === hostId` (`apps/server/src/routes/hosts.ts:266-284`; `hooks/useLocalPathPicker.tsx:110-125`).
- Open in editor / workspace open targets via daemon `open-in-target` (`api-host-daemon.ts:51-84`; `hooks/useLocalOpenTargets.ts`); Files → "Local editor integration" section (`SettingsView.tsx:449-551`).
- Works remotely (server-routed): in-app path browser `GET /hosts/:id/directory` + `POST /files/mkdir` (`components/dialogs/RemotePathBrowser.tsx:1-13,137`), `ProjectMachineSetupDialog` (clone default path / paths exist), `ProjectPathDialog` manual path entry, AddMachineDialog pairing command (`AddMachineDialog.tsx:154-165`; needs connect machine code RPC or non-loopback serverUrl, `:279-294`), provider CLI install stream `POST /hosts/:id/provider-clis/install` NDJSON (`hosts.ts:299-317`).
- Desktop-only: in-app browser toggle, Electron updater (`UpdatesSettingsSection.tsx:689-700`, `useDesktopUpdateInfo`).

## Onboarding
`OnboardingHost.tsx:58-213`: shown only when `experiments.newOnboarding && onboardingCompletedAt === null && primaryHost` (`:76-79`); calls `GET /system/onboarding/agents|repos`, `POST /system/onboarding/event` (`system.ts:126-195`), installs CLIs via provider-cli runner, creates `local_path` projects (`:140-151`); `OnboardingFlow.tsx` is a Radix Dialog with `ProjectPathDialog` (`:21, 604-612`).

## Notifications / attention
- Toasts: sonner wrapper `components/ui/app-toast.tsx`; global mutation error toast `lib/query-client.ts:121-136`; 29 call sites.
- Unread model: `Thread.lastReadAt`/`latestAttentionAt` (`packages/domain/src/thread.ts:393-394`), `ThreadListEntry.hasPendingInteraction` (`:408`); `isThreadRead` (`lib/thread-read-state.ts:5-7`); read tracking depends on document visibility (`hooks/useThreadReadTracking.ts:42-46`); mark read/unread `POST /threads/:id/read|unread` (`public-api.ts:1203-1209`).
- Favicon dot + `document.title` (`components/layout/AppLayout.tsx:731-740, 818-821`; pure logic in `faviconAttentionDot.ts:50-75`). Sidebar row glyphs unread-success/unread-error/pending (`components/sidebar/ThreadRow.tsx:282-310,408-432`). Updates badge in sidebar footer (`AppSidebar.tsx:342-400`, `SidebarUpdatesBadge.tsx`).
- Global attention route `GET /system/attention` (`system.ts:235-240`; `packages/db/src/data/threads.ts:1176-1202` = unread OR pending interaction) — exposed in SDK (`system.ts:137`) but unused by web app; ideal for a native badge.
- Pending interactions: approval(command/file_change/permission_grant/plan), user_question, plugin (`packages/domain/src/pending-interactions.ts:126-183, 302-345, 536-541`); routes `/threads/:id/interactions[/:id/resolve|respond|cancel]` (`public-api.ts:1149-1179`); plugin-rendered ones: ask-user-question (`plugins/ask-user-question/app.tsx:562`) and secrets (`plugins/secrets/app.tsx:218`, payload `plugins/secrets/src/contracts.ts:5-30`).
- Feed: WebSocket `/ws` via partysocket (`lib/ws.ts:56-68`), subscribe targets `thread-detail|thread-list|project-*|environment-*|host-*|system` (`packages/domain/src/change-kinds.ts:68-118`), change kinds incl. `interactions-changed`, `read-state-changed`, `host-connected`, `config-changed`, `plugins-changed` (`:8-60`), thread metadata `hasPendingInteraction` (`:172-180`); config refetch on `config-changed` (`system-config-atoms.ts:118-135`).
- Absent: no service worker/PushManager/`new Notification`/audio cues (grep negative; only `AudioContext` in `WaveformVisualizer.tsx:119`); desktop has no OS notifications either.

## Plugin frontends (what UI they add)
Loaded as ESM bundles with shared react-dom runtime + CSS `<link>` (`lib/plugin-frontend.ts:2-3, 333-351, 917`) — not loadable in RN. Slots: automations navPanel (`plugins/automations/app.tsx:876`), tasks navPanel+threadPanelAction+messageDirective (`plugins/tasks/app.tsx:8-31`), docs navPanel+threadPanelAction+fileOpener(md)+messageDirective (`plugins/docs/app.tsx:2222-2250`), github navPanel+threadPanelAction (`plugins/github/app.tsx:2494-2507`), side-chat messageAction+threadPanelAction (`plugins/side-chat/app.tsx:322-337`), memory/custom-instructions/keep-awake settingsSection (`memory/app.tsx:399`, `custom-instructions/app.tsx:137`, `keep-awake/app.tsx:283`), connect settingsSection "Remote access" + sidebarFooterAction (`plugins/connect/app.tsx:1178-1190`; RPCs pair/status/disconnect/expose/unexpose/createMachineCode `plugins/connect/src/rpc.ts:110-135`). Backend RPCs are reachable via `POST /plugins/:id/rpc/:method` (`apps/server/src/routes/plugins.ts:610`) so native can build its own UI: automations_* (`plugins/automations/src/rpc.ts:23-75`), tasks contract (`plugins/tasks/shared/contract.ts:412-769`), memory listMemories/updateMemory/deleteMemory (`plugins/memory/server.ts:87-95`), custom-instructions get/save (`server.ts:21-22`), docs (`server.ts:267-455`), github (`server.ts:139-257`).

## Feature checklist for planner
MVP: system config read (general/experiments/appearance/keybindings), toggle general+experiments+provider settings, light/dark (native-local), machines list/rename/remove/permission ceiling, usage limits, archived threads, unread/pending indicators + `/system/attention` badge, in-app toast for mutation errors, WS subscribe for thread/host/system, pending-interaction approval + user_question native forms.
v1: add machine (join code + connect machine code), remote path browser + project sources, plugin list/enable/disable/settings form, marketplaces, updates inventory (version + provider CLI status/install stream), CLI skills install, palette picker (map built-in palettes to native tokens), voice transcription upload, native remote-access (connect status/pair) via plugin RPC, secrets interaction form, community links.
Later: onboarding flow, keyboard shortcut editor, file openers/thread-list-provider preferences, plugin nav panels (automations/tasks/docs/github) as native screens or webview, push notifications (needs new server infra), custom CSS themes.

## Key files
- apps/app/src/components/settings/settings-nav.tsx
- apps/app/src/views/SettingsView.tsx
- apps/app/src/views/MachineSettingsView.tsx
- apps/app/src/components/settings/MachinesSettingsSection.tsx
- apps/app/src/components/settings/UpdatesSettingsSection.tsx
- apps/app/src/components/settings/KeyboardSettingsSection.tsx
- apps/app/src/components/settings/UsageLimitsSettingsSection.tsx
- apps/app/src/components/settings/FileOpenersSettingsSection.tsx
- apps/app/src/components/settings/VoiceInputSettingsSection.tsx
- apps/app/src/components/settings/CliSkillsSettingsSection.tsx
- apps/app/src/components/settings/MarketplacesSettingsSection.tsx
- apps/app/src/components/settings/ArchivedThreadsSettingsSection.tsx
- apps/app/src/components/plugin/PluginSettings.tsx
- apps/app/src/components/dialogs/AddMachineDialog.tsx
- apps/app/src/components/dialogs/ProjectPathDialog.tsx
- apps/app/src/components/dialogs/RemotePathBrowser.tsx
- apps/app/src/components/dialogs/ProjectMachineSetupDialog.tsx
- apps/app/src/components/onboarding/OnboardingHost.tsx
- apps/app/src/components/onboarding/OnboardingFlow.tsx
- apps/app/src/hooks/useLocalPathPicker.tsx
- apps/app/src/hooks/useHostDaemon.ts
- apps/app/src/lib/system-config-atoms.ts
- apps/app/src/lib/api-host-daemon.ts
- apps/app/src/lib/browser-storage.ts
- apps/app/src/hooks/useTheme.ts
- apps/app/src/lib/ws.ts
- apps/app/src/components/ui/app-toast.tsx
- apps/app/src/lib/query-client.ts
- apps/app/src/components/layout/AppLayout.tsx
- apps/app/src/components/layout/faviconAttentionDot.ts
- apps/app/src/lib/thread-read-state.ts
- apps/app/src/hooks/useThreadReadTracking.ts
- apps/app/src/components/sidebar/ThreadRow.tsx
- apps/app/src/components/sidebar/SidebarUpdatesBadge.tsx
- apps/app/src/hooks/useUpdateInventory.ts
- apps/app/src/lib/plugin-frontend.ts
- apps/app/src/lib/plugin-slots.ts
- packages/domain/src/app-settings.ts
- packages/domain/src/experiments.ts
- packages/domain/src/app-theme.ts
- packages/domain/src/app-keybindings.ts
- packages/domain/src/change-kinds.ts
- packages/domain/src/pending-interactions.ts
- packages/domain/src/thread.ts
- packages/server-contract/src/api/system.ts
- packages/server-contract/src/api/hosts.ts
- packages/server-contract/src/api/plugins.ts
- packages/server-contract/src/public-api.ts
- apps/server/src/routes/system.ts
- apps/server/src/routes/hosts.ts
- apps/server/src/routes/plugins.ts
- apps/server/src/routes/plugin-catalog.ts
- packages/db/src/data/threads.ts
- packages/sdk/src/browser.ts
- packages/sdk/src/core.ts
- packages/sdk/src/realtime-url.ts
- packages/sdk/src/areas/system.ts
- packages/sdk/src/areas/hosts.ts
- packages/sdk/src/areas/plugins.ts
- packages/connect-client/src/desktop-session.ts
- packages/connect-client/src/redeem-machine.ts
- plugins/connect/app.tsx
- plugins/connect/src/rpc.ts
- plugins/automations/app.tsx
- plugins/automations/src/rpc.ts
- plugins/tasks/app.tsx
- plugins/tasks/shared/contract.ts
- plugins/docs/app.tsx
- plugins/github/app.tsx
- plugins/side-chat/app.tsx
- plugins/ask-user-question/app.tsx
- plugins/secrets/app.tsx
- plugins/secrets/src/contracts.ts
- plugins/memory/app.tsx
- plugins/custom-instructions/app.tsx
- plugins/keep-awake/app.tsx
- docs/multiple-devices.md

## Reuse verdicts
- @bb/sdk (packages/sdk/src/browser.ts, core.ts, areas/*): **reusable-with-small-changes** — Pure fetch+zod+hono/client; must pass explicit baseUrl and websocket factory (realtime-url.ts:44-48 falls back to global `location`; realtime-client.ts:163-166 uses global WebSocket which RN provides). Depends on @bb/core-ui (pure TS), @bb/templates/generated, @bb/config. transcribeVoice uses multipart FormData/Blob (system.ts:188). Verify hono/client + zod v4 on Hermes.
- @bb/domain, @bb/server-contract, @bb/host-daemon-contract/local (schemas/types): **reusable-as-is** — zod-only schemas (app-settings.ts, experiments.ts, app-theme.ts, change-kinds.ts, pending-interactions.ts). server-contract imports hono types only for typing.
- @bb/core-ui: **reusable-as-is** — Pure TS (assert-never, environment-display, pending-interaction formatting, unknown-helpers); only depends on @bb/domain.
- @bb/connect-client: **reusable-as-is** — fetch+zod (desktop-session.ts:21-59, redeem-machine.ts:76+). Needed for phone auth against connect gate.
- apps/app/src/lib/browser-storage.ts and all localStorage-backed preference atoms: **not-reusable** — window.localStorage/sessionStorage and `storage` event (browser-storage.ts:32-73). Replace with AsyncStorage/MMKV jotai storage adapter; keys/defaults can be copied.
- apps/app/src/lib/ws.ts (WebSocketManager): **reusable-with-small-changes** — URL built from window.location (ws.ts:58-60); otherwise partysocket ReconnectingWebSocket + lenient schema dispatch. Verify partysocket on RN or swap for RN reconnect logic.
- apps/app/src/components/settings/* and views/SettingsView.tsx, MachineSettingsView.tsx: **not-reusable** — Radix DropdownMenu/Switch/Dialog, Tailwind classes, react-router Link/useLocation, navigator.platform (KeyboardSettingsSection.tsx:63-65), navigator.mediaDevices (useAudioInputDevices.ts). Extract headless logic: settings-nav constants, host-update-status, relative-time, keyboard-shortcut-settings, summarizeMachineStatuses (CliSkillsSettingsSection.tsx:41-57).
- apps/app/src/hooks/useUpdateInventory.ts: **reusable-with-small-changes** — react-query only, but imports useDesktopUpdateInfo (desktop bridge) and provider-cli-install helpers; strip desktop branch.
- apps/app/src/lib/system-config-atoms.ts / useHostDaemon.ts / api-host-daemon.ts / useLocalOpenTargets.ts / useLocalPathPicker.tsx: **not-reusable** — Loopback daemon probing (127.0.0.1:<port>), window.location.hostname, browser local-network permission; the feature itself is meaningless on a phone (docs/multiple-devices.md:70).
- apps/app/src/components/dialogs/RemotePathBrowser.tsx logic (toBreadcrumb, joinHostPath, getFolderNameValidationMessage): **headless-logic-only** — Pure functions at lines 24-66 reusable; component uses Radix/Tailwind and react-query hooks over server routes (works remotely).
- apps/app/src/components/dialogs/AddMachineDialog.tsx: **headless-logic-only** — pairingCommand()/createConnectMachineCode() logic (lines 45-165) reusable; UI is Radix Dialog + clipboard + react-router Link.
- apps/app/src/components/onboarding/*: **not-reusable** — Radix Dialog, ProjectPathDialog, provider-cli install runner; also requires a primary host and newOnboarding experiment. Server routes are reusable.
- apps/app/src/components/ui/app-toast.tsx (sonner): **not-reusable** — sonner is DOM-only; keep AppToastTone/options API shape and back it with an RN toast lib.
- apps/app/src/components/layout/faviconAttentionDot.ts + lib/thread-read-state.ts: **headless-logic-only** — Pure functions; the favicon/document.title effects (AppLayout.tsx:731-821) are DOM. useThreadReadTracking uses document visibility (needs AppState adapter).
- apps/app/src/lib/themes/*.ts (built-in palettes): **not-reusable** — CSS custom-property strings using color-mix(in oklch) (nord.ts:9-45); native needs a token map derived from --canvas/--ink anchors. Server custom themes are arbitrary CSS and cannot apply.
- Plugin frontends (plugins/*/app.tsx via @get-bb/plugin-sdk/app): **not-reusable** — Delivered as ESM bundles dynamic-import()ed with a shared react-dom runtime and CSS <link> (apps/app/src/lib/plugin-frontend.ts:2-3,333-351,917); use @bb/shared-ui (Radix/Tailwind), sonner, qrcode data URLs. Backend RPC contracts (POST /plugins/:id/rpc/:method) are reusable for native re-implementations.
- Server routes for settings/hosts/plugins/marketplaces/skills (apps/server/src/routes/*): **reusable-as-is** — All JSON over HTTP; provider CLI install returns NDJSON stream (hosts.ts:311-317) which needs a streaming fetch reader on RN.

## Risks
- Authentication: the bb HTTP API is unauthenticated on loopback; remote access requires a bb connect account session (docs/multiple-devices.md:14-18,39-42). A native app needs a first-class credential flow (connect machine credential redeem + desktop-session cookie, packages/connect-client/src/redeem-machine.ts:76, desktop-session.ts:21-59, connect RPC createDesktopSession/createMachineCode plugins/connect/src/rpc.ts:130-131) — none of this exists in apps/app today.
- No push infrastructure: no service worker, PushManager, web-push, APNs/FCM anywhere (grep negative across apps/app, apps/server, apps/connect, plugins/connect); background notifications require new server/connect work. Only in-session signals exist (WS changed messages, GET /system/attention).
- Plugin UI parity: 14 plugin frontends (~10.7k lines: docs 2251, github 2508, automations ~2.6k, connect 1192, tasks multi-file) render through the DOM plugin runtime; native must reimplement key ones over plugin RPC or embed a webview, or accept feature gaps (automations, tasks, docs, github, side-chat, remote-access settings, memory, custom-instructions, keep-awake).
- Two pending-interaction kinds are plugin-rendered (ask-user-question, secrets); a native app must implement user_question and secret-request forms natively or threads block on the phone.
- Client-local settings live in localStorage with keys like bb.theme, bb.rewriteLocalhostLinks, bb.promptbox.rich-text-editing; a native app will not share these with the web/desktop and must decide per-key whether to mirror locally.
- Theme palettes are CSS (color-mix in oklch); native must hand-map the six built-ins and cannot honor server custom CSS themes or plugin themes.
- Files/Machines/Updates settings depend on host daemon RPCs (provider CLI status/install, directory listing, native picker); offline hosts and 409 native_picker_unavailable paths need explicit native handling.
- Read tracking relies on document visibility (useThreadReadTracking.ts:42-46); RN needs AppState/focus equivalents to avoid marking threads read while backgrounded.
- Realtime: partysocket + browser WebSocket assumptions (ws.ts:56-68); backgrounded iOS apps drop sockets, so reconnect + resubscribe + query invalidation on foreground must be designed in.
- Provider CLI install and voice transcription use NDJSON streaming and multipart uploads respectively; verify RN fetch streaming/FormData behavior.

## Open questions
- Should the native app expose 'open in editor'/'open folder' at all, and if so target the primary/work machine (via new server routes) rather than the client device as the web app does?
- Which plugin surfaces are must-have natively (automations, tasks, github, docs, side-chat, remote-access) versus deferred, given each needs a native reimplementation over POST /plugins/:id/rpc/:method?
- How will a phone authenticate to a bb server: connect account session (cookie), a new machine-credential header flow, or a Tailscale/direct URL mode with no auth? Does the server need a bearer-token mode for native clients?
- Is push notification delivery in scope (would require new server/connect infra keyed off /system/attention or interactions-changed events)?
- Should client-local preferences (light/dark, rewrite localhost links, rich text editing, navigate-after-create) be promoted to server-persisted AppSettings so web/desktop/native stay in sync?
- Should partysocket be reused in RN or replaced with a purpose-built reconnecting WebSocket that handles AppState transitions?
- Onboarding requires a primary host and the newOnboarding experiment — should native skip onboarding entirely or provide a connect-based 'pair to your server' first-run instead?
