# UI Consolidation and Comprehensive Story Coverage

## Problem

Today the UI lives in two places that pretend to be one design system:

- `packages/ui-core/` — primitives, hooks, theme tokens, `thread-timeline/`
  domain compositions. Has Ladle. Used by `apps/app` and
  `@bb/agent-provider-audit` (the latter only as a Ladle harness).
- `apps/app/src/components/` — everything else. No Ladle. The components
  hardest to iterate on visually (PromptBox, dialogs, the timeline's
  stateful integration, sidebar wiring) live here.

The package boundary between the two was set up to enforce a layer model
("primitives have no domain types"), but the only second consumer
(`agent-provider-audit`) is a Ladle harness that exists to render `ui-core`
itself — i.e., it isn't an independent consumer, it's part of the design
system's tooling. Once `agent-provider-audit` becomes data-only
(`@bb/agent-fixtures`, see the package split plan), `apps/app` is the lone
React consumer of `ui-core`. The boundary stops earning its keep.

Meanwhile, ~3 primitives have stories vs 50+ exports. The components most
worth iterating on visually can't get stories at all because Ladle in
`ui-core` has no providers, and adding Ladle to `apps/app` was deferred
because of the same provider problem. This plan picks that up.

## Goal

1. Fold `packages/ui-core/` into `apps/app/src/components/` so primitives
   live in a single `ui/` folder (shadcn-derived and hand-authored side by
   side) and thread-timeline lives in its own domain folder.
2. Set up Ladle in `apps/app` with a real providers decorator (memory
   router, no-network QueryClient, seedable Jotai store, optional WebSocket
   stub) so any component — stateless or stateful — can be storied.
3. Migrate the existing ui-core stories, then ship eight story batches:
   B0 (Ladle bootstrap), B1–B5 (primitives, with B5 sub-split into
   B5a/B5b/B5c for sidebar), B6 (thread-timeline), B7 (replay-fixture
   stories — the only remaining visualization of the fixture corpus
   after the audit harness is deleted), and B8 (opt-in app-feature
   stories).
4. Delete `@bb/ui-core`. Update the ~64 consumer files to import from
   `@/components/ui/...` and `@/components/thread-timeline/...`.

`@bb/core-ui` (the unrelated domain-formatting helpers package) stays as-is
— renaming it is out of scope for this plan.

## Non-goals

- Splitting apps/app into multiple apps. The whole premise of folding is
  that this stays a single-app repo.
- Standing up a separate Storybook/Ladle deployment artifact. The Ladle dev
  server is for engineers iterating; whether `ladle:build` outputs a
  shareable static site is a follow-up.
- Rebuilding the audit harness's coverage analysis. The package-split
  plan deletes coverage summarizers entirely. B7's fixture stories are
  visual review only; if translation regressions need automated
  detection, that belongs in `@bb/thread-view` or `@bb/agent-runtime`.
- Refactoring stateful components to make them "more storiable." Story
  what's there. If a component is genuinely impossible to story without
  refactor (rare under this plan, since the providers decorator handles
  most things), note it and move on.

## Sequencing

This plan must coordinate with `plans/agent-fixtures-package-split.md`
on one hard ordering constraint and one soft one:

- **Hard:** this plan's Step 3 (Ladle decorator scaffold in apps/app)
  must land **before** the package-split plan's Step 2 deletes
  `agent-provider-audit/.ladle/`. The decorator and ladle.css are
  modeled on the files there. The simplest way to honor this is: this
  plan's Step 3 lands first, period. If that's awkward, the
  package-split plan can defer its `.ladle/` deletion until this plan
  catches up — but no commit may leave the repo in a state where the
  apps/app decorator is missing AND the audit `.ladle/` is gone.
- **Soft:** B7 (replay-fixture stories) imports from
  `@bb/agent-fixtures`. If the rename hasn't happened yet, import from
  `@bb/agent-provider-audit` and rename in the same commit when the
  package split lands. No structural blocker.

