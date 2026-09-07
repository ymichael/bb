## Global shell (apps/app/src/main.tsx, App.tsx)
Providers, outer→inner: `AppErrorBoundary` (main.tsx:60; class boundary, fallback uses `window.location.reload`) → `QueryClientProvider` (`createAppQueryClient` + `installAppQueryClientBrowserEvents` binds window focus/visibility/pagehide, lib/query-client.ts:36-103) → `BrowserRouter` → `App` + `AppToaster` (sonner, main.tsx:64). Jotai has NO Provider (default store; `atomWithStorage` on localStorage keys `bb.*`, ~50 keys). Pre-render side effects: `installForeignDomMutationGuard`, `initializePreferredTheme` (localStorage `bb.theme` + `documentElement.classList`, hooks/useTheme.ts:36), `applyCachedAppThemeCss`, `initializeFavicon`, `takeOverPanelResizeCursor` (main.tsx:23-43). `App` (App.tsx:332): `useWebSocket` (realtime invalidation via `wsManager`), `useDesktopThemeSync` (Electron), `useAppTheme` (server palette CSS), `useFaviconColorSync`, `usePluginFrontendBoot` (dynamic `import(url)` of plugin ESM bundles + `<link>` CSS injection, lib/plugin-frontend.ts:340-351,917). Wrappers: `QuickCreateProjectProvider` → `AppCommandProvider` (window keydown dispatcher, App.tsx:348) → `RouteNavigationProvider` → `HashNavigationScroll` (MutationObserver/scrollIntoView, App.tsx:170) → routes; plus global `ProviderCliInstallLogDialogHost` and `OnboardingHost` (App.tsx:361-364).

## Routes (App.tsx:216-357, lib/route-paths.ts)
| Path | Component | Purpose |
|---|---|---|
| `/auth/callback?status=` | AuthCallbackView | OAuth result card (no shell) |
| `/settings`, `/settings/:section` | SettingsView | sections: general, appearance, keyboard, usage, files, machines, updates, marketplaces, experiments, community, archived (settings-nav.tsx:19-31) |
| `/settings/providers/:providerId` | SettingsView → ProviderSettingsSection | codex / claude-code toggles |
| `/settings/plugins` | redirect → `/extensions/plugins?view=installed` |  |
| `/settings/plugins/:pluginId` | SettingsView → PluginSettingsPage | plugin config |
| `/settings/machines/:hostId` | MachineSettingsView | permission limit cards, details, rename/remove |
| `/projects/:projectId/settings` | ProjectSettingsView | Project Sources list, add/edit/remove |
| `/projects/:projectId/archived`, `/archived` | redirect → `/settings/archived` |  |
| `/extensions` → `/extensions/plugins`; `/extensions/plugins/:pluginId`; `/extensions/skills`, `/extensions/skills/library/:skillId`, `/extensions/skills/registry[/:id]` | ToolsView | Plugins browse/installed (`?view=installed|create`), Skills browse/library |
| `/tools/*`, `/skills`, `/automations*` | legacy redirects | automations now `/plugins/automations/automations[/browse|/:projectId/:automationId[/edit]]` |
| `*` | SplitWorkspaceRoute (views/SplitWorkspaceRoute.tsx:23) | `/` → RootComposeView (new-thread pane); `/threads/:threadId` & `/projects/:projectId/threads/:threadId` → ThreadDetailView; `/plugins/:pluginId/:panelPath/*` → PluginPanelView; `/projects/:projectId` → LegacyProjectComposeRedirect (sets root-compose project atom, RootComposeView.tsx:590); unknown → `/` |

