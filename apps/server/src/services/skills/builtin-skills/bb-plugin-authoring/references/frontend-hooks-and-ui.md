# Frontend hooks, composer, and UI

Hooks:

- `useRpc<typeof rpcContract>()` → `{ call(method, input?) }` — exact method,
  input, and result inference from a type-only backend contract import.
- `useRealtime(channel, handler)` — fires for this plugin's
  `bb.realtime.publish(channel, …)` signals while mounted.
- `useRealtimeConnectionState()` — returns `"connecting"`, `"connected"`, or
  `"reconnecting"` for the same shared socket used by `useRealtime`. Reconcile
  durable server state on subsequent transitions to `connected` (not the first
  connection) because plugin signals are ephemeral and are not replayed.
- `useSettings()` → `{ values, isLoading }` — effective non-secret values
  (secret settings are excluded; read them server-side only).
- `useBbContext()` → `{ projectId, threadId }` from the current route.
- `useBbNavigate()` → `{ toThread(id), toProject(id), toPluginPanel(path,
{ subPath?, replace? }?), toCompose({ initialPrompt?, focusPrompt? }?),
openThreadPanel({ actionId, title?, params? }), openUrl(url),
experimental_openFilePreview(options), experimental_openFileExternally(options) }`.
  `toCompose` opens the root compose screen; pass `initialPrompt` to seed the
  composer draft and `focusPrompt: true` to focus it. The panel
  opener opens one of the current plugin's registered `threadPanelAction` tabs
  in the current thread surface and returns whether the host accepted it; it
  returns false on surfaces without a thread side panel.
  `openUrl` owns HTTP(S) only and returns false for schemes BB
  leaves to normal anchor behavior. The two file methods accept an
  `ExperimentalFileOpenOptions` live-file target.
- `useComposer()` → programmatic access to the chat composer draft (the
  same one the built-in "Add to chat" affordances write to):
  `text` is the current plain text; `setText(next)` replaces it;
  `updateText(current => next)` receives the latest committed text; and
  `clear()` clears the text. These edits preserve attachments. Inline
  mentions outside the changed range are preserved and rebased, while a
  mention overlapped by replaced text is removed because its inline text no
  longer represents that pill. Text edits do not focus the composer;
  `addQuote(text)` appends the text as a `> ` blockquote block and focuses
  the composer — the "reference this selection in chat" primitive;
  `setTextEffect({ className })` paints the whole editable draft with a class
  from the plugin stylesheet (`null` clears it); `setInputLock(locked)` makes
  the editor read-only and busy and auto-releases when the customization
  unmounts or changes scope;
  `insertMention({ provider, id, label })` inserts an @-mention pill bound
  to one of YOUR `bb.ui.registerMentionProvider` providers, resolved to
  fresh context at send time; `focus()` focuses the caret. The `scope` is
  `thread`, `queued-message`, `side-chat`, or `new-thread`, with the identifiers
  for that surface.
- `useComposerView()` → reactive `{ scope, layout, draft, run }` for the
  composer instance that mounted an action or banner. `layout` is
  `"expanded" | "compact" | "zen"`; `draft` is
  `{ text, isEmpty, attachmentCount }`; `run` is
  `{ isRunning, isSubmitting }`.
- `experimental_useCodeTheme()` → `{ mode, name, theme }` — the code theme bb
  is currently rendering with. `mode` is `"light" | "dark"`, `name` is the
  registered theme name for that mode, and `theme` is the resolved **VS Code
  theme document** behind it: `{ name, type, fg, bg, colors, tokenColors }`,
  the same document bb's own highlighter paints from. Reach for it ONLY when
  your plugin renders code with an engine of its own (Monaco, CodeMirror) and
  has to build that engine's theme; for ordinary code and diffs use
  `experimental_SourceCode` / `experimental_Diff`, which are already themed.
  `theme` is null only before the first document resolves, and keeps the
  previous document while a palette switch is in flight — compare `theme.name`
  with `name` to tell a settled state from one still resolving — so a consumer
  that repaints on every change never paints an unthemed frame. Do NOT
  approximate the palette by reading bb's CSS variables: `--canvas` / `--ink`
  carry the app chrome, not the syntax colors, and a custom palette that
  declares its own code theme would not follow.

```tsx
const composer = useComposer();
composer.updateText((current) => `${current}\n\nPlease summarize this.`);
```

Composer customizations:

- Register with `app.composer.customize({ id, scopes?, actions?, plusMenu?,
banners?, richText? })`. Omitted `scopes` means all thread, queued-message,
  side-chat, and new-thread composers.
- `actions` and `banners` are plugin React components. Calls to
  `useComposer()` and `useComposerView()` inside them are bound to the composer
  that mounted the component. Actions render before native voice/submit and
  are unavailable in compact layout; banners render above the composer.
  A banner's `chrome` is `"card"` by default or `"bare"`.
- `plusMenu` rows are host-rendered so keyboard navigation, focus restoration,
  and mobile layout remain correct. Each `ComposerPlusMenuItem` supplies
  `id`, `label`, optional `icon`, `description`, and `disabled`, plus
  `run({ composer, view })`. `disabled` accepts a boolean or a function of the
  current `ComposerView`.
- `richText.effects` rules return plain-text `{ from, to }` ranges and a class
  name from plugin CSS. Decorations are paint-only and never mutate the draft.
  `richText.onDraftChange(draft, view)` observes the debounced
  `ComposerStructuredDraft`, including mention ranges.
