# Host frontend components

Host components:

- `ThreadChat` — bb's complete chat surface for an existing thread, rendered
  wherever plugin React runs (nav panels, thread-panel tabs, homepage and
  settings sections). This is the deliberate exception to the
  no-host-components rule: a stable product capability, not a UI kit. Props:
  `{ threadId, variant?, layout?, focusRequest?, permissionPolicy?,
className?, leadingContent?, messageActions? }` —
  `variant` is `"full"` (standard chat controls, default), `"compact"`
  (side-panel presentation), or `"timeline"` (transcript without a
  composer); `layout` is `"contained"` (fills and scrolls within the
  parent, default) or `"document"` (grows with page content);
  `focusRequest` is a change-detected nonce that focuses the composer;
  `permissionPolicy` is `"inherit"` (default — sends run with the thread's
  own resolved permission mode and the picker renders as a dimmed label, so
  a plugin surface can never widen permissions) or `"editable"` (the
  instance gets a live picker, letting the user set a mode for this thread
  independently of the one it was forked from);
  `leadingContent` is a `ReactNode` rendered above the conversation,
  scrolling with it; `messageActions` is a list of
  `ThreadChatMessageAction` entries `{ id, title, icon?, roles?, run }`
  rendered in this instance's per-message action bar after the native and
  slot-registered actions — `roles` limits the action to `"user"` and/or
  `"assistant"` messages (omitted = both), and `run(message)` receives the
  same narrow `ThreadChatMessageReference` as the `messageAction` slot;
  errors from `run` are contained and logged, never breaking the timeline.
  Unlike the global `messageAction` slot, these actions are scoped to the
  one `ThreadChat` instance that supplied them. The
  host owns timeline loading, streaming, drafts, send/queue/steer/stop,
  attachments, execution controls, pending interactions, and read tracking —
  do not proxy thread data through your own RPC or rebuild the composer.
- `experimental_ProviderModelPicker` — bb's controlled provider, model, and
  reasoning picker. Props:
  `{ value: { providerId, model, reasoningLevel, serviceTier? }, onChange,
routing?, allowProviderChange?, align?, disabled?, className? }`, where `routing` is
  `{ kind: "host", hostId }` or `{ kind: "environment", environmentId }`.
  It uses the same live catalog, defaults, capability
  reconciliation, retired-model handling, search, and provider branding as
  bb's composers. Provider switches wait for the target provider's verified
  catalog, then emit one coherent value with its default model and resolved
  reasoning without closing the picker; `serviceTier` is retained only when
  that provider supports it.
  Failed or empty catalogs leave `value` unchanged. Alias it on import for JSX:

  ```tsx
  import { experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";

  const [selection, setSelection] = useState({
    providerId: "codex",
    model: "gpt-5.5",
    reasoningLevel: "high" as const,
    serviceTier: "default" as const,
  });

  <ProviderModelPicker value={selection} onChange={setSelection} />;
  ```

  `allowProviderChange={false}` hides the provider tabs while leaving model,
  reasoning, and service-tier controls available for the fixed `providerId`.
  This is independent of routing: one environment can run several providers.
  `align` optionally sets the popover to `"start"`, `"center"`, or `"end"`;
  it defaults to `"start"`.

  Omit `routing` for primary-machine discovery. Route by host for a selected
  machine or by environment when the catalog depends on an existing workspace.
  This is intended for settings and other compact forms that need an execution
  preference without a composer; do not fetch and reconcile provider catalogs
  again in plugin RPC. The built-in Tasks presets and Automations editor are
  reference consumers: both persist the coherent value and use it at spawn.
  Experimental: see `docs/api_to_audit.md`.

- `experimental_PermissionModePicker` — bb's controlled permission-mode
  picker. Props:
  `{ providerId, value, onChange, routing?, align?, disabled?, className? }`.
  The host resolves the provider's supported modes and the routed machine's
  permission ceiling with the same policy as the composer; it emits a corrected
  mode when a provider or routing change makes `value` invalid. A provisional
  or failed lookup never changes `value`. `routing` has the same host/environment
  shape as `experimental_ProviderModelPicker`. `align` accepts `"start"`,
  `"center"`, or `"end"` and defaults to `"end"`:

  ```tsx
  import { experimental_PermissionModePicker as PermissionModePicker } from "@get-bb/plugin-sdk/app";

  <PermissionModePicker
    providerId={selection.providerId}
    value={permissionMode}
    onChange={setPermissionMode}
    routing={{ kind: "environment", environmentId }}
  />;
  ```

  Use it beside the provider/model picker in settings and compact execution
  forms. Do not pass a plugin-computed option list or reconstruct provider
  capabilities. Tasks presets and Automations are the reference consumers.
  Experimental: see `docs/api_to_audit.md`.

