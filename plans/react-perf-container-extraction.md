# React Perf: Container Extraction Plan

## Status: In Progress (Phase 1 + Phase 2A complete)

## Context

ThreadDetailView owns several mega-hooks (`useGitDiffPanel`, `useThreadTimelineController`) whose internal `useState` calls cause full-subtree re-renders on every UI toggle. Phase 1 (this branch) fixed the worst offenders by atomizing cross-cutting state. Phase 2 (this plan) moves the hooks into scoped containers so the remaining useState calls stop cascading through ThreadDetailView.

## Phase 1 — Complete (this branch)

- `activeSecondaryPanelAtom` — panel navigation backed by localStorage + URL sync.
- `selectedMergeBaseBranchAtom` — merge-base branch selection shared across prompt banner / diff panel / git-action dialog.
- `gitDiffCollapsedFileKeysAtom` / `gitDiffLoadingFileKeysAtom` — diff file collapse + render queue.
- `threadTimelineShowScrollToBottomAtom` — scroll indicator.
- `threadSecondaryPanelResizingAtom` — drag handle visual.
- `gitDiffDisplayModeAtom` — workaround; will be replaced by local state after Phase 2.
- Dead state removed: `isStickingToBottom`, `useThreadStorageViewer.{effectiveThreadStoragePath, isManagerThread}`, `shouldLoadMergeBaseBranchOptions`, `isMergeBaseBranchPickerOpen`.
- CSS containment + transition fixes for browser-side layout cost.

## Phase 2 — Container Extraction

### Step A: Extract diff state into ThreadSecondaryPanel — COMPLETE

Created `useGitDiffPanelState.ts`. This hook:
- Owns the diff-specific state currently in `useGitDiffPanel`: `parsedGitDiffFiles`, `isParsingGitDiffFiles`, `lastParsedGitDiffKey`, `selectedGitDiffCommitSha` (replace atom if still used), `pendingGitDiffScrollPath`, `gitDiffDisplayMode` (replace atom with local state).
- Calls `useGitDiffFileRenderQueue` internally (collapsed/loading atoms can revert to local state here).
- Calls `useEnvironmentGitDiff`, `useEnvironmentMergeBaseBranches` queries internally.
- Renders the diff toolbar (commit dropdown, display mode toggle, expand/collapse-all, stats) and the file card list.
- Mounted inside `ThreadSecondaryPanel` whenever `isSecondaryPanelOpen` is true (not only when diff tab is active) to preserve state across tab switches. Gates visible output on `activePanel === "git-diff"`.

`useGitDiffPanel` shrinks to `useThreadSecondaryPanel`: only panel navigation callbacks + `openDiffFile` + `useResponsiveGitDiffPanelDisplay`. Eventually most of this can be inlined or split across the secondary panel + button handlers.

**Exit criteria**: Clicking expand/collapse-all, opening the diff commit dropdown, or toggling the merge-base picker no longer re-renders the timeline pane or the prompt area. Only the diff tab content re-renders.

### Step B: Extract ThreadTimelineContainer

Create a container component that wraps `ThreadTimelinePane` + `ThreadDetailPromptArea` (the composer footer). It owns `useThreadTimelineController` internally. The controller's `loadingToolGroupIds` / `toolGroupMessagesById` states become local to this container.

The container takes the timeline header as a ReactNode slot. The composer footer is built inside the container (it needs `promptComposerRef` and `scrollToBottom` from the controller).

**Exit criteria**: `loadingToolGroupIds` / `toolGroupMessagesById` state changes no longer re-render ThreadDetailView or the secondary panel.

### Step C: Cleanup

- Delete `gitDiffDisplayModeAtom` — replaced by local useState in ThreadGitDiffPanel.
- Delete `gitDiffCollapsedFileKeysAtom` / `gitDiffLoadingFileKeysAtom` — replaced by local useState in ThreadGitDiffPanel.
- Consider whether `selectedGitDiffCommitShaAtom` and `pendingGitDiffScrollPathAtom` are needed (only if `openDiffFile` is called from outside the container; if so, keep as atoms).
- Audit remaining useState calls in `useGitDiffPanel` / ThreadDetailView to confirm none cause unnecessary cascades.

## Validation

- Typecheck: `pnpm exec turbo run typecheck --filter=@bb/app`
- Tests: `pnpm exec turbo run test --filter=@bb/app`
- Manual: Open the diff tab with a large diff. Use react-scan to verify:
  1. Expand/collapse-all only re-renders diff cards.
  2. Resizing panels: no react re-renders beyond the handle.
  3. Scroll-to-bottom indicator toggle: only the button re-renders.
  4. Opening merge-base picker: only the picker popover re-renders.
  5. Tab switches: only the secondary panel + header toggle re-render (not the timeline or prompt area).
