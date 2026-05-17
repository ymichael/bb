# React Performance Audit - `apps/app`

Refreshed against the current Vite React app on 2026-05-08. The previous plan
referenced the old prompt/timeline layout; prompt composition now lives under
`apps/app/src/components/promptbox/`, timeline rendering has its own memo/cache
layer, and the diff panel already has batched parsing plus `content-visibility`.

## Status (2026-05-16)

- Phase 0 (baselines): not recorded. Required before phases that change memo boundaries.
- Phase 1 (route + heavy-dep splitting): NOT STARTED. `App.tsx` still imports every route eagerly; no `React.lazy` in `apps/app/src`. `WorkerPoolContextProvider` still mounted in `main.tsx`. Highest-leverage phase per the plan.
- Phase 2 (prompt-box boundaries): not verified. Requires Phase 0 profiles to know what's actually rerendering.
- Phase 3 (queued follow-up rows): NOT STARTED. `QueuedMessagesList.tsx` still maps inline; no `QueuedMessageRow` memo extracted.
- Phase 4 (timeline context split + containment): not verified.
- Phase 5 (git diff panel): not verified.
- Phase 6 (sidebar memo boundaries): not verified.

Pick-up order: Phase 0 → Phase 1 → Phase 3 (independent, small) → Phase 2/4 after baselines.

Conventions:

- Line numbers are audit snapshots; verify before editing.
- Prefer the current ownership boundaries: promptbox components own composer UI,
  `ThreadDetailPromptArea` owns thread follow-up wiring, timeline components own
  row rendering, and git-diff hooks own parsing/render queues.
- Every phase has independent exit criteria. Do not combine phases unless the
  same changed files would otherwise be touched twice.

## Phase 0: Capture Baselines

**Goal:** Avoid changing memo boundaries blindly. Get a before/after profile for
the surfaces this plan touches.

**Steps:**

- Record React DevTools Profiler traces for:
  - typing 10 characters in `ProjectMainView`'s new-thread prompt
  - typing 10 characters in `ThreadDetailPromptArea`'s follow-up prompt with
    queued messages visible
  - loading a long thread timeline and expanding one completed turn
  - toggling one file in a multi-file git diff
  - selecting a different thread in the sidebar
- Run one production build and record chunk names/sizes:

  ```sh
  pnpm exec turbo run build --filter=@bb/app
  ```

**Exit criteria:**

- Save profiler notes in the implementation PR/commit message, not in this plan.
- Identify the top 2 commit contributors for each interaction before starting
  code changes.

## Phase 1: Route And Heavy Dependency Splitting

**Goal:** Reduce initial app load and dev/HMR module fanout by moving thread-only
and settings-only code out of the eager root bundle.

**Findings:**

- `App.tsx:2-10` eagerly imports every route component, including thread detail,
  settings, archived threads, and internal replay.
- `main.tsx:4,23-29` mounts `WorkerPoolContextProvider` from
  `@pierre/diffs/react` for the whole app, even though diff rendering is used in
  `ThreadSecondaryPanel.tsx:19` and `TimelineFileDiffBlock.tsx:2-3`.
- `components/ui/index.ts:198-203` re-exports `MarkdownPreview`, which imports
  `react-markdown` and `remark-gfm`; many files import from the UI barrel even
  when they only need a button or layout primitive.

**Changes:**

- Add module-scope `React.lazy` route components for at least:
  - `ThreadDetailView`
  - `ProjectSettingsView`
  - `ProjectArchivedThreadsView`
  - `AppSettingsView`
  - `InternalReplayListView`
- Keep the suspense fallback small and layout-stable; do not put it inside every
  route.
- Move `WorkerPoolContextProvider` into a thread/diff-specific boundary so the
  root app does not import `@pierre/diffs/react` on project-list-only sessions.
- Convert heavy UI barrel imports to direct imports where they pull in markdown,
  dialog/drawer, or diff-adjacent modules through `@/components/ui`.

**Exit criteria:**

- `pnpm exec turbo run build --filter=@bb/app` produces route chunks separate
  from the root app chunk.
- A build artifact inspection shows `@pierre/diffs/react` is absent from the
  initial non-thread route chunk.
- Manual smoke test: root project list, project main, settings, archived view,
  and thread detail all load and preserve existing behavior.

## Phase 2: Stabilize Prompt Box Boundaries

**Goal:** Typing in a prompt should not rerender execution controls, environment
pickers, queued message rows, or surrounding thread metadata.

**Findings:**

- `ProjectMainView.tsx:215-248` defines `submitPrompt` inline and passes fresh
  `history`, `mentions`, `attachments`, `execution`, `environment`, and
  `permission` objects at `ProjectMainView.tsx:273-340`.
- `ThreadDetailPromptArea.tsx:221-238` allocates a fresh `submitMode` object and
  `onStop` closures on each render. The component also passes fresh
  `attachments`, `stack`, `composer`, `execution`, `permission`, and `mentions`
  objects at `ThreadDetailPromptArea.tsx:477-586`.