The format-unification plan does not block this one but improves it: if
fixtures speak canonical v3, the B7 fixture loader (see "Fixture loader
for stories" below) reads one schema instead of two.

The prior `plans/ui-core-design-system.md` plan is **superseded by this
plan and should be deleted** when this one lands. That plan's Steps 1–6
shipped; its remaining deferred item (visual spot-check after the React
timeline renderer pass) is absorbed into B6's validation here.

## Design

### Final apps/app layout

```
apps/app/
├── .ladle/
│   ├── config.mjs                   // pattern: src/**/*.stories.tsx
│   ├── components.tsx               // GlobalProvider with full app stack
│   └── ladle.css                    // imports app.css (and therefore tokens)
├── src/
│   ├── app.css                      // unchanged
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/
│   │   ├── ui/                      // ← every primitive: shadcn + hand-authored
│   │   │   ├── button.tsx, dialog.tsx, drawer.tsx, …          (shadcn-origin)
│   │   │   ├── pill.tsx, status-pill.tsx, detail-card.tsx, …  (hand-authored)
│   │   │   ├── disclosure.tsx, page-shell.tsx, empty-state.tsx, form-error.tsx,
│   │   │   ├── settings-section.tsx, scroll-to-bottom-button.tsx,
│   │   │   ├── markdown-preview.tsx, image-lightbox.tsx, sonner.tsx,
│   │   │   ├── sidebar.tsx, dropdown-menu.tsx, popover.tsx, tooltip.tsx, …
│   │   │   ├── hooks/               // use-mobile, use-media-query, use-hover-popover
│   │   │   ├── theme.css, cn.ts, utils.ts
│   │   │   ├── *.stories.tsx        // co-located stories
│   │   │   └── README.md            // layer model + admission criteria + shadcn-provenance note
│   │   ├── thread-timeline/         // ← absorbed from ui-core/src/thread-timeline/
│   │   ├── layout/
│   │   ├── messages/
│   │   ├── promptbox/
│   │   ├── settings/
│   │   ├── thread/
│   │   ├── project/
│   │   └── icons/
│   └── ...
```

The README at `src/components/ui/README.md` carries forward the three-layer
model from `ui-core/README.md` verbatim, with one edit: "the boundary is
the package" becomes "the boundary is the folder." Admission criteria, the
litmus test, and the dependency-direction rule survive unchanged. The README
also documents the shadcn-origin marker convention (one-line header
comment on shadcn-derived files), so origin is greppable without splitting
folders.

Note: `components/shared/` does not appear in the final layout. Its
contents redistribute during the migration — anything generic moves to
`components/ui/`, anything domain-shaped moves to `components/thread-timeline/`
or the appropriate feature folder. See Step 1.

### Story co-location

Stories live next to their components: `pill.tsx` ↔ `pill.stories.tsx`.
This is the single biggest quality-of-life win over the current
`packages/ui-core/stories/` mirror tree, which made it easy for stories to
drift out of sync with their components. Co-location means a refactor that
moves a primitive moves its story in the same commit.

### Ladle providers decorator

`apps/app/.ladle/components.tsx` exports a `Provider` (Ladle's global
decorator hook) that wraps every story in:

```tsx
<MemoryRouter>
  <JotaiProvider>
    {" "}
    // fresh seedable store per story
    <QueryClientProvider>
      {" "}
      // per-story client; gcTime: Infinity, no retry
      <WorkerPoolContextProvider>
        {" "}
        // pierre diff worker pool
        <DiffWorkerStub>
          {" "}
          // optional: most stories don't need a real worker
          <ThemeWrapper>
            {" "}
            // applies dark/light class from URL param
            <AppToaster />
            {children}
          </ThemeWrapper>
        </DiffWorkerStub>
      </WorkerPoolContextProvider>
    </QueryClientProvider>
  </JotaiProvider>
</MemoryRouter>
```

Modeled on `apps/app/src/test/queryClientTestHarness.tsx`. Differences:

- **WebSocket** is stubbed by _not_ invoking `useWebSocket` at the harness
  level. Components that need ws state read from atoms; stories pre-populate
  those atoms via a small helper (`seedWebSocketAtoms({ status: "open", ... })`).
- **Router** uses `MemoryRouter` with a Ladle-controlled initial entry. Stories
  that depend on route params accept them via story args.
- **Jotai store** is per-render so two stories on the same page don't share
  state. A `useSeed(seedFn)` hook lets stories declaratively populate atoms.
- **QueryClient** is per-render; stories that need server data use
  `queryClient.setQueryData(...)` to pre-populate cache instead of
  reaching out.

### Story-pattern conventions

- **Visual catalogs** for primitives — every variant of `Pill`, every state
  of `CollapsibleHeader`, every density of `DetailCard`. These double as
  the design system's documentation.
- **Scenario-driven** stories for stateful components — "PromptBox with a
  pending attachment", "Sidebar collapsed with managed children",
  "ThreadTimeline mid-stream with an interrupted tool call".
- **One file per component**, multiple named exports per file. Don't
  fragment a component into N story files; reviewers want every variant
  side-by-side.
- **Hand-written mock props.** No auto-generated story data. Snapshot
  stability matters less than clarity.

### Fixture loader for stories

B7 needs to render fixtures from `@bb/agent-fixtures` inside Ladle, which
runs as a Vite browser bundle. The package's existing loader uses
`node:fs` and isn't browser-safe. Build-time JSON generation
(`fixture-story-data.ts`) is gone after the package split. The
mechanism for B7 is **Vite glob imports**:

```ts
// apps/app/src/components/thread-timeline/replay-fixtures.stories.tsx
const manifests = import.meta.glob(
  "../../../../packages/agent-fixtures/fixtures/**/manifest.json",
  { eager: true, import: "default" },
);
const events = import.meta.glob(
  "../../../../packages/agent-fixtures/fixtures/**/raw-provider-events.ndjson",
  { eager: true, query: "?raw", import: "default" },
);
```

Vite resolves these at bundle time and inlines the corpus into the Ladle
build. No separate generator. No Node dependency at story runtime. The
dev loop is fast because Vite only re-bundles changed files.

To turn the imported JSON+NDJSON into a `FixtureBundle`,
`@bb/agent-fixtures` exports a browser-safe parser:

```ts
// In @bb/agent-fixtures
export function parseFixtureBundleFromJson(args: {
  manifestJson: unknown;
  eventsNdjson: string;
}): FixtureBundle;
```

Browser-safe = no `node:fs`, no `node:path`. Pure zod parsing plus
NDJSON line splitting. Lives next to the existing `load.ts` helpers. The
package's main reader can use this internally too — read the file with
`fs`, then call `parseFixtureBundleFromJson`.

This is a small addition to the package-split plan; coordinate so the
helper lands as part of that plan's Step 2.

### Story batches

Coverage is too large for one PR. Break into batches; each batch is one PR
with stories + any small refactors needed to make the component storiable.

| Batch                                   | Components                                                                                                                                                                                                                                           | Notes                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0 — bootstrap**                      | Ladle config + decorator, migrate the 3 existing ui-core stories                                                                                                                                                                                     | Sets up the harness; no new coverage                                                                                                                                                                    |
| **B1 — controls**                       | Button, Input, Switch, Separator, Skeleton, Pill, StatusPill, LocalhostBadge                                                                                                                                                                         | Stateless, easy wins                                                                                                                                                                                    |
| **B2 — overlays**                       | Dialog, Drawer, Popover, Tooltip, DropdownMenu, ResponsiveOverlay, ImageLightbox                                                                                                                                                                     | Need open-state stories                                                                                                                                                                                 |
| **B3 — layout**                         | PageShell, ThreePaneLayout, BottomAnchoredScrollBody, OverflowFade, EmptyState, ScrollToBottomButton, SettingsSection/Card/Row                                                                                                                       | Mostly visual                                                                                                                                                                                           |
| **B4 — content**                        | DetailCard/Row/Message, ExpandableLine, Disclosure (CollapsibleHeader/ExpandablePanel), DiffStatsTally, MarkdownPreview, EventCodeBlock, FilePathLink, FormError, CopyButton, TruncateStart, SplitButton                                             |                                                                                                                                                                                                         |
| **B5a — sidebar header**                | SidebarHeader, SidebarTrigger, SidebarRail, SidebarInput, SidebarStickyStack, SidebarStickyTier, SidebarProvider, SidebarInset                                                                                                                       |                                                                                                                                                                                                         |
| **B5b — sidebar menu**                  | SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction, SidebarMenuBadge, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton                                                                                  |                                                                                                                                                                                                         |
| **B5c — sidebar groups & footer**       | SidebarGroup, SidebarGroupLabel, SidebarGroupAction, SidebarGroupContent, SidebarFooter, SidebarSeparator, SidebarContent                                                                                                                            |                                                                                                                                                                                                         |
| **B6 — thread-timeline**                | ConversationTimeline, ConversationStatusIndicator, ConversationWorkingIndicator, ThreadContextWindowIndicator, ThreadTimelineRows, TimelineRowHeader/Details, ToolCallDetailBlock, TerminalOutputBlock, TimelineFileDiffBlock, ExpandableTimelineRow | Needs the providers decorator working well; some of these read atoms. Hand-written mock data here; B7 feeds the same components real fixture data                                                       |
| **B7 — replay fixtures** (required)     | One story per fixture in `@bb/agent-fixtures` corpus                                                                                                                                                                                                 | Loaded via Vite glob imports (see "Fixture loader for stories"). This is the **only remaining visualization** of the corpus after the audit harness is deleted in the package-split plan — not optional |
| **B8 — app-feature stories** (optional) | PromptBox, ThreadDetailView, AppSidebar, dialogs (Rename/Delete/Archive variants), HostStatusIndicator                                                                                                                                               | Each only if iteration value > setup cost                                                                                                                                                               |

B0–B7 are the coverage commitment. B7 is required because it replaces
the deleted audit-harness visual review — without it, the fixture corpus
has no visual surface at all. B8 is opportunistic — pick targets driven
by actual design work, not completionism.

Sidebar gets pre-split into three sub-batches (B5a/B5b/B5c) along visual
boundaries. The single-batch alternative is a ~1500-line PR; we'd
rather review three smaller PRs.

### Identifier rename — `@bb/ui-core` import sites

Per AGENTS.md ("when renaming a domain type, search project-wide…"):

```
@bb/ui-core            → @/components/ui
@bb/ui-core/theme.css  → @/components/ui/theme.css
```

64 source files import `@bb/ui-core` today. The `@/` alias already exists
in `apps/app`'s `tsconfig`. Use it directly — no new package alias. The
import lines look like:

```ts
import { Button, Dialog, Pill } from "@/components/ui";
```

Stories and other co-located files use relative imports (`./button`,
`./pill`) so refactors travel together.

## Steps

### Step 0 — Lock the providers-decorator strategy

The structural decisions are settled: single `components/ui/` folder,
imports via `@/components/ui`, `@bb/core-ui` is left alone. Before code
moves, lock the one design choice that affects the decorator:

- **WebSocket stubbing:** the providers decorator pre-populates the
  WebSocket-related Jotai atoms rather than monkey-patching
  `useWebSocket()`. Keeps real components un-modified. A
  `seedWebSocketAtoms({ status, ... })` helper lives next to the
  decorator.

Document the decision in the new
`apps/app/src/components/ui/README.md`.

### Step 1 — Move ui-core into apps/app

The source restructure flattens `ui-core/src/primitives/{ui/,*.tsx}` into
a single `components/ui/` folder. Keep `thread-timeline/` as its own
sibling. Redistribute `apps/app/src/components/shared/`.

1. Create the target: `mkdir apps/app/src/components/ui`.
2. Move shadcn-derived primitives:
   `git mv packages/ui-core/src/primitives/ui/* apps/app/src/components/ui/`.
3. Flatten the hand-authored primitives next to them:
   `git mv packages/ui-core/src/primitives/*.{tsx,ts,css} apps/app/src/components/ui/`
   (covers `pill.tsx`, `status-pill.tsx`, `detail-card.tsx`,
   `disclosure.tsx`, `page-shell.tsx`, `empty-state.tsx`,
   `form-error.tsx`, `settings-section.tsx`,
   `scroll-to-bottom-button.tsx`, `markdown-preview.tsx`,
   `image-lightbox.tsx`, `expandable-line.tsx`, `event-content.tsx`,
   `localhost-badge.tsx`, `diff-stats-tally.tsx`, `file-path-link.tsx`,
   `bottom-anchored-scroll-body.tsx`, `three-pane-layout.tsx`,
   `conversation.tsx`, `overflow-fade.tsx`, `cn.ts`, `utils.ts`,
   `scroll.ts`, `detail-scroll-size.ts`, `theme.css`).
4. Move the hooks subfolder: `git mv packages/ui-core/src/primitives/hooks apps/app/src/components/ui/hooks`.
5. Move thread-timeline: `git mv packages/ui-core/src/thread-timeline apps/app/src/components/thread-timeline`.
6. Move the README and rewrite it:
   `git mv packages/ui-core/README.md apps/app/src/components/ui/README.md`,
   then edit so "the boundary is the package" → "the boundary is the
   folder" and add the shadcn-origin marker convention.
7. Redistribute `apps/app/src/components/shared/`:
   - Components that meet the Layer-1 criteria → `components/ui/`.
   - Components that take domain types but are pure presentation →
     `components/thread-timeline/` or another existing feature folder
     based on what they actually render.
   - Document each move in the PR description so reviewers can spot-check.
8. Update internal imports across moved files. Within
   `components/ui/`, prefer relative imports (`./button`, `./cn`). Outside
   the folder, switch to `@/components/ui` (or `@/components/thread-timeline`).
9. Move dependencies from `packages/ui-core/package.json` to
   `apps/app/package.json`: Radix packages, Vaul, CVA, Sonner,
   lucide-react, tailwind-merge, react-markdown, remark-gfm,
   ansi-to-html. Tailwind and `@pierre/diffs` are already in apps/app.
10. Update every `@bb/ui-core` import across the repo (~64 files in
    `apps/app` plus consumers in tests).
11. Move `packages/ui-core/test/` to `apps/app/src/test/` or co-locate
    per-component — whichever each test reads as more natural.

**Validation:**

- `git grep -n "@bb/ui-core"` returns zero matches.
- `git grep -n "components/shared"` returns zero matches in
  `apps/app/src` (the folder is gone).
- `pnpm exec turbo run typecheck --filter=@bb/app` passes.
- `pnpm exec turbo run test --filter=@bb/app` passes.

### Step 2 — Delete `@bb/ui-core`

1. `rm -rf packages/ui-core`.
2. Remove `@bb/ui-core` from `pnpm-workspace.yaml` if listed by path.
3. Drop `@bb/ui-core` from any lingering `package.json` files.
4. `pnpm install` to update lockfile.

**Validation:**

- `find packages -name 'ui-core' -type d` returns nothing.
- `pnpm exec turbo run build --filter=@bb/app` passes.

### Step 3 — Set up Ladle in apps/app

1. Add `apps/app/.ladle/config.mjs` with `stories: "src/**/*.stories.tsx"`,
   default dark theme.
2. Add `apps/app/.ladle/components.tsx` with the providers decorator (see
   "Design" above). Model it on `agent-provider-audit/.ladle/components.tsx`
   and `apps/app/src/test/queryClientTestHarness.tsx`.
3. Add `apps/app/.ladle/ladle.css` that imports `../src/app.css`.
4. Add `ladle` and `ladle:build` scripts to `apps/app/package.json`.
5. Add `@ladle/react` to `devDependencies`.
6. Migrate the three existing ui-core stories
   (`button.stories.tsx`, `layout.stories.tsx`, `settings.stories.tsx`) from
   `packages/ui-core/stories/` to co-located positions next to their
   components.

**Validation:**

- `pnpm --filter @bb/app ladle` (run by the user) opens with the migrated
  stories visible.
- `pnpm --filter @bb/app ladle:build` produces a static site without errors.

### Step 4 — Story batches B1–B6 (with B5 split into B5a/B5b/B5c)

One PR per batch (8 PRs total for this step: B1, B2, B3, B4, B5a, B5b,
B5c, B6). Each PR:

- Adds story files co-located with the components in the batch.
- Updates `apps/app/src/components/ui/README.md`'s "story coverage"
  table to mark the batch complete.
- Lands no behavior changes to the components themselves unless a story
  exposes a real bug; in which case fix it in the same PR.

Story-quality bar (review checklist):

- Every variant exposed by the props is reachable via a story.
- Every state (loading, empty, error, populated, disabled) has a story or
  is documented in a single "states" story.
- Mock data is hand-written, not imported from production fixtures.
- No story relies on real network, real WebSocket, real timers (fake them
  if needed).

**Validation per batch:**

- `pnpm --filter @bb/app ladle:build` passes.
- A reviewer can scroll the batch's stories and tick every variant in the
  PR description.

### Step 5 — B7: replay-fixture stories

This batch replaces the audit-harness visual review (deleted by the
package-split plan). It's required, not optional.

1. Confirm `parseFixtureBundleFromJson` is available in
   `@bb/agent-fixtures` (added by the package-split plan's Step 2).
2. Add `apps/app/src/components/thread-timeline/replay-fixtures.stories.tsx`.
   The story file uses Vite glob imports to pull every fixture's
   `manifest.json` and `raw-provider-events.ndjson`, parses each via
   `parseFixtureBundleFromJson`, and emits one story per fixture.
3. Each story renders the fixture through `ThreadTimelineRows` (the
   same component B6 stories with hand-written data) using the
   providers decorator to seed any required state.
4. Story names match the fixture id (`excalidraw/claude-code/search-feature`
   etc.) so they're scannable next to the corpus directory.

**Validation:**

- `pnpm --filter @bb/app ladle:build` succeeds with the corpus inlined.
- Every fixture in `@bb/agent-fixtures/fixtures/excalidraw/` and
  `fixtures/dev-replays/` appears as a story.
- Spot-check renders one Claude, one Codex, one Pi fixture without
  errors.
- No build-time generator exists outside Vite — `git grep -n
"fixture-story-data"` returns nothing.

### Step 6 — App-feature stories (optional)

B8 from the table. Only do this for components that have a concrete
near-term design iteration need. For each story:

- Confirm the providers decorator handles its needs. If not, extend the
  decorator (one of the rare cases where decorator changes are
  acceptable mid-batch).
- Land the story alongside whatever feature work it's enabling.

This is opt-in. Do not commit to "all app components have stories" — that's
how the pre-existing plan went sideways with criterion drift.

## Exit Criteria

- [ ] `packages/ui-core/` does not exist.
- [ ] `apps/app/src/components/ui/` contains every primitive (shadcn-derived
      and hand-authored) plus `hooks/`, `theme.css`, `cn.ts`, `utils.ts`.
- [ ] `apps/app/src/components/thread-timeline/` contains the migrated
      ui-core thread-timeline source.
- [ ] `apps/app/src/components/shared/` no longer exists; its contents are
      redistributed.
- [ ] `apps/app/src/components/ui/README.md` documents the layer model,
      admission criteria, dependency direction, story conventions, and the
      shadcn-origin marker convention.
- [ ] `apps/app/.ladle/` exists; `pnpm --filter @bb/app ladle` opens; every
      pre-existing ui-core story renders.
- [ ] B1, B2, B3, B4, B5a, B5b, B5c, B6 complete: every primitive
      listed in the table has at least one story exercising its happy
      path and one exercising an edge case.
- [ ] B7 complete: every fixture in `@bb/agent-fixtures/fixtures/`
      renders as a story under `apps/app/.ladle/`. The mechanism is
      Vite glob imports; no build-time generator exists.
- [ ] `parseFixtureBundleFromJson` is exported from `@bb/agent-fixtures`
      and importable from a browser-target context with no `node:fs`
      transitive dependencies.
- [ ] `plans/ui-core-design-system.md` is deleted (superseded by this
      plan).
- [ ] `git grep -n "@bb/ui-core"` returns zero matches.
- [ ] `pnpm exec turbo run build typecheck test --filter=@bb/app` passes.

## Risks / Decisions

**Loss of structural admission enforcement.** The package boundary stopped
forcing "no domain types in primitives." After this plan, that rule lives
in folder structure + README + code review. The existing AGENTS.md culture
is what makes this acceptable; if review velocity drops or contributor
volume rises sharply, revisit by extracting `components/ui/` back into a
package.

**Providers decorator becomes a gating dependency.** Every batch B6+
relies on the decorator handling more state. If the decorator turns out to
be flaky (atom timing, query cache leakage between stories, MemoryRouter
edge cases), batches will stall. Build it deliberately in Step 3 with
tests, treat regressions as Sev-2.

**WebSocket stubbing strategy.** Pre-populating atoms is cleaner than
mocking the hook, but it pushes some logic out of `useWebSocket` into a
`seedWebSocketAtoms` helper that's only used by stories. That's fine if
the helper stays small. If it grows complex, refactor the WebSocket
subsystem to accept a transport argument instead — but only after a real
need.

**Story drift.** Stories will rot fast if PRs that change components don't
update them. Add story checks to the review checklist; consider a
lightweight CI step (`ladle:build` must pass on PRs that touch
`components/ui/**` or `components/thread-timeline/**`).

**Batch B5 (Sidebar) is huge.** ~20 sub-components. Either split into
B5a/B5b/B5c by visual area (Header / Menu / Footer) or accept a 1500-line
PR. Pre-empt by splitting.

**Replay-fixture loader at story-build time.** B7 has to render
fixtures inside Ladle's Vite browser bundle. The committed mechanism is
Vite glob imports (see "Fixture loader for stories") plus a
browser-safe `parseFixtureBundleFromJson` helper in `@bb/agent-fixtures`.
Risk: if `@bb/agent-fixtures`'s package exports leak `node:fs` imports
through the entry point, Vite chokes. Mitigation: keep
`parseFixtureBundleFromJson` in a leaf module (`load-browser.ts` or
similar) with no transitive Node imports, and add a CI check or unit
test that confirms importing it from a browser-target context succeeds.

**`@bb/core-ui` is deliberately left alone.** Once `@bb/ui-core` is gone
the literal name collision disappears. The `core-ui` name is still mildly
misleading (it's domain formatting helpers, not UI), but renaming is out
of scope. The new `components/ui/README.md` should include a one-line
note that `@bb/core-ui` is unrelated, so future readers don't trip over
it.

**Co-located stories vs. mirror tree.** Co-location is the recommendation,
but `*.stories.tsx` files alongside production code show up in
non-Ladle tooling (typecheck, ESLint, search results). Confirm
`vitest.config.ts` excludes `*.stories.tsx`; confirm the production
build's tree-shaker drops them; confirm ESLint isn't running story-only
rules globally.

**Single `ui/` folder vs. shadcn-only `ui/` + separate `primitives/`.**
The decided layout puts every primitive in `components/ui/` regardless of
origin. The shadcn-derived files carry a one-line header comment marking
provenance so anyone who needs that distinction can grep for it. The
alternative (two folders) was rejected because the "regeneratable from
shadcn CLI" boundary is mostly fiction once a file is customized, and the
split made consumers ask "which folder?" for every primitive.

**Deferred: app-feature stories.** B8 is intentionally optional. Resist
the instinct to story PromptBox just because we now can — story it when
someone is actively iterating on it. The cost of stories that no one
maintains is real.