## AppLayout (components/layout/AppLayout.tsx)
`SidebarProvider` + `AppLayoutSidebar` (mode app/settings/tools, AppLayoutSidebar.tsx:47-77) + `SidebarInset` + `AppHeader` (hidden on thread/root/plugin-panel routes, AppLayout.tsx:576) + fixed `SidebarTriggerOverlay` (AppLayout.tsx:218) + global `ProjectPathDialog` (AppLayout.tsx:877). Handles commands `sidebar.toggle`, `thread.new`, `settings.open`, `settings.openServers` (AppLayout.tsx:174,481-495), `wsManager.onThreadOpen` navigation, favicon badge, `document.title`. Sidebar width/open persisted (`bb.sidebar.width|open`, AppLayout.tsx:96-144); resize handle desktop-only (`hidden md:block`, AppSidebar.tsx:404); mouse-only resize (AppLayout.tsx:742-812). Compact viewport = `(max-width: 767px)` (`useIsCompactViewport`, shared-ui hooks/use-compact-viewport.tsx:10); sidebar becomes swipe-open/drag-close overlay drawer (`SidebarMobilePanel`, components/ui/sidebar.tsx:20,732-754,1065). iOS keyboard viewport fixups: `useMobileVisualViewportHeight` (AppLayout.tsx:410).

## App sidebar (components/sidebar/AppSidebar.tsx)
Rows: history back/forward (top reserve), "New thread" (+ split mini-map desktop) + thread search (AppSidebar.tsx:314-327; `useSidebarThreadSearch`), `PluginNavSidebarItems` (Extensions row + plugin navPanels, reorder/hide via `bb.sidebar.pluginPanelOrder|hiddenPluginPanels`), `PluginThreadList` → `ProjectList` (org modes project/machine/manual + sort updated/created/alpha via `SidebarDisplayOptionsMenu`, ProjectList.tsx:621-739; section create/rename/delete dialogs ProjectList.tsx:1979-2012; Pinned section; dnd-kit drag reorder), footer: Settings link, plugin footer actions, Report bug (external), `SidebarUpdatesBadge`. ThreadRow kebab hidden on compact+coarse (`max-md:pointer-coarse:hidden`, ThreadRow.tsx:821); Radix ContextMenu (long-press) still wraps rows (ThreadRow.tsx:854). Thread menu items: Open in split, Mark read/unread, Pin/Unpin, Rename, Archive/Unarchive, Delete (ThreadActionsMenu.tsx:175-248). Project menu: Project settings, Rename, Add local path, Remove (ProjectActionsMenu.tsx:130-169). Section header actions: display options, New project, New section, New thread (ProjectList.tsx:566-617). Keyboard: `thread.search`, `thread.jump.N`, `thread.previous/next` handled here (AppSidebar.tsx:221-230).

## Root compose `/` (views/RootComposeView.tsx)
`NewThreadComposer` (project/env/branch/worktree/machine/model/permission pickers, NewThreadPromptBox.tsx:418-573) with fork/handoff seeds from `location.state`; empty-projects welcome (RootComposeEmptyWelcome.tsx: New thread / Import projects / New project / Learn); `RootComposeMobileRecents` (`md:hidden`, 3 recent threads, RootComposeMobileRecents.tsx:181); `RootComposeSecondaryContent` = same right panel as threads (files, terminal, new-tab, browser[desktop], plugin tabs; no Info/Diff, RootComposeView.tsx:2345-2381) rendered as bottom drawer on compact (SecondaryPanelLayout.tsx:105); pinned panel toggle; `ProjectMachineSetupDialog`; `PluginHomepageSections`. Commands: panel.newTab, file.quickOpen, terminal.open, workspace.openPreferred, panel.toggle/close (RootComposeView.tsx:1471-1908, RootComposePanelCommandHandlers.tsx).

