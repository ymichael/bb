# ui-core as a Coherent Design System

## Problem

`packages/ui-core` is at risk of becoming a dumping ground for any stateless
component. Statelessness is necessary but not sufficient for membership — without
admission criteria, ui-core will accumulate one-off presentational components and
stop being a coherent set of primitives that the rest of the codebase can rely on.

The sharper problem is that the current design system is split across the wrong
boundary. The shadcn/Radix wrappers live under `apps/app/src/components/ui`, so
`packages/ui-core` cannot compose the same `Button`, `Dialog`, `Popover`,
`DropdownMenu`, `Input`, `Skeleton`, etc. that the app uses. That forces shared
ui-core components either to duplicate low-level class bundles or to stay in
`apps/app` even when they otherwise belong in ui-core. The dependency direction
is backwards: app code can depend on ui-core, but ui-core can never import from
the app.

At the same time, a lot of UI work in `apps/app` is becoming state-heavy and hard
to iterate on visually. We want a Ladle harness so designers and engineers can
preview components in isolation. Ladle is easy to add to ui-core (pure components,
no providers) and hard to add to `apps/app` (Router, React Query, Jotai atoms,
WebSocket). The right answer is to push more presentational logic into ui-core —
**but only the components that genuinely belong there.**

## Goal

1. Establish a clear three-layer model for where React UI lives, with explicit
   admission criteria.
2. Make `packages/ui-core` the source of truth for generic shadcn/Radix UI
   primitives so shared components can compose them directly.
3. Reorganize `packages/ui-core/src/` to make the layers visible.
4. Stand up Ladle in `packages/ui-core` with two example stories that prove the
   pattern (one primitive, one domain composition).
5. Extract a first batch of components from `apps/app` into the correct ui-core
   folder, with a story added in the same change.

Non-goal: standing up a Ladle harness with mocked providers inside `apps/app`.
Defer that until we've exhausted the simpler approach.

## The three-layer model

### Layer 1 — `packages/ui-core/src/primitives/` (design system)

Generic, reusable, no BB-domain types in the API. If you swapped BB for a
different product, these would still make sense. This layer includes our
shadcn/Radix wrappers; those are design-system primitives, not app components.

**Admission criteria — must satisfy all:**

- No product data dependencies: no queries, atoms, routing, server API calls, or
  BB lifecycle concepts.
- API references zero domain types from `@bb/domain`.
- May have generic local interaction state (`open`, `hovered`, media-query
  matching), but browser persistence such as cookies/localStorage belongs in an
  app wrapper unless the persistence itself is part of the generic primitive API.
- Aligned with a sanctioned visual pattern (page shell, detail card/rows,
  collapsible header, status pill, etc. — see `AGENTS.md` "UI Consistency").
- Replacing it would feel like a design system change, not a feature change.

### Layer 2 — `packages/ui-core/src/{feature}/` (domain compositions)

Pure presentation, but the API references BB domain concepts. Reusable across BB
consumers (`apps/app`, `packages/agent-provider-audit`, future packages).

**Admission criteria — must satisfy all:**

- Pure props in, JSX out. No queries, atoms, routing, or storage.
- Drivable from fixture data alone.
- **Used by ≥2 consumers, or clearly destined to be.** Cross-package reuse is the
  whole point of the package.
- Encodes a canonical rendering of a domain concept that we don't want forking.

### Layer 3 — `apps/app/src/components/`

Components that don't meet Layer 1 or Layer 2 criteria stay here. Used in exactly
one place, no expected reuse, no design-system status — they don't need to move
just because they're stateless. App-owned integration wrappers also stay here:
theme preference wiring, sidebar persistence, router/query/atom glue, and
product-specific containers.

### The litmus test

Before adding anything to ui-core, ask: **"Is this a design-system primitive, or
is it used in ≥2 places?"** If neither, leave it in `apps/app`.

Before leaving a generic shadcn component in `apps/app`, ask: **"Would a ui-core
component reasonably need this to avoid reimplementing our button/menu/dialog
styles?"** If yes, it belongs in `packages/ui-core`.

## Design

### Reorganized `packages/ui-core/src/`

