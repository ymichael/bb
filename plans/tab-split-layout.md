# Tab + Split Layout

## Goal

Replace the fixed primary-pane / secondary-panel layout with a flexible tab+split system. Standardize how file paths surface across the UI (timeline, file lists, modals) on a single click vocabulary backed by this new layout.

## Why now

Two adjacent problems landed in the same conversation:

1. **File-link UX is incoherent.** Different surfaces show paths with different click actions (open editor, open diff, nothing) and inconsistent affordance (sometimes underline-on-hover, sometimes plain text, sometimes "clickable but click toasts an error"). See _File-link surface map_ below.
2. **The current layout can't host the resolution.** The right answer for "what should clicking a file do?" includes a third action — open a **preview** of the file — which has nowhere to live. The secondary panel holds exactly one of {Diff, Info, Storage} at a time. Stacking N file previews on top requires either replacing what's there (lossy) or stealing a tab strip we don't have.

Taken together: we need tabs in the secondary area, and once we have tabs, splits become cheap, and the layout system is itself the right primitive for "open this file alongside this other thing."

## End-state UX

### Click vocabulary

Four verbs across the app:

| Verb | Icon (lucide) | Available when |
| --- | --- | --- |
| Open in editor | `external-link` | local host + daemon connected + editor target configured |
| Open diff | `git-compare` | thread is non-manager + file has changes vs merge base |
| Open preview | `eye` | file readable from workspace |
| Copy path | `copy` | always |

**Default click per surface** picks the most contextual verb. **Underline appears iff the default click resolves to an action that is currently available.** No "clickable, click toasts an error" anywhere — when the default click isn't currently available, the surface renders as a plain `<span>`. No fallback verb chain.

Secondary actions (e.g. "Copy path") live on a per-surface basis where useful — currently a `MoreHorizontal` kebab menu on the diff banner per-file header. They are **not** revealed as a hover icon row on every surface; the noise wasn't worth it.

Surface → default click table:

| Surface | Default click | Secondary actions |
| --- | --- | --- |
| Diff banner per-file header (inside diff view) | Open editor (`external-link` suffix icon, always shown when openable) | kebab → Copy path |
| Info tab "Changed files" | Open diff | — |
| Prompt banner files | Open diff | — |
| Commit / squash modal | None (plain span) | — |
| `FileEditRow` header (timeline) | Open diff | — |
| `ExplorationDetailList` lines (timeline) | Open preview | — |
| Markdown links in prose / subagent output | Open editor (no fallback today) | — |
| Bash output / error text paths | Nothing (free-form text — out of scope) | — |
| User attachment basenames | Open preview | — |

### Layout primitive

Layout becomes a tree:

```
Layout   = Split | TabGroup
Split    = { direction: "horizontal" | "vertical", children: Layout[], sizes: number[] }
TabGroup = { tabs: Tab[], activeTabId: string }
Tab      = { id, kind, params }

TabKind =
  | { kind: "timeline" }                           // includes the composer; pinned content but movable as a tab
  | { kind: "diff" }                               // current secondary "Diff" mode (workspace overview)
  | { kind: "info" }                               // current "Info"
  | { kind: "thread-storage" }                     // current "Thread Storage" (manager threads)
  | { kind: "file-diff", path: string }            // per-file diff
  | { kind: "file-preview", path: string }         // rendered preview (markdown rendered, code highlighted)
  | { kind: "file-source", path: string }          // raw source view
```

Today's layout is a degenerate case of this tree:
- Primary only → `TabGroup([timeline])`
- Secondary open → `Split(horizontal, [TabGroup([timeline]), TabGroup([diff|info|storage])])`

### Decided constraints

- **Timeline is movable** as a tab. It is _not_ a permanently-pinned region.
- **Composer is part of the timeline tab.** Always rendered with it; moves with it.
- **Cap at 4 leaf groups.** Adjustable later — store the cap as a config value, not a magic number.
- **Persistence is per-thread.** Layout (split shape, sash positions, tab list, active tab) lives in an `atomFamily` keyed by `threadId`. Deduped tab opening: clicking a path that already has an open `(kind, path)` tab focuses it instead of opening a duplicate.
- **No shareable deep links.** Refresh restoration is sufficient. URL state stays minimal.
- **Mobile fallback.** Below ~800px, splits are disabled. The timeline is full-width; the secondary content (whatever tab(s) the user opened) lives in the existing Vaul drawer as a single tab group.

