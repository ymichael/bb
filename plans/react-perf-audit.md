# React Performance Audit — `apps/app`

Findings from auditing `apps/app/src` for inline state that should be atoms, inline logic that should be hooks, and unnecessary re-renders / missing memos. Each phase is independent. Pick highest-leverage first (Phases 5 and 7).

Conventions:

- Line numbers are snapshots from the audit; verify before editing.
- "Atom" means Jotai. New atoms live alongside existing UI atoms in `apps/app/src/lib/` (or the nearest existing atoms module).
- Custom hooks live in `apps/app/src/hooks/`.

## Phase 1: Promote local UI state to atoms

**Goal:** Eliminate prop-drilling and unnecessary parent re-renders for state that is logically global or shared across views.

**Changes:**

- `ThreadDetailPromptArea.tsx:125` — `isChangeListExpanded` is local `useState` consumed by a child composer. Promote to atom.
- `ProjectMainView.tsx:38` and `ThreadDetailPromptArea.tsx:124–128` — `attachmentError` is duplicated. Centralize in a single atom (keyed per composer surface if both can be open simultaneously; otherwise a singleton).
- `AppSettingsView.tsx:70–77` — Modal state cluster (`renameTarget`, `deleteTarget`, `activeCloudAuthAttempt`, `cloudAuthNotices`) lives in a 300+ line page component. Move to atoms so dialog open/close does not re-render the page.
- `ProjectSettingsView.tsx:68–69` — `repoPickerOpen` + `repoSearch`. The picker has its own debounce + memo chain; an atom (or `atomFamily` keyed by project id) lets the filter recompute without re-rendering the surrounding form.

**Exit criteria:**

- The named `useState` hooks are removed; consumers read/write the new atoms directly.
- No new prop drilling introduced for these values.
- `pnpm exec turbo run typecheck --filter=@bb/app` passes.
- Manually verify in the dev frontend that opening/closing each dialog and toggling the change-list does not visibly stutter a sibling area.

## Phase 2: Extract reusable hooks from large component bodies

**Goal:** Reduce component body size and make domain logic testable in isolation.

**Changes:**

- `ThreadDetailPromptArea.tsx:184–217` — Extract the 65-line `sendFollowUpInput` callback into `useThreadFollowUp({ threadId, activeModel, selectedModel })` returning a stable submit function.
- `ThreadDetailPromptArea.tsx:220–244` ↔ `ProjectMainView.tsx` — Attachment upload + error mapping is copy-pasted across both prompt surfaces. Extract `usePromptAttachmentHandler()` and use in both.
- `ProjectMainView.tsx:40–95` — Twelve `useMemo` blocks for derived environment/execution state. Extract `useProjectExecutionState({ projectId, localHostId, … })` so deps are scoped together and the page body shrinks.
- `AppLayout.tsx:343–399` — 57-line sidebar drag-resize with refs + RAF. Extract `useSidebarResize()`. Pure side-effect behavior; doesn't belong inline in the layout.
- `ThreadTimelinePane.tsx:121–138` — `DelayedThreadLoadingIndicator` reimplements "show after delay." Lift to a generic `useDelayedVisible(ms)` in `hooks/`. Audit other call sites once the hook exists.
- `ThreadDetailView.tsx:102–111` — `handleShowAllEventsChange` plus surrounding storage logic. Small but the file is 400+ lines; a `useShowAllEventsToggle()` lets the view shed state.

**Exit criteria:**

- Each new hook is in `apps/app/src/hooks/` with a unit test where the logic has branches worth verifying (uploads with retry, follow-up payload assembly, sidebar drag clamping).
- `usePromptAttachmentHandler` has exactly two call sites; the duplicated implementations are deleted.
- `pnpm exec turbo run typecheck --filter=@bb/app` and `pnpm exec turbo run test --filter=@bb/app` pass.

## Phase 3: Stabilize prop object identities passed to memoized children

**Goal:** Stop defeating downstream `React.memo` by passing fresh object/array literals each render.

**Changes:**

- `ThreadDetailPromptArea.tsx:418–512` — `ThreadFollowUpComposer` receives three inline object props. Wrap each in `useMemo`:
  - `attachments` (lines 420–426)
  - `banner` (lines 428–451)
  - `composer` (lines 453–464)