```
packages/ui-core/src/
├── primitives/
│   ├── ui/                     (shadcn/Radix-derived base controls)
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   ├── drawer.tsx
│   │   ├── dropdown-menu.tsx
│   │   ├── input.tsx
│   │   ├── popover.tsx
│   │   ├── responsive-overlay.tsx
│   │   ├── separator.tsx
│   │   ├── sidebar.tsx
│   │   ├── skeleton.tsx
│   │   ├── sonner.tsx
│   │   ├── split-button.tsx
│   │   ├── switch.tsx
│   │   └── tooltip.tsx
│   ├── hooks/
│   │   └── use-mobile.ts
│   ├── pill.tsx
│   ├── status-pill.tsx
│   ├── detail-card.tsx
│   ├── disclosure.tsx
│   ├── event-content.tsx
│   ├── three-pane-layout.tsx
│   ├── page-shell.tsx          (extracted from apps/app)
│   ├── empty-state.tsx         (extracted from apps/app)
│   ├── form-error.tsx          (extracted from apps/app)
│   ├── settings-section.tsx    (extracted from apps/app)
│   ├── scroll-to-bottom-button.tsx  (extracted from apps/app)
│   ├── theme.css
│   ├── scroll.ts
│   └── utils.ts
├── thread-timeline/            (existing — domain composition)
│   └── ...
└── index.ts                    (re-exports unchanged for consumers)
```

`index.ts` continues to flat-export everything so consumers don't notice the
reorganization. Internal imports update to the new paths. Do not add a permanent
`apps/app/src/components/ui` re-export layer; temporary shims are acceptable only
inside a migration PR and must be deleted before the plan is complete.

### Dependency Direction

`packages/ui-core` owns generic UI primitives and may depend directly on Radix,
Vaul, `class-variance-authority`, `sonner`, `tailwind-merge`, and `lucide-react`.
`apps/app` consumes those primitives from `@bb/ui-core`. The app must not be the
source of truth for a generic `Button`, `Dialog`, `Popover`, `DropdownMenu`,
`Input`, `Skeleton`, etc.

Not every current file under `apps/app/src/components/ui` moves unchanged:

- `button`, `input`, `separator`, `skeleton`, `switch`, `tooltip`, `drawer`,
  `responsive-overlay`, `dialog`, `popover`, `dropdown-menu`, and `split-button`
  should move to `ui-core` as generic primitives.
- `sonner` should split: ui-core owns the styled `Toaster` wrapper; `apps/app`
  owns the `usePreferredTheme()` integration.
- `sidebar` should move only after extracting cookie persistence and any app
  layout policy into an app wrapper. The ui-core primitive should be controlled
  or uncontrolled UI state only; app persistence writes the cookie and passes
  `open`/`onOpenChange`.
- `useIsMobile` is a generic viewport hook and should move with
  `responsive-overlay`. Existing app callers should import it from `@bb/ui-core`
  after the move.

### `packages/ui-core/README.md`

Short README that names the three layers, lists the admission criteria for each,
and gives the litmus test. This is the governance — code review enforces it, the
README gives reviewers a citation.

### Ladle setup

Mirror `packages/agent-provider-audit`:

- `.ladle/config.mjs` — points at `stories/**/*.stories.tsx`, dark theme default
- `.ladle/components.tsx` — single `GlobalProvider` applying the dark class
- `.ladle/ladle.css` — imports the shared theme CSS, with `@source` directives for
  ui-core source paths
- `vite.config.ts` — `@tailwindcss/vite` plugin
- `package.json` — `ladle` and `ladle:build` scripts
- Stories use **hand-written mock props**. No `export-ladle-data` step.

**One refactor while we're here:** the shared theme CSS currently lives at
`apps/app/src/app.css`, and `agent-provider-audit` reaches across the monorepo to
import it. Extract the shared token/base layer into a small file (e.g.
`packages/ui-core/src/primitives/theme.css`) that both `apps/app/src/app.css` and
the two `.ladle/ladle.css` files import. App-only utilities such as
`chat-prompt-box` may stay in `apps/app/src/app.css`; tokens used by shadcn
primitives must live in ui-core.

