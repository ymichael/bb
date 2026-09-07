# Content scripts and core slots

### Trusted frontend content scripts

`app.contentScripts.register({ id, mount })` runs ordinary
bundled JavaScript/TypeScript in the bb app shell without a React slot. It is
full-trust, same-origin page code — **not a security sandbox**. It can access
the app DOM and any authenticated client state available to ordinary page
code, so install only plugins you trust. bb does not use `eval`, `Function`,
or persisted source strings: the existing `bb.app` build emits a normal CSP-
compatible ESM bundle.

The host mounts scripts in registration order after the bundle loads and
`definePluginApp` setup validates. `mount` receives
`{ pluginId, generation, signal, experimental_setThreadRowStatus? }`:
`generation` is a monotonic per-window mount attempt number, and `signal`
aborts before cleanup starts. The optional experimental setter targets an
explicit thread row with `{ icon, label, tone? }` or clears it with `null`.
Use `tone: "running"` for the host's animated running treatment. The host
scopes statuses to the calling plugin and automatically clears them when that
frontend generation deactivates; feature-detect the setter for compatibility
with older bb clients.

A script may return nothing, a disposer, or a promise of either; async mount
setup is time-boxed to 10 seconds. Keep long-running work outside the returned
promise, observe `signal`, and catch failures in work the host does not await.

A replacement bundle and setup validate before lifecycle cutover. The host
then aborts and disposes the prior generation before mounting candidate scripts,
so listeners and observers never overlap. If a mount throws or rejects, the
host aborts that candidate, disposes already-mounted candidate scripts in
reverse registration order, and publishes none of its slots or CSS. Import or
setup failure also deactivates stale UI because the corresponding backend may
already have been replaced. Disable, stop, removal, and app-window teardown
follow the same abort-then-reverse-dispose path; every returned disposer is
called at most once. Each desktop window, browser tab, and remote client owns
an independent instance.

Synchronous and awaited asynchronous mount/dispose failures are contained and
logged; they cannot stop sibling plugins from activating. The current
window's last load/setup/mount/dispose failure appears on the plugin Settings
detail page. The host cannot catch a detached promise that plugin code creates
and never returns, so detached work must handle its own errors.

Prefer the existing imported `app.css` pipeline for static styles. Its lifetime
follows the plugin UI and content scripts that use it: the host keeps the
stylesheet active while a slot, panel header/accessory, or plugin portal is
rendered and throughout an active content-script generation, then releases it
after the final consumer. Imported `app.css` is therefore not an app-wide CSS
hook. Put app-wide selectable palette CSS in manifest `bb.themes` entries;
theme CSS has an independent app-theme lifetime.

Styling or decorating existing app-shell DOM belongs in a content script. A
content script may create DOM or `<style>` nodes when behavior genuinely
requires it, but its abort handler/disposer must remove every node, observer,
listener, timer, class, and style it owns. The context deliberately has no
route/project/thread snapshot yet; use stable SDK hooks inside React slots
rather than polling or installing global navigation observers. Complete
cleanup-safe example: `examples/plugins/content-script`.

Slot props contracts (versioned, additive-only):

- `homepageSection` → `{ projectId: string | null }` (project in view on
  the compose surface). Registration: `{ id, title, component }`.
- `settingsSection` → `{}` (deliberately no props in V1). Rendered on the
  plugin detail page below the host-rendered declarative settings
  form for running, needs-configuration, and degraded plugins. Registration:
  `{ id, title?, description?, component }`; `title` is an optional host-rendered
  section heading and `description` is optional supporting copy rendered with
  that heading. Use the existing hooks (`useRpc`, `useRealtime`,
  `useRealtimeConnectionState`, `useSettings`, `useBbNavigate`, `useBbContext`)
  for data. Enabled plugins appear in the
  settings sidebar when they declare settings descriptors OR register
  settings sections.
- `experimental_appOverlay` → `{}` (deliberately no props). An additive,
  app-wide React owner for floating plugin UI. Registration:
  `{ id, component }`. BB mounts every registration once per app window
  through `PluginSlotMount`, outside route-owned layout regions. The component
  can therefore call app-level SDK hooks, including the sidebar thread data and
  action hooks, and keep their React contexts through a portal. Hooks whose
  contract requires a particular surface, including `useComposer` and
  `useComposerView`, remain limited to that surface. BB supplies no chrome,
  positioning, visibility, focus, or responsive behavior; render fixed UI
  directly or use the vendored responsive overlay primitives. A crash hides
  only that overlay. Use a content script instead for DOM enhancement that does
  not need React context. Experimental: see `docs/api_to_audit.md`.