- `ProjectMainView.tsx:254–342` — `PromptBox` receives:
  - `submission` inline (275–279) → `useMemo`
  - `mentions` inline (280–285) → `useMemo`; ensure `promptMentions.setQuery` is stable
  - `attachments` inline (286–293) → `useMemo`
  - `footerStart` JSX inline (299–323) — extract to a memoized `<PromptFooterStart />` component or `useMemo` the element. This is the heaviest of the four; it contains `PromptExecutionControls`.
- `AppLayout.tsx:273–289` — `project`, `projectName`, `projectLabel`, `threadDisplayTitle` are recomputed inline each render. Wrap with `useMemo` (or fold into the hook from Phase 2 if a layout-meta hook materializes).

**Exit criteria:**

- Every prop object passed to a `React.memo`'d child in the listed files is referentially stable across renders where its inputs are unchanged.
- React DevTools Profiler: typing in the composer no longer re-renders `PromptExecutionControls` / `ThreadFollowUpComposer` siblings.
- `pnpm exec turbo run typecheck --filter=@bb/app` passes.

## Phase 4: Memoize list rows

**Goal:** Avoid rebuilding all list items when a single ancestor re-renders.

**Changes:**

- `ThreadFollowUpComposer.tsx:92–142` — `QueuedFollowUpList` maps `queuedMessages` and computes ~6 derived values per item inline. Extract `QueuedFollowUpItem` as a `React.memo`'d component that receives the message and computes derived values internally (or receives stable derived props).

**Exit criteria:**

- `QueuedFollowUpItem` exists as a memoized component; the list maps with a stable `key` and stable props.
- Profiler: editing the composer text does not re-render queued list rows.

## Phase 5: Scope atom subscriptions to avoid whole-Set reads

**Goal:** Stop reading entire `Set`s into every consumer of the diff panel.

**Changes:**

- `ThreadSecondaryPanel.tsx:415–430, 635` — `collapsedGitDiffFileKeys` and `loadingGitDiffFileKeys` are pulled as whole `Set`s; `.has(key)` is called per file in the list map. Replace with one of:
  - `selectAtom` keyed per file (factory or `atomFamily`) so each `GitDiffFileCard` subscribes only to its own collapsed/loading flag, or
  - lift the membership check into a memoized child that takes `isCollapsed` / `isLoading` as boolean props derived once at the parent.
- While here, verify `useGitDiffPanelState.ts:88–95` `parsedGitDiffFileEntries` and `queuedGitDiffFileRenderKeys` consumed alongside it have stable identities; if `queuedGitDiffFileRenderKeys` changes per render it defeats downstream memos.

**Exit criteria:**

- Toggling collapse on one file in a multi-file diff re-renders only that row in the React Profiler.
- No consumer reads the whole `Set` purely to call `.has(key)`.

## Phase 6: Co-locate timeline derivations

**Goal:** Reduce render-phase noise from chains of single-value `useMemo`.

**Changes:**

- `ThreadDetailView.tsx:135–144` — `threadDetailRows` and `latestActivityRowId` are chained single-value memos. Co-locate into `useThreadTimelineState()` (can be the same hook produced by Phase 2's `useShowAllEventsToggle` work, or a sibling hook). Verify deps are tight afterward.

**Exit criteria:**

- `ThreadDetailView` no longer hosts the per-render derivation chain; the hook returns a stable shape.
- Typecheck passes.

## Validation across all phases

Run after each phase:

```
pnpm exec turbo run typecheck --filter=@bb/app
pnpm exec turbo run test --filter=@bb/app
```

For perf-sensitive changes (Phases 3, 4, 5), also profile in the dev frontend (`:5173`) with React DevTools Profiler:

1. Open a thread with an active composer and queued follow-ups.
2. Record while typing 10 characters into the composer. Confirm queued rows, secondary panel rows, and `PromptExecutionControls` do not appear in the commit list.
3. Open a multi-file git diff. Toggle collapse on one file. Confirm only that row commits.

## Notes

- Audit-only — no code changes have been made.
- Highest-leverage phases are 5 (per-file diff atom subscriptions) and 7 (prop-object stabilization in the prompt surfaces). Cleanest code-health win is Phase 2's `usePromptAttachmentHandler` deduplication.
- Skipped nits: single-use callbacks, deeply-internal memoized components, and any case where the parent has only one consumer.