### Story style by layer

- **Primitives** → visual catalogs. Every variant of `Pill`, every state of
  `CollapsibleHeader`. These double as documentation and a forcing function for
  visual consistency.
- **Domain compositions** → scenario-driven. "Timeline with a long tool call
  followed by an error", "ContextPanel with no items", etc. These exist for
  iteration on real product surfaces.

## Steps

Progress:

- [x] Step 1 — shared theme CSS lives in ui-core and app/provider-audit import
      it through the package boundary.
- [x] Step 2 — generic shadcn/Radix primitives moved into ui-core, app imports
      migrated, app-owned toast integration split, and sidebar cookie writes
      removed from the primitive.
- [x] Step 3 — reorganize the remaining ui-core primitives into the visible
      layer structure and document the package boundary.
- [x] Step 4 — scaffold ui-core Ladle and add a primitive story. The timeline
      domain story is deferred until the React timeline renderer exists again.
- [x] Step 5 — extract the first app primitive batch with stories.
- [x] Step 6 — evaluate criteria-gated domain composition moves.

### Step 1 — Extract shared theme CSS

1. Create `packages/ui-core/src/primitives/theme.css` containing the shared
   Tailwind theme, color tokens, base element defaults, and generic utilities
   required by ui-core primitives.
2. Leave app-only utilities in `apps/app/src/app.css` (`chat-prompt-box`,
   app-specific safe-area behavior, or anything that names an app surface).
3. Update `apps/app/src/app.css` to `@import` the ui-core theme file and keep the
   app-only layer locally.
4. Update `packages/agent-provider-audit/.ladle/ladle.css` to import the new
   ui-core theme file instead of reaching into `apps/app/src/app.css`.

**Validation:**

- `pnpm exec turbo run build --filter=@bb/app --filter=@bb/agent-provider-audit`
  passes.
- `packages/agent-provider-audit/.ladle/ladle.css` no longer imports from
  `apps/app`.
- Visual spot-check: thread detail and provider-audit Ladle still use the same
  colors, radii, shadows, and ANSI terminal colors.

### Step 2 — Move shadcn primitives into ui-core

1. Create `packages/ui-core/src/primitives/ui/` and
   `packages/ui-core/src/primitives/hooks/`.
2. Move generic shadcn/Radix wrappers into `primitives/ui/`: `button`, `input`,
   `separator`, `skeleton`, `switch`, `tooltip`, `drawer`,
   `responsive-overlay`, `dialog`, `popover`, `dropdown-menu`, `split-button`,
   and `sidebar`.
3. Move `apps/app/src/hooks/useMobile.ts` to
   `packages/ui-core/src/primitives/hooks/use-mobile.ts`.
4. Split app integrations while moving:
   - `sonner`: ui-core exports the styled `Toaster`; `apps/app` keeps only a thin
     `AppToaster` wrapper that reads `usePreferredTheme()` and passes `theme`.
   - `sidebar`: ui-core owns the visual/sidebar behavior after cookie writes are
     extracted into an app wrapper. The final ui-core primitive must not write
     `document.cookie` directly.
5. Update moved files to use ui-core-relative imports (`../cn.js`,
   `./button.js`, etc.). No `@/` imports are allowed inside `packages/ui-core`.
6. Move Radix/Vaul/CVA/Sonner dependencies from `@bb/app` to `@bb/ui-core`
   when app code no longer imports them directly.
7. Export the migrated primitives from `packages/ui-core/src/index.ts`. Keep flat
   exports for now; add subpath exports later only if the flat surface becomes
   noisy.
8. Migrate app imports from `@/components/ui/...` to `@bb/ui-core`. Delete
   migrated app-local shadcn files before the plan is complete; do not leave a
   permanent compatibility layer.

**Validation:**

- `rg -n "from \"@/|from '@/|@/components/ui|@/hooks/useMobile" packages/ui-core/src`
  returns no matches.
- `rg -n "components/ui/(button|dialog|drawer|dropdown-menu|input|popover|responsive-overlay|separator|sidebar|skeleton|sonner|split-button|switch|tooltip)" apps/app/src`
  returns no matches after import migration.