- `experimental_SourceCode` — bb's source viewer. Props:
  `{ content, path, overflow?, highlightedLines?, className? }` — `path`
  drives language detection, `overflow` is `"scroll"` (default) or `"wrap"`,
  and `highlightedLines` is a 1-based inclusive `{ start, end }` (default
  null). bb owns syntax highlighting, gutters, and the live code theme.
- `experimental_Diff` — bb's diff viewer. Props:
  `{ patch, path, view?, overflow?, showLineNumbers?, experimental_fullFileContents?,
className? }` —
  `patch` is a unified patch for exactly ONE file and `view` is `"unified"`
  (default) or `"split"`. bb normalizes the patch, so a GitHub REST patch or
  a bare `@@` hunk works without synthesizing a `diff --git` header
  yourself; unparseable content degrades to plain monospace text.
  `experimental_fullFileContents` is
  `{ old: { path, content }, new: { path, content } }`; when supplied and
  consistent with the patch, bb enables expand-context controls between
  hunks. The caller owns loading those complete UTF-8 sides and omits the prop
  while it has only the patch. Reference: `plugins/github/app.tsx`.

  Alias both on import — JSX reads a lowercase-initial name as an intrinsic
  element:

  ```tsx
  import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";

  <Diff patch={file.patch} path={file.path} />;
  ```

  Highlighting uses the host's shared worker pool from React context. Thread
  panels and plugin nav panels have one; homepage and settings sections do
  not, so code there renders unhighlighted rather than broken.
  Experimental: see `docs/api_to_audit.md`.

- `Markdown` — bb's chat-message markdown renderer (same typography,
  spacing, and code styling as timeline messages). Props:
  `{ content, className? }`. Use it wherever plugin UI quotes or previews
  message content (e.g. a reply header) so it reads like the rest of the
  chat instead of a differently-styled bundled renderer. Renderer options
  beyond content/className stay host-internal.
- `UrlLink` — a real anchor whose ordinary HTTP(S) activation
  follows the current client's in-app/external-browser preference. It keeps
  internal BB routes in SPA history, preserves modifier clicks, copying,
  accessibility, and explicit anchor props, and leaves unsupported schemes and
  explicit targets to browser behavior. A `_blank` or named target preserves
  supplied `rel` tokens but adds `noopener noreferrer` unless `rel` explicitly
  contains `opener`. Use `useBbNavigate().openUrl(url)` for
  buttons, menus, and effects; its boolean reports whether the current app
  accepted the intent, not whether a later OS launch completed.
- `experimental_FileLink` — a real anchor for an explicit live file target:
  `{ kind: "workspace", environmentId, path }`,
  `{ kind: "host", hostId, path }` (absolute), or
  `{ kind: "thread-storage", threadId, path }`. Ordinary activation opens the
  current surface's shared BB preview. Its lazy context menu offers the
  built-in preview, matching plugin `fileOpener`s, the preferred external
  target, available client apps, and copy actions. Valid targets expose an
  encoded, scheme-safe href; traversal paths, ill-formed Unicode, and other
  malformed runtime targets are inert in both the app and SDK test harness.
  Optional `location` is a one-based line/column or line range. For buttons and
  effects use
  `useBbNavigate().experimental_openFilePreview({ target, location })` or
  `.experimental_openFileExternally({ target, location })`; the boolean means
  host acceptance, not completed I/O. Every identity is explicit—never invent
  an environment id or turn a project id into a workspace target. The testing
  harness records both calls in `navigateCalls` and gates them with the
  `openFilePreview` / `openFileExternally` behavior options.
- `experimental_useAppPanel` — returns the generic current-surface fixed-tab
  controller. `openFixedTab({ surface: { kind: "current" }, tab, target? })`
  accepts a plugin's own eligible fixed-tab registration, validates any target
  through that registration's `experimental_target` contract, opens the shared
  panel, and returns host acceptance. The controller does not interpret target
  shapes. Targeted fixed tabs use `experimental_useFixedTabTarget(tab)` to read
  current-session state and call `clear()` when returning to an untargeted
  state. The frontend harness records accepted calls in
  `experimental_fixedTabOpenCalls`, gates them with
  `experimental_openFixedTab`, and seeds state with
  `experimental_fixedTabTarget`.