- `NewThreadPromptBox.tsx:95-104` and `FollowUpPromptBox.tsx:148-167` create
  fresh `submission`, `zenMode`, and `footerStart` props for
  `PromptBoxInternal`.
- `usePromptDraftStorage.ts:294-310` returns a fresh object. Callers then depend
  on the whole object in callbacks (`ProjectMainView.tsx:202`,
  `ThreadDetailPromptArea.tsx:302,349-361,432`), so stable callback deps are
  defeated.
- `useThreadCreationOptions.ts:660-662` filters `permissionModeOptions` in the
  returned object, creating a new array each render.

**Changes:**

- Memoize object props at the caller boundary using existing shared prop types.
  Do not inline new function-signature types.
- Wrap `NewThreadPromptBoxUI`, `FollowUpPromptBox`, `ExecutionControls`, and
  stable footer/summary subcomponents in `memo` where profiler output shows they
  are rerendering with equivalent props.
- Convert `submitPrompt`, `submitMode`, stop handlers, `history`, `mentions`,
  `attachments`, `execution`, `environment`, and `permission` to stable
  `useCallback`/`useMemo` values.
- In prompt draft callers, destructure the specific stable methods/values needed
  instead of depending on the whole `promptDraft` object. If the hook keeps
  returning an object, memoize that returned object.
- Memoize `permissionModeOptions` inside `useThreadCreationOptions`.

**Exit criteria:**

- React Profiler: typing in either prompt does not commit `ExecutionControls`,
  `EnvironmentPickerUI`, `PermissionModePicker`, `ThreadEnvironmentSummary`, or
  queued message rows unless their real inputs changed.
- `pnpm exec turbo run typecheck --filter=@bb/app` passes.
- `pnpm exec turbo run test --filter=@bb/app` passes.

## Phase 3: Memoize Queued Follow-Up Rows

**Goal:** Queue actions should update only the affected queued message row.

**Findings:**

- `QueuedMessagesList.tsx:41-126` maps inline and recomputes preview text,
  attachment count, processing state, and button handlers for every row.
- `ThreadDetailPromptArea.tsx:363-432` finds queued messages with linear scans
  inside action handlers.

**Changes:**

- Extract a memoized `QueuedMessageRow` component in
  `components/promptbox/banner/QueuedMessagesList.tsx`.
- Pass primitive row props where possible: `queuedMessage`, `index`,
  `isProcessing`, `sendDisabled`, `actionDisabled`, and stable action handlers.
- Build a `queuedMessagesById` map in `ThreadDetailPromptArea` when action
  handlers need lookups.
- Add tests for processing, edit, delete, attachment count display, and disabled
  states if existing coverage does not already catch these behaviors.

**Exit criteria:**

- React Profiler: sending/editing/deleting one queued follow-up commits only the
  affected row plus expected parent bookkeeping.
- `QueuedMessagesList` still renders nothing for an empty queue.
- `pnpm exec turbo run test --filter=@bb/app` passes.

## Phase 4: Split Timeline Context And Add Long-List Containment

**Goal:** Timeline updates should not invalidate every row, and off-screen rows
should not pay layout/paint cost.

**Findings:**

- `ThreadTimelineRows.tsx:1032-1061` puts static renderer configuration,
  auto-expanded ids, loading ids, errored ids, callbacks, theme, and
  `turnSummaryRowsById` into one context value.
- `TimelineRowView` consumes context for title/link handlers at
  `ThreadTimelineRows.tsx:801-802`, while `TimelineExpandableRowView` consumes
  turn-summary state at `ThreadTimelineRows.tsx:869-877`. Any turn-summary load
  state change can therefore invalidate unrelated rows.
- The `TimelineRowsList` markup at `ThreadTimelineRows.tsx:940-958` renders
  top-level and nested rows without `content-visibility`; only the git diff
  panel currently uses containment (`ThreadSecondaryPanel.tsx:70-74`).

**Changes:**

- Split timeline context into stable renderer configuration and row/turn state,
  or pass row-specific booleans (`autoExpanded`, `isLoading`, `isError`,
  `loadedRows`) through memoized row props.
- Keep callbacks (`onTitleAction`, `onOpenLocalFileLink`,
  `resolveSegmentLinkHref`) in a stable context that does not change when a
  single turn summary loads.
- Add a top-level row shell with `content-visibility: auto` and a conservative
  `contain-intrinsic-size`. Apply it to large top-level timeline rows first;
  avoid nested rows until scroll anchoring is verified.
- Add or update tests around lazy turn loading so the context split cannot
  double-request turn details.

**Exit criteria:**

- React Profiler: expanding/loading one completed turn does not commit unrelated
  conversation/work rows.
- Long timeline initial render and scroll remain visually stable; bottom-anchor
  behavior still follows active output.