- `pnpm exec turbo run build --filter=@bb/ui-core` passes.
- `pnpm exec turbo run typecheck --filter=@bb/app` passes.

### Step 3 — Reorganize ui-core into layers

1. Create `packages/ui-core/src/primitives/` and move existing primitives into it
   (`pill`, `status-pill`, `detail-card`, `disclosure`, `event-content`,
   `three-pane-layout`, `scroll`, `utils`).
2. Keep `thread-timeline/` as the existing domain composition folder. Do not move
   app-only containers into ui-core just because they are stateless.
3. Update `index.ts` re-exports to the new paths. Keep the public surface
   identical, plus the newly exported shadcn primitives from Step 2.
4. Update internal imports inside `ui-core` to the new paths.
5. Write `packages/ui-core/README.md` describing the three layers, admission
   criteria, dependency direction, and litmus tests.

**Validation:**

- `pnpm exec turbo run build --filter=@bb/ui-core` passes.
- `pnpm exec turbo run typecheck --filter=@bb/app` passes.
- `git grep -l "from \"@bb/ui-core\"" apps/app packages` shows migrated app
  components consuming ui-core, with no generic shadcn source left in
  `apps/app/src/components/ui`.

### Step 4 — Scaffold Ladle in ui-core

1. Add `.ladle/config.mjs`, `.ladle/components.tsx`, `.ladle/ladle.css`.
2. Add `vite.config.ts` with `@tailwindcss/vite`.
3. Add `ladle` and `ladle:build` scripts to `packages/ui-core/package.json`.
4. Add Ladle to `devDependencies`.
5. Write `stories/primitives/ui/button.stories.tsx` as a visual catalog of every
   button variant and size. This validates that shadcn primitives now live in
   ui-core.

The original plan also asked for a thread-timeline `ToolCallRow` story here.
That would currently be fake coverage: the thread timeline React renderer is
stubbed until the later React pass, and there is no `ToolCallRow` component to
story. Add the thread-timeline domain story in the React timeline renderer pass,
when it can render real rows.

**Validation:**

- `pnpm --filter @bb/ui-core ladle` (run by the user) opens with the button
  story visible and rendering correctly.
- `pnpm exec turbo run build --filter=@bb/ui-core` still passes.

### Step 5 — Extract first batch of primitives

For each of these, move the file into `packages/ui-core/src/primitives/`, update
`apps/app` imports, and add a story in the same PR:

- `PageShell` (apps/app `components/layout/PageShell.tsx`)
- `EmptyState` (apps/app `components/shared/EmptyState.tsx`)
- `FormError` (apps/app `components/shared/FormError.tsx`)
- `SettingsSection` (apps/app `components/settings/SettingsSection.tsx`)
- `ScrollToBottomButton` (apps/app `components/shared/ScrollToBottomButton.tsx`)

Each must satisfy the Layer 1 admission criteria — if any of these turn out to
reference domain types or app context on closer inspection, drop them from this
step and reconsider. While extracting, replace inline prop object types with
named exported props types and compose the Step 2 primitives where that removes
duplicated button/input/menu styling.

**Validation:**

- `pnpm exec turbo run typecheck --filter=@bb/app` passes.
- `pnpm exec turbo run build --filter=@bb/ui-core --filter=@bb/app` passes.
- Each extracted primitive has a story rendering at least its happy path and one
  edge case.
- A grep for the old import paths in `apps/app` returns nothing.

### Step 6 — Domain composition extractions (criteria-gated)

For each candidate from the audit, before moving, confirm: **does this have ≥2
consumers, or is it imminently planned to?** If no, leave it in `apps/app`.

Likely yes (worth moving with stories):

- `ConversationStatusIndicator`, `ConversationWorkingIndicator` →
  `thread-timeline/`
- `ThreadContextWindowIndicator` → `thread-timeline/` (move `useHoverPopover`
  alongside or inline it)

Probably no for now (single consumer, no imminent reuse):

- `HostStatusIndicator`, `WorkspaceChangesList`. Revisit when a second consumer
  appears.

**Validation:**