- `experimental_NewThreadComposer` — bb's complete compose surface for
  CREATING a thread (the create-side counterpart to `ThreadChat`): prompt
  editor with @-mentions and expand, `+` attachments,
  provider/model/reasoning picker, voice, submit, and the row beneath with
  project, environment, "Branch from:", and permission mode. Never
  hand-roll a textarea + "Start thread" button. Props:
  `{ onSubmit, defaultProjectId?, defaultProviderId?, defaultModel?,
defaultReasoningLevel?, defaultServiceTier?, defaultPermissionMode?,
defaultEnvironment?, initialPrompt?, placeholder?, layout?, focusRequest?,
className?, draftKey? }` — the `default*` props are SEEDS, not controlled
  values: the user can change every one, and each takes precedence over the
  project's remembered defaults when provided. They are value-compared each
  render; changing any of them after mount re-seeds every selection
  (including ones the user touched), so switching between two saved records
  in one mounted composer reloads that record's values. `initialPrompt`
  seeds the draft only while it is still empty; `layout` is `"contained"`
  (default) or `"document"` like `ThreadChat`; `focusRequest` is a
  change-detected nonce that focuses the editor; `draftKey` picks where the
  draft persists (default: a key scoped to your plugin).

  This component has no plugin composer-host binding. Composer customizations
  and `useComposer()` writes do not reach this composer instance.

  Store-then-restore: the request's selection fields map to the `default*`
  seed props. The host composer creates `input` and `executionInputSources`
  from its draft and selection provenance. A plugin can re-open a saved
  selection with
  `defaultProviderId={saved.providerId}` / `defaultModel={saved.model}` /
  `defaultReasoningLevel={saved.reasoningLevel}` /
  `defaultServiceTier={saved.serviceTier}` /
  `defaultPermissionMode={saved.permissionMode}` /
  `defaultEnvironment={saved.environment}` (plus `defaultProjectId` and
  `initialPrompt`). An untouched submit reproduces equivalent supported
  selections. The host can reconcile a stale model, reasoning level, or
  service tier. Environment limits are: `project-default` seeds nothing; a
  missing host falls back; a `reuse` worktree needs an unarchived thread; an
  unmanaged path becomes null; and a managed default branch can resolve to a
  configured named base branch.

  Projectless threads: the project picker always offers "Don't work in a
  project". That choice submits BB's personal-project id in `projectId` (not
  `null`) and a host environment with `workspace: { type: "personal" }`.
  Forward both fields unchanged to `threads.spawn`. If you need metadata for
  the selected project, call `bb.sdk.projects.list({ includePersonal: true })`
  because the ordinary list omits the personal project.

  The composer resolves selections; YOUR PLUGIN creates the thread. On
  submit it calls `onSubmit(request)` with a JSON-serializable
  `NewThreadRequest`
  `{ projectId, providerId, model, reasoningLevel, permissionMode,
serviceTier?, executionInputSources, environment, input }`. Forward it
  verbatim to your backend rpc and hand it to `bb.sdk.threads.spawn`,
  adding `sectionId` / `parentThreadId` / `title` / `visibility` yourself —
  `spawn` fills in `origin: "plugin"` and `originPluginId`, so threads
  created this way stay attributed to your plugin. The draft clears when
  `onSubmit` resolves and is KEPT if it throws, so a failed create never
  loses what the user typed.

  Alias it on import — JSX reads a lowercase-initial name as an intrinsic
  element, so `<experimental_NewThreadComposer />` does not compile:

  ```tsx
  // app.tsx
  import { experimental_NewThreadComposer as NewThreadComposer } from "@get-bb/plugin-sdk/app";

  <NewThreadComposer
    defaultProjectId={projectId}
    onSubmit={async (request) => {
      await rpc.call("createThread", { request, sectionId });
    }}
  />;
  ```

  ```ts create-thread-handler
  // server.ts
  async createThread({ request, sectionId }) {
    const thread = await bb.sdk.threads.spawn({
      ...request,
      ...(sectionId ? { sectionId } : {}),
    });
    return { threadId: thread.id };
  }
  ```

  Experimental: the `experimental_` prefix will drop once the entry in
  `docs/api_to_audit.md` is audited. Give it real width — the control row
  does not fit in a ~420px column.