- `pnpm exec turbo run test --filter=@bb/app` passes, including timeline tests.

## Phase 5: Tighten Git Diff Panel Recalculation

**Goal:** Collapse/render state for one file should not trigger expensive
whole-panel recalculation or rerender other file diffs.

**Findings:**

- `ThreadSecondaryPanel.tsx:444-445` subscribes to whole collapsed/loading
  `Set`s, then checks membership for each file at
  `ThreadSecondaryPanel.tsx:663-668`.
- `GitDiffFileCard` is already memoized (`ThreadSecondaryPanel.tsx:227`) and
  file bodies already use `content-visibility`, so the old audit's "every row
  rerenders" claim must be remeasured rather than assumed.
- `useGitDiffPanelState.ts:284-292` rebuilds select options and recomputes
  `summarizeGitDiff` on every hook render.

**Changes:**

- First memoize `gitDiffSelectOptions`, `gitDiffStats`, and any other derived
  values that walk all commits/files.
- If profiling still shows Set membership work as material, introduce a
  memoized `GitDiffFileCardContainer` or Jotai `selectAtom`/`atomFamily` so each
  file subscribes only to its own collapsed/loading booleans.
- Preserve the existing render queue behavior in
  `useGitDiffFileRenderQueue.ts`; it already keeps `queuedGitDiffFileRenderKeys`
  in a ref.

**Exit criteria:**

- React Profiler: toggling collapse on one file does not commit other
  `GitDiffFileCard` bodies or `DiffView` instances.
- Instrumentation or profiler notes show `summarizeGitDiff` is not called on
  unrelated panel interactions.
- `pnpm exec turbo run test --filter=@bb/app` passes.

## Phase 6: Repair Sidebar Row Memo Boundaries

**Goal:** Sidebar route changes and manager collapse toggles should update only
the affected rows/projects.

**Findings:**

- `ThreadRow` is memoized (`ThreadRow.tsx:419`), but `ProjectRow.tsx:193-199`,
  `ProjectRow.tsx:210`, and `ProjectRow.tsx:225` pass fresh `options` objects,
  defeating the memo boundary whenever `ProjectRow` rerenders.
- `ProjectRow` itself is not memoized, and `ProjectList.tsx:280-286` passes a
  full `collapsedManagerIds` `Set` to every project row.
- `ProjectList.tsx:363-397` computes row-local values inline while mapping every
  project.

**Changes:**

- Memoize `ProjectRow` with a comparator that keys off project identity,
  selected thread/project state, local path validity, and the
  relevant thread list state.
- Replace inline `ThreadRowOptions` objects with stable constants for
  `default`/`managed-child` and memoized manager options.
- Avoid passing a whole changed `collapsedManagerIds` `Set` through every
  project if profiling shows broad rerenders. Prefer a shape that lets each
  project receive only the collapse flags it renders.

**Exit criteria:**

- React Profiler: selecting a thread commits the previous active row, the next
  active row, and required route/header components, not every sidebar thread.
- Collapsing one manager row does not commit unrelated projects.
- `pnpm exec turbo run test --filter=@bb/app` passes.

## Deferred Lower-Priority Cleanup

These are still real cleanup items, but they are not the first perf wins:

- `AppSettingsView.tsx:105-113` still owns modal state in the full settings
  page. Extracting dialog controllers or colocating state in dialog components
  would reduce settings-page rerenders, but this is not a hot path.
- `ProjectSettingsView.tsx:73-78` still owns delete-dialog state. Extracting a
  local-path picker component would isolate picker rerenders, but route-level
  splitting is higher leverage first.
- `ThreadTimelinePane.tsx:163-180` still contains a local delayed loading
  indicator. Extract only if a second call site appears.
- `AppLayout.tsx:334-396` still owns sidebar drag-resize side effects inline.
  It is acceptable for now because live mousemove updates write CSS variables
  through refs; extract later for readability, not urgent perf.

## Validation For Every Phase

Run after each implementation phase:

```sh
pnpm exec turbo run typecheck --filter=@bb/app
pnpm exec turbo run test --filter=@bb/app
```

For phases that affect loading or bundles, also run:

```sh
pnpm exec turbo run build --filter=@bb/app
```

Manual profiler scenarios to repeat:

1. Open a project main view and type 10 characters in the new-thread prompt.
2. Open a thread with queued follow-ups and type 10 characters in the follow-up
   prompt.
3. Open a long thread timeline, expand one completed turn, and confirm unrelated
   rows do not commit.
4. Open a multi-file git diff, toggle one file, and confirm other file bodies do
   not commit.
5. Select a different thread from the sidebar and confirm only the affected rows
   update.

## Notes

- Audit-only plan; no React code changes are included here.
- Highest leverage order: Phase 1, Phase 2, Phase 4, then Phase 5. Phase 3 is a
  small contained win and can be done any time.
- Do not add new state containers just to chase theoretical rerenders. Profile
  first, then change the smallest boundary that removes measured work.