## Thread detail (views/thread-detail/ThreadDetailView.tsx)
Header (ThreadDetailHeader.tsx): inline-editable title (dbl-click), child/side-chat pill, ThreadActionsMenu, plugin header actions, workspace "Open in" split button, commit action button → `ThreadGitActionDialog`, right-panel toggle (icon PanelBottom on compact, :162), pane maximize/close (split only). Body: `EmbeddedThreadChat` timeline + `ThreadTableOfContents` overlay + `ThreadDetailPromptArea` footer (pending-interaction banner, workflow/background-commands/todo/goal/mode/model-fallback cards, context banner sections git/parentThread/childThreads, queued messages, FollowUpPromptBox with compact-mode expansion on mobile, FollowUpPromptBox.tsx:380-401). Right panel fixed tabs Info (ThreadMetadataContent rows: Parent, Forks, Environment, Directory, Branch, PR, Merge base, Git status, Archived, Commits, Changed files, Thread storage) and Diff (@pierre/diffs + Worker pool), plus file previews (workspace/host/storage), terminal (xterm), new-tab (file search + Open browser[desktop-only, NewTabFileSearch.tsx:842] + Start terminal + plugin actions), plugin panel tabs (fixed-panel-tabs-state.ts:204-298). Splits (SplitThreadArea) disabled on compact (`useSplitWorkspaceActive`, hooks/useSplitWorkspaceActive.ts:16-20). Commands: panel.*, file.quickOpen, terminal.open, diff.toggle, workspace.openPreferred, thread.archive/rename (ThreadDetailView.tsx:1457-1585,2259, ThreadArchive/RenameCommandHandler).

## Settings pages (views/SettingsView.tsx:1068-1309)
General: navigate-after-create, rich text editing, steer-on-Enter, open links in in-app browser (desktop-only, :859), rewrite localhost links, replay onboarding (experiment) + Skills (install CLI skills dialog) + Voice Input (mic picker) + Debug (unhandled provider events). Appearance: theme system/light/dark, palette dropdown (+ "create from prompt" navigates to `/` with `initialPrompt`), favicon color. Keyboard: hints toggle, search, rebind rows, Reset all (KeyboardSettingsSection.tsx:600-660). Usage limits (machine picker, refresh). Files: local editor integration + file openers (section only if daemon/access/openers, settings-nav.tsx:132-138). Machines: list, Add machine dialog, rename/remove dialogs, retry update. Updates: bb version rows, machines issues install. Marketplaces: add source input, list. Experiments: mock CLI traffic, edit messages, new onboarding, session reaping. Community: Discord/GitHub links. Archived threads: search + project/kind filters + unarchive. Provider pages: memory, disable subagents, disable Workflow tool (claude only). Plugin pages: `PluginSettingsPage`.

## Dialogs / pickers
All `Dialog`, `DropdownMenu`, `Popover` from @bb/shared-ui render as bottom drawers on compact (dialog.tsx:124-126,244-266; dropdown-menu.tsx:164-183; popover.tsx:151-174; `mobileTitle` prop). Dialogs: AddMachine, ConfirmDelete, EnvironmentRename, ProjectDelete, ProjectMachineSetup, ProjectPath (+RemotePathBrowser), ProjectRename, ProjectSourceDelete, ProviderCliInstallLog, Rename, ThreadDelete, ThreadGitAction, ThreadRename, ThreadSectionCreate/Rename, InstallCliSkills, MachineRename, AddPlugin, OnboardingFlow (2-step agents→projects, experiment-gated, OnboardingHost.tsx:70-80). Pickers: Branch/ModelReasoning (Popover, search hidden on compact/coarse, ModelReasoningPicker.tsx:787), Environment/Machine/Option/Worktree/ProjectSelector (DropdownMenu), PermissionMode.

## Commands & shortcuts
Command IDs: packages/domain/src/app-keybindings.ts:38-79; defaults apps/server/src/services/system/app-keybindings.ts:150-292 (web aliases: thread.new ⌘⇧O, search ⌘K, settings ⌘,, sidebar ⌘\, thread prev/next ⌃⇧[ ], jump ⌃1-9 mac / ⌘⇧1-9, panel newTab ⌘T, close ⌘W, toggle ⌘J, quickOpen ⌘P, diff ⌘D, terminal ⌘⇧Enter, composer.focus ⌘⇧C, model toggle ⌘⇧M, cycle Alt+M/P/T, workspace.openPreferred ⌘O, question 1-9, pane maximize ⌘⇧E, pane close ⌘⇧X; desktopOnly: ⌘N, ⌘⇧N window.new, browser ⌘L/⌘R). Labels/groups: lib/app-command-metadata.ts. No command palette exists; the sidebar search (⌘K) is the closest.