- Use a vendored BB prompt icon-button recipe for native-matching action chrome
  and provide an accessible label. Each component/callback is isolated so one
  failing customization does not degrade the native composer. Complete
  reference: `examples/plugins/composer-customization`.

UI components use vendored shadcn source that you own. The former general host
component kit is removed. The app module still exports focused BB capability
components such as `ThreadChat`, `Markdown`, file links, pickers, source and
diff viewers, and the new-thread composer.

- Builtin plugins in this repo import shared UI from `@bb/shared-ui` (the
  single source of truth the app also consumes and the registry generates
  from); external and example plugins still vendor source through the registry.
- `bb plugin new` pre-vendors button, card, input, checkbox, dialog (plus
  their support files: `lib/utils`, `lib/portal-scope`, icon,
  responsive-overlay, drawer, hooks) into `components/ui/` etc., and writes a `components.json`
  whose `@bb` registry is pinned to the release tag matching the running
  BB. Import via the `@/*` alias: `import { Button } from
"@/components/ui/button"` (tsconfig maps it; `bb plugin build` reads it).
- Add more with stock shadcn tooling: `npx shadcn add @bb/select
@bb/table` — the BB registry carries the full stock set (~44 items:
  accordion, alert-dialog, calendar, chart, command, form, sheet, table,
  …), generated from the BB app's own component source, so vendored code is
  version-matched to your BB by construction. Edit the copies freely; they
  never change out from under you. Re-running `shadcn add` is the manual
  update path.
- `toast`: `import { toast } from "sonner"` — runtime-shimmed to the host's
  Toaster (`toast.success("Saved")` just works; never mount your own
  `<Toaster>`).
- Never bundled (runtime-shimmed, import freely): react, the portaling
  radix families (`@radix-ui/react-dialog`, `-alert-dialog`, `-popover`,
  `-select`, `-dropdown-menu`, `-context-menu`, `-menubar`, `-hover-card`,
  `-tooltip`, `-navigation-menu`), `sonner`, `vaul`, `@pierre/diffs` (+
  `/react`). Your vendored overlays therefore share the host's
  dismissable-layer/focus/scroll-lock world — stacking against host
  overlays behaves correctly. "Import freely" is about the bundle: `tsc`
  still needs each one's declarations in `node_modules`, so every shimmed
  package is a **type-only `devDependencies` entry at the host's version**
  (the scaffold declares all of them; `bb plugin types` repins them; `bb
plugin types --check` reports drift). Never list one in `dependencies` —
  the build would not read it, and a git install would bundle a second
  copy of a singleton.
- Also never bundled, for size rather than singleton reasons: `clsx`,
  `tailwind-merge`, and `class-variance-authority`. Your app bundle uses the
  host's installed copies (tailwind-merge ^3, clsx ^2, cva ^0.7), so keep
  your declared ranges inside those majors. `zod` is NOT shimmed (exposing
  its namespace would bloat the host's boot payload) — it bundles from your
  `node_modules` in both `app.tsx` and `server.ts`, so keep it in
  `dependencies`.
- Source and diffs: use the host components
  `experimental_SourceCode` / `experimental_Diff` (see "Host components"),
  NOT a direct
  `@pierre/diffs` import. The shim stays for compatibility, but hand-rolled
  Pierre usage means owning patch normalization and the code theme yourself,
  and it opts you out of any installed renderer replacement.
- Everything else bundles from YOUR `node_modules` (hugeicons, lucide,
  non-portal radix, zod, form/calendar/chart libs): run `npm install`
  after adding components (`bb plugin new` runs the first one; `shadcn add`
  installs each item's declared deps). Users of your prebuilt artifact need no
  npm. Managed source installs do.
- The old bb extras (`EmptyState`, `PageBody`, `Spinner`) are
  gone — write your own (each is a few lines; see
  `plugins/github/components/` for reference implementations).

Compatibility aliases remain for one release and warn once. Use `UrlLink`
instead of `experimental_UrlLink`. Use `BbNavigate.openUrl` instead of
`experimental_openUrl`. Use `Original` instead of `experimental_Original` in
thread-list, file-opener, source-renderer, and diff-renderer props. Timeline
renderers never had the `experimental_Original` alias. BB removes these aliases
in bb 0.42.

One deviation from stock shadcn: `Dialog` renders as a bottom drawer on
compact viewports (the host's responsive behavior) — same API.

Crash isolation stays local to the slot. Additive slots can show a crash chip
or nothing. Replacement slots fall back to the native list or renderer.
`messageDirective` falls back to the original source text.

The `run` pattern (threadPanelAction): `run` is the place to resolve
server state before deciding what to open — e.g. call a backend rpc, then
`openPanel({ title: issue.title, params: { issueId: issue.id } })`, or
`toast.error("No linked issue")` and open nothing. The panel component
should treat `params` as untrusted input (it round-trips through
persistence) and re-fetch fresh data by id rather than embedding whole
payloads in params.

Styling: Tailwind classes compile against the host theme's live CSS
variables — use host token classes (`bg-card`, `text-foreground`,
`text-muted-foreground`, `border-border`, `text-destructive`, …). Never
define custom `@theme` colors and never hand-set `oklch(...)`/gray
literals: the build's Tailwind pass emits default-theme utilities only, and
hardcoded colors break custom palettes.