- Same as Step 4 for any moved component.
- For each component left behind, write down (in the PR description, not the
  code) which criterion failed.

### Step 7 — Defer

The following are explicitly out of scope for this plan:

- **PromptBox container/presenter split** — high-value but a substantial
  refactor on its own. Track separately.
- **Mocked-providers Ladle harness in `apps/app`** — only build this if a
  Layer-2 extraction proves impossible for a component we genuinely need to
  iterate on.
- **Splitting ui-core into `@bb/design-system` + `@bb/ui-core` packages** —
  folder structure + README + code review is enough governance for now.
  Splitting is a one-way door; do it only when the primitives layer has its own
  release cadence and design review process.

## Exit Criteria

- [x] `packages/ui-core/src/primitives/` exists and contains all generic
      primitives. Domain compositions live in named feature folders.
- [x] Generic shadcn/Radix wrappers live in `packages/ui-core/src/primitives/ui/`,
      not `apps/app/src/components/ui`.
- [x] `packages/ui-core/src` contains no app aliases (`@/components`, `@/hooks`,
      or other `@/` imports).
- [x] `packages/ui-core/README.md` documents the three-layer model, admission
      criteria, dependency direction, and litmus tests.
- [x] Shared theme CSS lives in `packages/ui-core/`. Neither `apps/app` nor
      `packages/agent-provider-audit` reaches across the monorepo for it.
- [x] `packages/ui-core/.ladle/` exists. `pnpm --filter @bb/ui-core ladle:build`
      builds working stories.
- [x] At least one primitive story and one thread-timeline domain indicator
      story exist. Add the row-level domain story in the React timeline
      renderer pass once real timeline rows render again.
- [x] Five primitives are extracted from `apps/app` into
      `ui-core/src/primitives/`, each with a story.
- [x] Domain compositions are moved only when they meet the ≥2-consumer
      criterion. Components that don't qualify are documented (in PR
      descriptions) as intentionally staying in `apps/app`.
- [x] App and ui-core builds pass:
      `pnpm exec turbo run build --filter=@bb/app --filter=@bb/ui-core --filter=@bb/agent-provider-audit`.
- [ ] `apps/app` visually unchanged (spot-check thread detail, settings, project
      list). Deferred until the React timeline renderer pass because the thread
      timeline renderer is intentionally stubbed in this cleanup window.

## Risks / Decisions

**Re-exports stay flat.** `index.ts` keeps re-exporting everything so consumers
don't break. Internal folder reorganization is invisible from outside the
package. Add subpath exports only if the flat surface becomes painful in real
call sites.

**ui-core owns shadcn primitives.** The app should not keep canonical copies of
generic shadcn wrappers after this migration. Thin app wrappers are acceptable
only when they inject app policy, such as preferred theme or persisted sidebar
state.

**Don't split into separate packages yet.** Splitting `@bb/design-system` from
`@bb/ui-core` is tempting but premature. The folder structure + admission
criteria README gives most of the value with none of the per-package overhead
(extra `package.json`, extra Turbo target, extra import path to remember). When
the primitives layer is mature enough to warrant its own release cadence and
design review, revisit.

**Reuse, not statelessness, is the admission criterion for Layer 2.** The
biggest risk to the plan is criterion drift — engineers moving things into
ui-core "because they can." Defend this in code review by pointing at the README
and asking the litmus question.

**Ladle scope creep into apps/app.** Tempting to mock providers and story
everything. Resist. The cost of mocked atoms and a fake QueryClient is real,
and most of what we'd want to story should be moved into ui-core anyway. Treat
mocked-providers Ladle as a last resort.

**`useHoverPopover` and other small hooks.** Moving `ThreadContextWindowIndicator`
will probably surface a need for hooks like `useHoverPopover` to also live in
ui-core. Inline trivially, or add a `primitives/hooks/` folder if more than one
hook needs to move. Don't create a separate hooks package.

**Sidebar persistence is the migration hazard.** The current sidebar primitive
writes a cookie directly. That is app policy hidden inside a generic component.
Split it before moving: ui-core owns the sidebar visuals and interaction state;
`apps/app` owns whether and where that state is persisted.