## URL / location state
Path params via `useRouteState` (hooks/useRouteState.ts). Query: `?view=browse|installed|create|library` (tools), `?sectionId` (archived crumbs, AppLayout.tsx:505), `?status` (auth). `location.state` keys: `focusPrompt`, `sectionId`, `initialPrompt`, `replaceInitialPrompt`, `searchMessageSeq/searchThreadId`, `reuseEnvironmentId`, `createDraftKind`, fork/handoff seed keys (lib/fork-thread-request.ts:10, lib/thread-handoff-request.ts:4). Non-URL persisted state: `bb.root-compose.project-id`, `bb.splitLayout*`, `bb.thread.fixedPanelTabsState`, `bb.sidebar.*`, `bb.promptbox.*`.

## Key files
- apps/app/src/App.tsx
- apps/app/src/main.tsx
- apps/app/src/lib/route-paths.ts
- apps/app/src/hooks/useRouteState.ts
- apps/app/src/components/layout/AppLayout.tsx
- apps/app/src/components/layout/AppLayoutSidebar.tsx
- apps/app/src/components/layout/AppPageHeader.tsx
- apps/app/src/components/sidebar/AppSidebar.tsx
- apps/app/src/components/sidebar/ProjectList.tsx
- apps/app/src/components/sidebar/ThreadRow.tsx
- apps/app/src/components/thread/ThreadActionsMenu.tsx
- apps/app/src/components/project/ProjectActionsMenu.tsx
- apps/app/src/views/SplitWorkspaceRoute.tsx
- apps/app/src/views/RootComposeView.tsx
- apps/app/src/views/RootComposeMobileRecents.tsx
- apps/app/src/views/RootComposeEmptyWelcome.tsx
- apps/app/src/views/RootComposeSecondaryContent.tsx
- apps/app/src/views/thread-detail/ThreadDetailView.tsx
- apps/app/src/views/thread-detail/ThreadDetailHeader.tsx
- apps/app/src/views/thread-detail/ThreadDetailSecondaryContent.tsx
- apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx
- apps/app/src/views/thread-detail/SplitThreadArea.tsx
- apps/app/src/hooks/useSplitWorkspaceActive.ts
- apps/app/src/components/secondary-panel/SecondaryPanelLayout.tsx
- apps/app/src/components/secondary-panel/ThreadSecondaryPanel.tsx
- apps/app/src/components/secondary-panel/ThreadMetadataContent.tsx
- apps/app/src/lib/fixed-panel-tabs-state.ts
- apps/app/src/views/SettingsView.tsx
- apps/app/src/components/settings/settings-nav.tsx
- apps/app/src/components/settings/SettingsSidebar.tsx
- apps/app/src/views/MachineSettingsView.tsx
- apps/app/src/views/ProjectSettingsView.tsx
- apps/app/src/views/ToolsView.tsx
- apps/app/src/components/tools/tools-navigation.ts
- apps/app/src/components/tools/ToolsSidebar.tsx
- apps/app/src/views/PluginPanelView.tsx
- apps/app/src/components/commands/AppCommandProvider.tsx
- apps/app/src/lib/app-command-metadata.ts
- packages/domain/src/app-keybindings.ts
- apps/server/src/services/system/app-keybindings.ts
- apps/app/src/components/onboarding/OnboardingHost.tsx
- apps/app/src/components/onboarding/OnboardingFlow.tsx
- apps/app/src/components/promptbox/NewThreadPromptBox.tsx
- apps/app/src/components/promptbox/FollowUpPromptBox.tsx
- apps/app/src/components/promptbox/PromptBoxActionsMenu.tsx
- apps/app/src/components/pickers/ModelReasoningPicker.tsx
- apps/app/src/components/pickers/BranchPicker.tsx
- apps/app/src/components/dialogs/ProjectPathDialog.tsx
- apps/app/src/components/dialogs/ThreadGitActionDialog.tsx
- apps/app/src/hooks/useQuickCreateProject.tsx
- apps/app/src/hooks/useAppSettingsRouteMemory.ts
- apps/app/src/lib/plugin-frontend.ts
- apps/app/src/lib/plugin-slots.ts
- apps/app/src/components/ui/sidebar.tsx
- packages/shared-ui/src/components/ui/hooks/use-compact-viewport.tsx
- packages/shared-ui/src/components/ui/dialog.tsx
- packages/shared-ui/src/components/ui/dropdown-menu.tsx
- packages/shared-ui/src/components/ui/responsive-overlay.tsx