- `navPanel` → `{ subPath: string }` — owns the whole route at
  `/plugins/<pluginId>/<path>/*` and gets its own sidebar entry. `subPath`
  is the route remainder after the panel root (`""` at the root), so deep
  links like `/plugins/notes/notes/work/ideas.md` land with
  `subPath: "work/ideas.md"`. Navigate within the panel via
  `useBbNavigate().toPluginPanel(path, { subPath, replace? })` — browser
  back/forward then walks panel-internal history (prefer this over hash
  routing).
  Registration:
  `{ id, title, icon, path, component, fixedTabs?, experimental_sidebarAccessory?, headerContent? }`.
  BB automatically wraps every plugin page in the same host-owned App panel
  used by New thread and thread pages. The page component supplies only its
  main body; it must not mount a second panel layout or register Browser and
  Terminal itself. BB owns the desktop split, compact drawer, header/panel
  toggle, resizing, tab strip, persistence, and the shared `panel.toggle`,
  `panel.newTab`, `panel.reopenClosedTab`, and `terminal.open` keyboard
  commands.

  New tab is a transient host launcher. On a plugin page it offers Browser
  (when the desktop browser is available) and Terminal; it does not offer
  workspace file search because a generic plugin page has no implicit project,
  environment, or working directory. The Terminal row includes a compact
  connected-machine selector, initially resolving the primary machine and then
  the first connected fallback. Changing the selector does not launch
  anything; activating Start terminal uses the selected machine. The selection
  is page-session UI state, not plugin storage.

  Browser and Terminal tabs are normal host content tabs. Closing the final
  content tab closes an otherwise empty panel; if fixed tabs remain, BB falls
  back to the first one instead. Hydration closes an open panel when no durable
  tab survived.

  `fixedTabs` declares ordered, non-closable page views in that
  same host tab strip:
  `{ id, panelId, title, icon, component, layout?, experimental_target? }`.
  BB opens the
  first fixed tab on the page's first wide-layout visit, but remembers a later
  user close. One tab is active per visible split pane, so multiple fixed-tab
  components can be mounted concurrently. A component mounts only while its
  tab is active in a visible pane; closing the panel unmounts it. It receives
  the same `{ subPath }` as the main page. `layout: "padded"` (the default) gives it
  host padding and scrolling; `layout: "flush"` gives it the full panel content
  region so it can own both. Fixed tabs add content to the shared panel; they
  do not replace its native chrome, Browser, Terminal, or keyboard commands.
  Experimental: see `docs/api_to_audit.md`.

  Every registration's `panelId` must exactly match its containing nav panel's
  `id`; the registration is also the stable reference for selecting that
  plugin-owned tab. A targetable tab declares
  `experimental_target: { validate(value): value is Target }`; BB checks JSON
  safety before calling the owner validator. From any component of the same
  plugin on that page, call
  `experimental_useAppPanel().openFixedTab({ surface: { kind: "current" }, tab,
target? })`. Inside the fixed-tab component,
  `experimental_useFixedTabTarget(tab)` returns `{ sequence, target, clear }`
  after validation. The per-tab target survives inactive-tab, closed-panel,
  and route remounts for the current app session; call `clear()` when the tab
  returns to its untargeted state. Selection persists through the host's
  ordinary panel state, while targets remain memory-only and disappear on app
  refresh. Invalid, unavailable, untargeted, or other-plugin references return
  false without changing valid panel state.

  `experimental_sidebarAccessory` is a no-props, presentational component at
  the trailing edge of the sidebar row. It can own SDK hooks for a live count
  or short status without lifting state into the host sidebar. The host does
  not mount it on compact viewports; on wider viewports it clips the component
  to one line, 4rem wide by 1.25rem high, and ellipsizes ordinary long text.
  It shares the trailing action column and fades out for the host options
  button on row hover or keyboard focus without unmounting. Do not render
  controls or portalled content there. A throw hides only the accessory.
  Experimental: see `docs/api_to_audit.md`.
  The host renders your compact plugin icon + `title` into the SHARED app
  header (the same title bar as Settings pages) with your optional
  `headerContent` component as the header actions on the right — so do NOT
  repeat the title inside your component. The component owns the full-bleed
  body below with zero host padding; add your own padding and scrolling when
  the design needs them. `headerContent` is plugin code inside the host title bar and is
  contained separately: a throw hides the header content without breaking the
  title bar or the panel body. For a classic page, use an outer scroll region
  with `p-4 md:p-5` and wrap its content in a
  `mx-auto w-full max-w-3xl space-y-4` div.

