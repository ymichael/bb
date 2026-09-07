# Renderer and action slots

- `experimental_sourceCodeRenderer` / `experimental_diffRenderer` →
  replace bb's source or diff renderer everywhere it draws supplied content:
  the native file preview, timeline file diffs, the environment diff panel's
  file bodies, and every plugin calling the host components. Registration:
  `{ id, title, description?, component }`. Like `experimental_threadList`
  each slot is **exclusive** — one renderer at a time, first in slot order
  wins, and a missing, disabled, or crashing replacement falls back to bb's
  renderer. Installing and enabling the plugin activates it, and the user can
  pin bb's renderer or a specific provider under
  **Settings → Appearance** ("Source code" / "Diffs"), per client. There are no
  scope or extension filters on the registration, so conditional behavior
  belongs in the component. Source props:
  `{ content, path, overflow, highlightedLines, Original }`;
  diff props:
  `{ patch, path, view, overflow, showLineNumbers, experimental_fullFileContents,
Original }`. `experimental_fullFileContents` is either
  `{ old: { path, content }, new: { path, content } }` or `null`; a replacement
  can use those complete UTF-8 sides to implement context expansion.
  Every value is already resolved. Render `Original` (bb's
  renderer, bound to this call) to delegate without re-entering resolution —
  behind a plugin setting, by language, over a size threshold:
  A bundle compiled against an SDK before 0.4.16 may still read
  `experimental_Original`: every host passes the same component under that
  name for one release (it warns once; removed in bb 0.42).

  ```tsx
  app.slots.experimental_diffRenderer({
    id: "compact",
    title: "Compact diffs",
    component: ({ patch, path, Original }) =>
      patch.length > 20_000 ? (
        <Original />
      ) : (
        <MyDiff patch={patch} path={path} />
      ),
  });
  ```

  Experimental: see `docs/api_to_audit.md`.

- `messageDirective` → `{ attributes, source, message,
openWorkspaceFile }` — register a leaf
  assistant-message directive. Registration:
  `{ id, component }` where `id` is lowercase kebab-case beginning with a
  letter (e.g. `inline-vis` matches `::inline-vis{file="demo.html"}`).
  Props: `attributes` is a `Readonly<Record<string, string>>` of untrusted
  parsed key/values (validate your own fields); `source` is the original
  directive text (useful for diagnostics); `message` is
  `{ id, threadId, turnId, projectId }` for the enclosing assistant (or
  nested agent) message. `openWorkspaceFile` is either
  `(path: string) => boolean` or `null`; pass it a worktree-relative path to
  open that file in the host's workspace viewer. It is `null` when the message
  surface has no workspace viewer, and it returns whether the host accepted
  the path. To open one of the same plugin's registered `threadPanelAction`
  components, call
  `useBbNavigate().openThreadPanel({ actionId, title?, params? })`.
  `params` is typed as `JsonValue`; use normal plugin navigation as the
  fallback when it returns false.
  **Host behavior / fallbacks:** only assistant and
  nested agent Markdown activate directives — user messages, file previews,
  and other Markdown surfaces stay plain. Directives inside inline code or
  fenced code blocks stay literal. Incomplete streaming directives stay
  literal until the closing syntax arrives. Unknown, disabled, malformed,
  conflicting, or crashing directives fall back to rendering the original
  `source` (the component ErrorBoundary still isolates a throw). Treat
  attributes as attacker-controlled even though the model emitted them;
  load workspace data through `bb.sdk.files` with root/host confinement
  rather than trusting paths. Reference implementation:
  `plugins/inline-vis` (the sidebar's path-shaped, sandboxed worktree
  iframe preview, including relative assets and normal web loading).
- `messageAction` → an action on chat messages: an icon button in the
  per-message action bar (user and assistant messages) and an entry in the
  assistant-message text-selection menu. Host-rendered chrome, no plugin
  component — registration: `{ id, title, icon?, run }`. Activating it calls
  `run(context)` with `{ threadId, message, selectedText?, openPanel }`:
  `message` is a narrow stable reference
  `{ id, threadId, role: "user" | "assistant", text, sourceSeqEnd }` (never
  an internal timeline row); `selectedText` is present only for
  selection-menu invocations and holds the exact highlighted text; and
  `openPanel({ actionId, title?, params? })` opens one of the same plugin's
  registered `threadPanelAction` components in the current thread's side
  panel — same semantics and boolean return as
  `useBbNavigate().openThreadPanel`. Errors from `run` (sync or
  async) are contained and
  logged, never breaking the timeline.
- `commandPaletteAction` → a row in bb's quick palette (Mod+Shift+P), listed
  under "Plugins" beside bb's own commands. Host-rendered chrome, no plugin
  component — registration: `{ id, title, isAvailable?, run }`. Both callbacks
  receive `{ threadId, projectId, openPanel }`, where `threadId` and
  `projectId` are null on surfaces without one and `openPanel` matches
  `messageAction`'s. `isAvailable` is called while the palette is open — keep
  it cheap and synchronous — and hides the row when it returns false; a row
  that needs a thread should use it, because the palette opens anywhere and
  `openPanel` declines (returning false) unless a thread view is focused.
  Errors from either callback are contained and logged, never breaking the
  palette. Write self-identifying titles ("Linear: open issue for this
  thread"): the palette matches the query against the title.
- `experimental_timelineRenderer` → the expanded body of the timeline rows a
  provider plugin owns. Registration: `{ kind, component }`, where `kind` is
  one of the plugin's own extension item kinds (`"<pluginId>/<name>"`, as
  declared in `bb.providers.register({ extensionKinds })`) or
  `"tool"` for the generic tool items of the providers this plugin
  registered. Core kinds (messages, commands, file changes, reads, searches,
  delegations, plan steps) always use bb's renderers and are customized only
  through the bridge's presentation. The component receives `row` (id,
  threadId, turnId, kind, toolName, status, startedAt, completedAt),
  `payload` (the extension item's validated payload, or `{ arguments,
output }` for a tool call), `presentation` (the bridge's label, icon,
  title, detail, suppress and tint for the row; null only for a tool row
  persisted before bridges attached one), `thread` (`{ id,
providerId }`) and `Original`, the host's declarative base for the body —
  render `<Original />` to keep it beside your own content. The row header
  (label, glyph, tint, headline) stays host-rendered; a glyph of the form
  `"<pluginId>/<name>"` draws the plugin's declared icon
  (`bb.branding.experimental_icons`) as a tinted mask, or the per-kind
  glyph when the name is no longer declared. With no renderer registered,
  the declarative base renders, so a row never goes blank; a crash in the
  component is contained to that row.
- `experimental_providerIcon` → the React component bb draws as one agent
  provider's icon. Registration: `{ providerId, icon }`, where `providerId` is
  the provider's id (`"codex"`, `"acp-cursor"`) — not the plugin id — and
  `icon` is a component receiving only `className` (host sizing plus the
  provider color class). Use it for a theme-aware mark: a file logo
  (`bb.branding.icon`, or a path-shaped provider declaration `icon`) is drawn
  through `<img>`, a separate document where `currentColor` resolves to black
  and is invisible on dark themes, so keep files for intentionally colored
  logos and register a component for anything that should follow the theme.
  A component beats the file logo for that provider; disabling the plugin
  falls back to it, and so does every surface shown before the plugin's
  deferred `app.tsx` has loaded. Read `references/providers.md` for provider
  icon declaration and registration details.
  One registration per provider id per plugin; if two plugins claim one
  provider id the host keeps the first by plugin id and warns. See the
  `app.tsx` example in `references/providers.md`.