## Reuse verdicts
- apps/app/src/lib/route-paths.ts: **reusable-with-small-changes** — Imports `matchPath` from react-router-dom (route-paths.ts:2) for isRoutePath/isToolsRoutePath; otherwise pure string builders. Swap matchPath for a tiny matcher or use react-router's core matchPath (which is DOM-free).
- apps/app/src/hooks/useRouteState.ts: **headless-logic-only** — Built on react-router-dom `useLocation`/`useMatch`; the mapping logic (URL -> projectId/threadId/view flags) is portable if fed a pathname string, but the hook itself assumes react-router web.
- packages/domain/src/app-keybindings.ts: **reusable-as-is** — Pure zod schemas + matching helpers; no DOM. Uses `navigator.platform` only in the app layer, not here.
- apps/app/src/lib/app-command-metadata.ts: **reusable-as-is** — Pure data table of command labels/groups.
- apps/app/src/components/commands/AppCommandProvider.tsx: **headless-logic-only** — Registers `window.addEventListener('keydown')`, queries `document.querySelector` for open modals (AppCommandProvider.tsx:93-99,179,330), uses `navigator.platform`, `HTMLElement.closest`. The handler registry/dispatch/priority pattern is portable; the key-event plumbing is web-only (RN has no global keydown; only hardware-keyboard events).
- apps/app/src/components/layout/AppLayout.tsx: **not-reusable** — Radix-based SidebarProvider, CSS variables (`--sidebar-width`), mouse resize on document.body, `document.title`, `window.requestAnimationFrame`, MutationObserver, Electron chrome classes, env(safe-area-inset) Tailwind classes.
- apps/app/src/components/ui/sidebar.tsx: **not-reusable** — DOM touch/pointer swipe implementation writing `panel.style.translate`, `inert`, `aria-modal`, Tailwind group-data variants; must be re-implemented with a native drawer (e.g. react-native-reanimated/gesture-handler).
- apps/app/src/components/sidebar/ProjectList.tsx + ThreadRow.tsx + ProjectRow.tsx: **headless-logic-only** — Heavy on @dnd-kit, Radix DropdownMenu/ContextMenu/Tooltip, CSS hover-action classes (theme.css:259-333). Reusable pieces: projectThreadGroups.ts, machineThreadGroups.ts, sortComparator.ts, threadReadState.ts, pinnedSidebarThreads.ts, sidebarThreadSearch.ts, sidebarSectionOrder.ts (pure TS).
- apps/app/src/views/RootComposeView.tsx: **headless-logic-only** — 2400-line DOM view: react-router location.state, react-resizable-panels, `window`, Tiptap composer, xterm terminal, @pierre diffs. Exported pure helpers (readSectionIdFromLocationState, shouldNavigateAfterThreadCreate, buildMobileRecentThreads, canCreateRootComposeTerminal, root-compose-branch-selection.ts, root-compose-environment-selection.ts) are portable.
- apps/app/src/views/RootComposeMobileRecents.tsx: **headless-logic-only** — getMobileRecentThreads sort/limit is pure; rendering uses react-router Link + Tailwind + ThreadStatusGlyph (SVG icons).
- apps/app/src/views/thread-detail/ThreadDetailView.tsx: **headless-logic-only** — ~3000 lines wiring DOM-only panels (xterm terminal, @pierre/diffs with Web Workers, Tiptap, react-resizable-panels, iframe/BrowserView). Data hooks (thread-queries, timeline controller, useThreadGitActions, threadQueuedMessages.ts, threadDetailPromptSubmission.ts, splitThreadNavigation.ts) are largely portable.
- apps/app/src/components/thread/timeline/*: **headless-logic-only** — Rendering via react-markdown + rehype-katex/raw/sanitize + katex CSS (markdown-preview.tsx:18-41), SVG icons, DOM selection APIs (SelectableMessageProse). Row-model/state helpers (useThreadTimelineController merge logic, timeline-auto-expand.ts, thread-context-window-usage.ts, thread-runtime-status.ts) portable.
- apps/app/src/components/promptbox/*: **not-reusable** — Tiptap/ProseMirror contenteditable editor (editor/*.ts imports @tiptap/core, starter-kit, mention), visualViewport keyboard handling, MediaRecorder voice input; needs a native rich-text/mention input replacement. Draft storage keys (`bb.promptbox.*`) and effective-prompt-mode.ts logic portable.
- apps/app/src/components/thread/terminal/*: **not-reusable** — @xterm/xterm + xterm.css (ThreadTerminalView.tsx:9-16); transport (terminal-websocket-transport.ts, terminal-websocket-url.ts) is WebSocket-based and portable, but rendering needs a native terminal view.
- apps/app/src/components/secondary-panel/BrowserTabContent.tsx / BrowserTabDeck.tsx: **not-reusable** — Electron native BrowserView API (`getDesktopBrowserApi`, BrowserTabContent.tsx:24,753); browser tab already unavailable on web (`isDesktopBrowserAvailable`, NewTabFileSearch.tsx:842). RN would use react-native-webview instead.
- apps/app/src/components/secondary-panel/SecondaryPanelLayout.tsx + ThreadSecondaryPanel.tsx: **not-reusable** — react-resizable-panels PanelGroup, shared-ui PersistentResponsiveDrawerShell (createPortal, DOM), CSS transitions; tab-state model in lib/fixed-panel-tabs-state.ts and secondaryPanelTabState.ts is pure and portable.
- apps/app/src/views/SettingsView.tsx + components/settings/*: **headless-logic-only** — Radix DropdownMenu/Switch/Tooltip, Tailwind, `document`/CSS mask for favicon preview (SettingsView.tsx:267-279), navigator.mediaDevices for voice, Electron desktop update API in UpdatesSettingsSection. Section list (settings-sections.ts SETTINGS_NAV_SECTIONS), mutations (settings-mutations), and preference hooks are portable except those on localStorage (`createLocalStorageSyncStorage`).
- apps/app/src/components/pickers/*: **headless-logic-only** — Radix Popover/DropdownMenu with compact-drawer fallbacks; pure helpers (modelPickerCycle.ts, modelPickerToggle.ts, model-picker-option.ts, environment-picker-value.ts, BranchPicker buildBranchPickerOptionGroups/orderBranchPickerOptions) portable.
- apps/app/src/components/dialogs/*: **headless-logic-only** — All built on @bb/shared-ui Dialog (Radix + createPortal). Validation helpers (useNameValidation.ts, RemotePathBrowser toBreadcrumb/joinHostPath/getFolderNameValidationMessage) portable.
- packages/shared-ui/src/components/ui/*: **not-reusable** — Radix primitives, react-dom createPortal, matchMedia (use-media-query.ts:17), Tailwind class strings, DOM focus/blur helpers (overlay-trigger). Only tokens/constants and a few pure hooks concept-portable.
- apps/app/src/lib/plugin-frontend.ts + plugin-slots.ts: **not-reusable** — Runtime dynamic `import(url)` of plugin ESM bundles, `document.head` <link> injection, `globalThis.__bbPluginRuntime` React sharing (plugin-frontend.ts:227-351,917). Hermes cannot import remote ESM; plugin UI slots (navPanels, homepage sections, composer actions, settings sections) would need a native plugin surface strategy or WebView hosting.
- apps/app/src/lib/ws.ts + hooks/useWebSocket.ts: **reusable-with-small-changes** — WebSocket-based invalidation manager; RN has global WebSocket. Verify no `window`/`document` visibility listeners inside wsManager (not read here).
- apps/app/src/lib/query-client.ts: **reusable-with-small-changes** — `createAppQueryClient` fine; `installAppQueryClientBrowserEvents` binds window/document events (query-client.ts:36-103) — replace with AppState/NetInfo listeners.
- apps/app/src/hooks/useTheme.ts / lib/themes.ts: **not-reusable** — localStorage + document.documentElement class toggling + CSS custom properties; native theming needs a token bridge.

## Risks
- The right-hand secondary panel is central to both root compose and thread detail (files, terminal, diff, info, plugin tabs, browser); its DOM stack (react-resizable-panels, xterm, @pierre/diffs w/ Web Workers, Electron BrowserView) has no RN equivalent, so a native app must re-scope which tabs ship (Info + file preview + diff are the mobile-relevant ones; terminal/browser are desktop-leaning).
- Plugin frontends (Automations, Tasks, GitHub, Docs, etc.) are loaded as remote ESM bundles into the web app (lib/plugin-frontend.ts:917) and contribute nav panels, homepage sections, composer actions, thread header actions, settings pages, thread-list replacements and file openers (lib/plugin-slots.ts:93-106). None of this can run under Hermes; the automations UI is now a plugin panel route (`/plugins/automations/automations`), so a native app either loses these surfaces or hosts them in a WebView.
- The composer is a Tiptap/ProseMirror contenteditable with mention pills, decorations, blockquote/heading/list serialization, drafts in localStorage, voice input via MediaRecorder, and iOS visualViewport tricks; replicating mention typeahead + serialization natively is a large sub-project.
- Keyboard-shortcut system (AppCommandProvider) drives many affordances (jump 1-9, panel toggles, model cycling); on touch devices these commands have no trigger, so native needs explicit UI for each command that matters on mobile (thread.new, thread.search, panel.toggle, terminal.open, diff.toggle, modelPicker.toggle, workspace.openPreferred, question.select.N).
- Thread splits, sidebar resize, pane drag/reorder, dnd-kit thread/section reordering, thread-row hover kebab, sidebar hover actions are desktop-only or hidden on compact+coarse today; the native app should not attempt them but must still expose the same actions via long-press/context menus (currently Radix ContextMenu long-press wraps rows).
- Substantial UI state is client-local (localStorage `bb.*` keys: sidebar collapse/order/mode, split layout, fixed panel tabs, prompt drafts, root-compose project id); a native app needs AsyncStorage/MMKV equivalents and must decide which of these are per-device vs. shared.
- Markdown rendering relies on react-markdown + rehype-katex/raw/sanitize + mermaid + syntax highlighting worker; RN needs a native markdown renderer with code/diff/katex/mermaid support decisions.
- Compact-viewport behavior is defined by CSS media query (max-width: 767px) and `pointer: coarse`, plus Tailwind `md:`/`max-md:pointer-coarse:` variants; behavior on iPad (>=768px, coarse) is desktop layout with touch tweaks, so a native tablet layout may differ from the PWA's.

## Open questions
- Should the native app expose plugin-contributed surfaces (nav panels like Automations/Tasks, homepage sections, composer actions) at all, and if so via WebView hosting of the existing bundles or a native slot API?
- Which secondary-panel tabs are in scope for mobile: Info + Diff + file preview only, or also terminal (needs native xterm-like view) and browser (WebView)?
- Do machine-management flows (AddMachineDialog, ProjectPathDialog/RemotePathBrowser, ProjectMachineSetupDialog) belong in the mobile app, given they assume a paired host daemon and local filesystem browsing?
- The `Files` settings section, local editor integration and workspace 'Open in' actions rely on a local host daemon (`useHostDaemon`, `useLocalHostDaemonAccess`); does a phone ever have one, or should these be hidden?
- How should deep links map: does the native app keep the same URL scheme (`/threads/:id`, `/projects/:id/threads/:id`, `/settings/:section`, `/plugins/:pluginId/:panelPath/*`) for universal links and the `wsManager.onThreadOpen` signal?
- Is voice input (usePromptVoice/MediaRecorder + server transcription) required in v1, and which native audio pipeline replaces it?
- Onboarding is behind the `newOnboarding` experiment and assumes a primary host with CLI installs; what is the native first-run flow (server URL + auth) since there is no auth screen in the PWA beyond `/auth/callback`?