- `threadPanelAction` → an entry in the thread right panel's new-tab
  Actions list (next to "Start side chat" / "Start terminal"), labeled
  `title` with your compact plugin icon. This slot is only offered for an
  existing thread; it never renders on the root New thread screen, and its
  `threadId` stays required. Registration:
  `{ id, title, icon?, component, layout?, run? }`. Activating it calls
  `run({ threadId, openPanel })` — do anything there (rpc, toast), and/or
  call `openPanel({ title?, params? })` to open a closable panel tab
  rendering `component` with `{ threadId: string, params: JsonValue | null }`.
  `openPanel` returns `boolean` — true when the host accepted the open, false
  when it declined (non-JSON `params`, unavailable action, or a surface with
  no side panel). A decline is a return value, never a throw, and matches
  `messageAction`'s `openPanel` and `useBbNavigate().openThreadPanel`, so one
  open routine can serve every action kind. Because `run` is declared
  `void | Promise<void>`, call `openPanel` from a braced body
  (`run: ({ openPanel }) => { openPanel(); }`), not a concise arrow.
  Omitting `run` opens a tab immediately with defaults. Write parameters are
  typed as the recursively JSON-safe `JsonValue` exported by both
  `@get-bb/plugin-sdk` and `@get-bb/plugin-sdk/app`; they persist with the tab across reloads (null when
  none was passed); identical action+params re-opens focus the existing
  tab (title refreshed), different params open sibling tabs. The tab pill
  shows your compact plugin icon + the tab title. Errors thrown from `run`
  (sync or async) are contained and logged, never breaking the launcher.
  `layout` frames the tab content: `"padded"` (default) wraps `component`
  in the panel's scroll container with standard padding — right for
  document-like content; `"flush"` gives it the full tab area (no padding,
  definite height, no host scrolling) — right for app-like content that
  owns its layout, such as `ThreadChat`.
- `experimental_newThreadPanelAction` → the root New thread counterpart to
  `threadPanelAction`. It appears in that screen's right-panel Actions list
  and never appears beside an existing thread. Registration has the same
  `{ id, title, icon?, component, layout?, run? }` shape, but activating it
  calls `run({ projectId, openPanel })` and its component receives
  `{ projectId: string | null, params: JsonValue | null }`; `projectId` is
  null in projectless compose. Panel opening, JSON params, layout, persistence,
  deduplication, the `boolean` return, and error containment otherwise match
  `threadPanelAction`.
  Experimental: see `docs/api_to_audit.md`.
- Removed pre-1.0: `composerAccessory` was the legacy composer footer. Migrate
  controls to `app.composer.customize({ actions })` or `plusMenu`, larger
  content to `banners`, and legacy `{ projectId, threadId }` prop reads to
  `useComposerView().scope`.
- `pendingInteraction` → `{ interaction, submit, cancel }` — replaces the
  thread composer only while a matching plugin interaction is pending.
  Registration: `{ id, component }`; `id` must equal the backend request's
  `rendererId`. `interaction` contains metadata plus the JSON `payload`;
  `submit(value)` returns the JSON value to the waiting backend invocation,
  while `cancel()` settles it without a value. Keep sensitive field values in
  component state only.
- `experimental_sidebarFooter.register` → managed host-rendered icon items in
  the app sidebar footer. Both variants take `{ id, label, icon }`. An action
  adds `{ kind: "action", onActivate }`; its callback receives
  `openPluginDetails()`. A disclosure adds
  `{ kind: "disclosure", component }`; bb toggles that component above the
  row and passes it only `{ dismiss }`. A disclosure registration returns a
  controller that requests `open`, `close`, or `toggle`; an action registration
  returns nothing. BB keeps only one disclosure open across all plugins.
  The component owns everything inside, including tabs and navigation.
  Experimental: see `docs/api_to_audit.md`.
- `sidebarFooterAction` → compatibility API for a host-rendered footer action.
  Registration remains `{ id, title, icon, run }`, and `run` still receives
  `{ openSettings }`. New plugins should use
  `app.experimental_sidebarFooter.register({ kind: "action", ... })` so actions
  and disclosures share one surface.
- `experimental_sidebarNavigation` → replaces the bounded navigation controls
  above the thread list. Registration:
  `{ id, title, description?, component }`. The component receives semantic
  host items, the active item id, the compact-viewport state,
  `experimental_activate`, and `experimental_Original`. Search activation opens
  the quick palette. No inline search field or query state exists. BB keeps the
  drawer, thread list, footer, resize handle, and shortcut ownership.
- `fileOpener` → `{ path: string, source, Original }` — register as a viewer/editor
  for file extensions: `{ id, title, extensions: ["md"], component }`.
  Matching files use the first applicable opener in deterministic slot order
  by default. Users can pin BB's preview or a specific opener per extension
  under Settings → "File openers", and
  right-clicking a file link in rendered markdown offers a one-off
  "Open with …" choice; matching files opened in the right panel then
  render your component in a plugin tab instead of the built-in preview —
  this includes links clicked in rendered markdown, the file picker, and
  `bb thread open`. `source` is
  `{ kind: "workspace" | "host" | "thread-storage", threadId, environmentId,
projectId, experimental_hostId? }` (nullable fields). The optional host ID
  selects a project-backed workspace host and persists in opener-tab parameters.
  The `path` follows the source (workspace:
  worktree-relative; host: absolute; thread-storage: storage-relative).
  `Original` is BB's preview bound to this file; render it to
  delegate conditionally without re-entering plugin replacement resolution.
  Applies only to live file content — git-ref snapshots and deleted files
  always use the built-in preview, and a removed/disabled opener degrades
  back to it. Pair with `bb.sdk.files` (rpc from your server) to load and
  CAS-save the content.