## Architecture choice: Dockview + jotai adapter

After a library survey (see _Library evaluation_ below), we use [Dockview](https://github.com/mathuo/dockview) (`dockview-react`).

**Why Dockview:** it's the only React docking library that ships every requirement out of the box — splits, tabs, drag-to-reorder, drag-to-split, JSON `toJSON()`/`fromJSON()`, React 19 support, MIT, actively maintained in 2026. Drag-to-split is the single hardest piece to build correctly; Dockview gives it for free.

**Cost:** ships its own scoped CSS theme. We re-skin via CSS variable overrides to match our Tailwind tokens — same approach we use for Sonner / Vaul.

**State integration:** Dockview's API is imperative. Wrap it in a thin jotai adapter:
- Layout JSON lives in an `atomFamily` keyed by `threadId`.
- On mount, hydrate via `api.fromJSON(layout)`.
- Subscribe to `api.onDidLayoutChange()` and write back to the atom.
- Tab content is rendered through Dockview's React component registry; each `TabKind` registers a renderer.

## File-link surface map

All surfaces that render a file path today. **Done** = migrated to `FilePathLink` and aligned with the click vocabulary in this plan; **Pending** = still on its original ad-hoc rendering, scheduled for Phase 2b.

**File-list surfaces:**
- ✅ Done — `apps/app/src/views/ThreadSecondaryPanel.tsx` (diff banner per-file header) — `FilePathLink` with `variant="external"` + kebab "Copy path"
- ✅ Done — `apps/app/src/views/ThreadDetailSecondaryContent.tsx` (Info tab) — `WorkspaceChangesList` → `FilePathLink`, click opens diff panel
- ✅ Done — `apps/app/src/views/ThreadFollowUpComposer.tsx` (prompt banner) — `WorkspaceChangesList` → `FilePathLink`, click opens diff panel
- ✅ Done — `apps/app/src/components/thread/ThreadGitActionDialog.tsx` (commit/squash modal) — `WorkspaceChangesList` → `FilePathLink`, plain span (no click)

**Timeline surfaces:**
- ✅ Done — `packages/ui-core/src/thread-timeline/rows/FileEditRow.tsx` (Write/Edit tool path) — `FilePathLink`, click opens diff panel via `onOpenFileDiff`
- ⏳ Pending Phase 2b — `packages/ui-core/src/thread-timeline/ConversationMarkdown.tsx` markdown links (clickable today via `onOpenLocalFileLink` → editor; markdown semantics still open)
- ⏳ Pending Phase 2b — `packages/ui-core/src/thread-timeline/rows/DelegationRow.tsx` subagent output markdown (uses `ConversationMarkdown`, follows above)
- ⏳ Pending Phase 2b — `packages/ui-core/src/thread-timeline/rows/ExplorationDetailList.tsx` (Read/Glob/Grep summary lines, static)
- ⏳ Pending Phase 2b — `packages/ui-core/src/thread-timeline/rows/ToolExploringRow.tsx` and `ToolBundleBody.tsx` exploration mode summaries (static)
- ⏳ Pending Phase 2b — `packages/ui-core/src/thread-timeline/rows/UserMessageRow.tsx` attachment basenames (typed but not clickable)
- ❌ Out of scope — `packages/ui-core/src/thread-timeline/rows/TerminalOutputBlock.tsx` bash output (free-form ANSI text)
- ❌ Out of scope — `packages/ui-core/src/thread-timeline/rows/ErrorRow.tsx` paths in error messages (free-form)

## Phased implementation

Each phase independently shippable. Land Phase 1 first to de-risk Dockview integration before any user-visible change.

### Phase 1 — Dockview adapter, no UX change

Replace the secondary panel with a Dockview tab group rendering exactly one tab at a time. Same visible behavior as today — Diff / Info / Storage selected via the existing tab strip; toggling secondary panel open/closed equals adding/removing the second split child.

**Scope:**
- Add `dockview-react` dep.
- Add `apps/app/src/views/layout/` containing the jotai adapter (`useLayoutModel`, `layoutAtomFamily`, hydrate/persist hooks) and a CSS file overriding Dockview's theme variables to our tokens.
- Replace `ThreadSecondaryPanel`'s primary/secondary structure with a Dockview root. Keep panel kinds limited to the existing three: `diff`, `info`, `thread-storage`.
- Mobile: branch on viewport — if narrow, render the tab content inside the existing Vaul drawer instead of Dockview.

**Exit criteria:**
- Visual diff vs main: zero. Same panel widths, same tab affordances, same toggle behavior.
- `pnpm exec turbo run typecheck --filter=@bb/app` passes.
- Smoke: open app at `:5173`, switch between Diff / Info / Thread Storage tabs, resize the split sash, refresh page, layout restores.
- Smoke (mobile): resize browser to < 800px, secondary content collapses into the drawer.

### Phase 2a — File-link primitive ✅ done

Land the shared `FilePathLink` component and migrate the file-list surfaces + `FileEditRow` so they share one rendering path with consistent clickability rules. Layout-independent — does not depend on Phase 1.

**Scope (shipped):**
- `FilePathLink` in `@bb/ui-core` with API: `path`, `displayName?`, `onClick?`, `variant?: "external"`, `className?`. Renders as a non-interactive `<span>` when `onClick` is undefined; renders as a `<button>` with `hover:underline` when `onClick` is set; appends an `external-link` icon when `variant="external"` and the action is available. No verb resolution, no hover icon row — kept deliberately thin per the conversation that produced this plan.
- Migrate `WorkspaceChangesList` (Info tab, prompt banner, commit/squash modal), the diff banner per-file header, and `FileEditRow` (timeline) to `FilePathLink`. Wire click handlers from existing app-level openers (`openDiffFile`, `useLocalOpenTargets`).
- Add a kebab menu with "Copy path" on the diff banner per-file header (only).
- Plumb `onOpenFileDiff` through `ThreadTimelineRows` → `ConversationEntry` → `FileEditRow`. Gate on `canUseGitUi` at the construction site so manager threads don't surface clickable links that route to a hidden panel.
- Tighten the diff banner clickability so it disappears (plain span) when the daemon is disconnected — no clickable-but-toast.
- Subagent placeholder fix as a related drive-by: `DelegationRow` shows "Working…" only when the subagent itself is `pending`, not when a parent prefers ongoing labels.

**Validation (met):**
- `pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/ui-core` passes.
- `@bb/ui-core` tests cover `FilePathLink`'s three rendering modes (span, button, button + icon) plus the contract case `variant="external"` without `onClick` (icon must be dropped). Tests use `@testing-library/react` + `fireEvent.click` and assert handler invocation with the path argument.
- `@bb/ui-core` tests cover `FileEditRow` `onOpenFileDiff` wiring (real click → handler called with the change path).
- `@bb/ui-core` tests cover `DelegationRow` placeholder gate, including the regression for `preferOngoingLabels=true` + `status="completed"`.

### Phase 2b — File tabs and remaining surfaces

Add the three new tab kinds (`file-diff`, `file-preview`, `file-source`) and migrate the remaining timeline surfaces to `FilePathLink`. Gated on Phase 1 (file tabs need a tab system to live in).

**Scope:**
- Define `TabKind` union and a tab content registry keyed by `kind`.
- Implement `file-diff` tab: same renderer as the existing per-file diff card.
- Implement `file-preview` tab: markdown → rendered; code → syntax highlighted via existing highlighting; binary/large → "preview unavailable, open in editor or download" affordance.
- Implement `file-source` tab: raw text view.
- Dedupe: opening `(kind, path)` focuses the existing tab if any.
- File content fetch: reuse existing thread-storage / workspace-file routes. Confirm a `readWorkspaceFile` daemon command exists for non-storage paths; if not, that's a prerequisite scoped under this phase.
- Extend `FilePathLink` if needed: a second `variant` (e.g. for "preview") may be added when a surface needs to telegraph "this opens a preview" the way the diff banner telegraphs "external editor." Otherwise leave the API as-is.
- Migrate the pending timeline surfaces (`ExplorationDetailList`, `ToolExploringRow`, `ToolBundleBody` exploration mode, `UserMessageRow` attachments) to `FilePathLink`. Default click for each per the surface table above.
- Resolve markdown-link semantics (open decision #2) before touching `ConversationMarkdown` / `DelegationRow` output.

**Exit criteria:**
- All Pending surfaces in the file-link surface map are migrated to `FilePathLink` and route to the documented default click.
- Opening the same file twice produces one tab, not two.
- Manual smoke from each surface listed in the click vocabulary table fires the documented default verb.

### Phase 3 — Splits

Enable drag-to-split and drag-tab-between-groups. Cap the leaf-group count.

**Scope:**
- Wire Dockview's drag-to-split surface; intercept and reject drops that would exceed the leaf cap (default 4, configurable).
- Persist the new branching shape in the layout atom.
- Tighten mobile branch — splits remain disabled, but a single tab group with multiple tabs works.

**Exit criteria:**
- Drag a tab to a group edge → splits the group.
- Drag a tab between groups → moves it.
- Attempting to create a 5th leaf shows a non-blocking toast and rejects the drop.
- Refresh restores the split layout exactly.

### Phase 4 — Movable timeline

Allow the timeline tab to move between groups. Composer follows it.

**Scope:**
- Register `timeline` as a tab kind. Initial layouts seed with a `Tab(timeline)` in the leftmost group.
- Verify composer sizing/sticky behavior survives being inside arbitrary group widths.
- A guard: at least one `Tab(timeline)` must exist somewhere in the tree (don't allow closing the last one).

**Exit criteria:**
- Drag the timeline tab to a different group → it moves; composer follows.
- Closing the timeline tab is blocked with a hint ("the timeline tab can't be closed").
- Refresh restores the timeline's group placement.

## Library evaluation

Captured for future reference; full notes in conversation thread.

| Library | Splits | Tabs | Drag reorder | Drag-to-split | JSON persist | React 19 | License | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Dockview** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | MIT | Pick this |
| FlexLayout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | MIT/ISC | Solid fallback |
| react-mosaic | ✓ | — | — | — | ✓ | ✓ | Apache-2.0 | No (no tabs) |
| rc-dock | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Apache-2.0 | Workable; Ant baggage |
| Build on `react-resizable-panels` | ✓ | DIY | DIY | DIY | DIY | n/a | — | Only if Dockview theming dies |

`trees.software` (= `@pierre/trees`) is a file-tree rendering library, not a docking system. Unrelated to this plan, but worth remembering for a future workspace file browser.

## Open decisions

To resolve before the corresponding phase starts. Defaults listed are my recommendation; flagged for explicit confirmation.

1. **Preview content fetch on remote envs.** Local-host threads can read via existing daemon paths. Remote-env threads need either a `readWorkspaceFile` daemon command or a server-side proxy. **Default:** add a daemon command, behind the same auth as existing workspace reads. Resolve before Phase 2b.
2. **Markdown link click semantics.** Today: `<a href="/abs/path">` with regex auto-detection. **Open:** what verb does a markdown link in prose default to once preview exists — editor only, editor with preview fallback, or preview only? Resolve before migrating `ConversationMarkdown` in Phase 2b.
3. ~~**Modal default click.**~~ **Resolved (Phase 2a):** modal files render as plain spans. No click, no kebab, no copy-path affordance — copy-path lives only on diff rows.
4. **Tab-state URL representation.** None today; secondary panel kind is in URL. **Default:** drop URL state for tabs entirely; rely on per-thread layout atom for restoration. Resolve before Phase 1.
5. **Composer placement when timeline moves.** **Default:** composer is part of the timeline tab content; if the timeline is in a narrow group, composer wraps. Confirm in Phase 4.

## Out of scope

- **Free-form path linkification** in Bash output / error message bodies. Retrofitting clickable paths inside ANSI-rendered text or arbitrary error strings is high-effort, low-precision, and surfaces a small fraction of the value of the typed-data clickable surfaces. Document and skip.
- **Drag-to-split between threads.** Tabs are per-thread. Switching threads loads that thread's layout atom; tabs don't migrate.
- **Floating panels** (Dockview supports them). No clear use case in our app shell. Disable in the Dockview options.
- **Pinning tabs / "preview" italic-tab semantics** (VS Code's single-click-preview behavior). v2 if users complain about tab clutter.
- **Workspace file browser** (sidebar tree of all files). A separate feature; would use `@pierre/trees` if we adopt it.

## Validation

Per-phase exit criteria above. Cross-phase regression validation:

- Typecheck across affected packages: `pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/ui-core`.
- Existing render tests for `WorkspaceChangesList`, `DelegationRow`, `ToolBundleBody`, etc. continue to pass after Phase 2's `FilePathLink` swap.
- Manual smoke test against each of the eight default-click surfaces in the surface map after Phase 2 lands.
