# Thread View Package Boundary

## Goal

End with one shared package for thread rendering, not both `@bb/core-ui` and
`@bb/thread-view`.

The package owns the complete thread view pipeline:

```text
ThreadEvent[]
  -> ThreadViewProjection
  -> ThreadTimeline
  -> ThreadTimelinePresentation
  -> React renderer | CLI text renderer | audit output
```

The important boundary is not the package move. The important boundary is that
app, CLI, audit, and server code consume one presentation model instead of
reaching into ad-hoc helper exports whenever two surfaces disagree.

## Locked Decisions

- `@bb/core-ui` is not a final package. It must be deleted or emptied during
  this cleanup.
- `@bb/thread-view` is the only shared package for thread timeline rendering.
- The root package export is small and boring: pipeline functions plus public
  input/output types.
- Shared text/label logic is expressed through a presentation DSL, not through
  helper exports such as `buildToolBundleSummaryLabel`,
  `getTimelineDisplayStatus`, `formatToolCallCommand`, or
  `fileChangeIdentity`.
- React and CLI render the same `ThreadTimelinePresentation` tree.
- Internal implementation files can keep private helpers, but other packages
  should not import them.
- Compatibility re-exports from `@bb/core-ui` are forbidden. They keep the old
  muddy API alive.

## Public Interface

Root exports should converge to this shape:

```ts
function projectThreadView(
  events: ThreadEventWithMeta[],
  options: ProjectThreadViewOptions,
): ThreadViewProjection;

function buildThreadTimeline(
  projection: ThreadViewProjection,
  options: BuildThreadTimelineOptions,
): ThreadTimeline;

function presentThreadTimeline(
  timeline: ThreadTimeline,
  options: PresentThreadTimelineOptions,
): ThreadTimelinePresentation;

function formatThreadTimelineText(
  presentation: ThreadTimelinePresentation,
  options: FormatThreadTimelineTextOptions,
): string;
```

The root should also export the stable public types used by these functions:

- `ThreadEventWithMeta`
- `ThreadViewProjection`
- `ThreadViewState`
- `ThreadTimeline`
- `ThreadTimelineRow`
- `ThreadTimelinePresentation`
- `ThreadTimelinePresentationRow`
- `RowText`
- `TextTone`
- option/result types for the four public functions

Everything else is internal unless there is a concrete public use case that
cannot be represented by the presentation model.

## Presentation DSL

The shared renderer contract should be segment-based:

```ts
type RowText =
  | {
      kind: "text";
      value: string;
      tone?: TextTone;
      shimmer?: boolean;
      truncate?: boolean;
    }
  | { kind: "duration"; ms: number; tone?: TextTone }
  | { kind: "diff-stats"; insertions: number; deletions: number };

type TextTone =
  | "muted"
  | "default"
  | "emphasis"
  | "destructive"
  | "destructive-emphasis";

interface ThreadTimelinePresentationRow {
  id: string;
  sourceRowId: string;
  kind: "message" | "work" | "group" | "turn";
  summary: RowText[];
  body: ThreadTimelinePresentationBody | null;
  children: ThreadTimelinePresentationRow[] | null;
}
```

`body` should also be structured, not renderer-specific branching:

```ts
type ThreadTimelinePresentationBody =
  | { kind: "markdown"; value: string }
  | { kind: "terminal"; command?: string; output?: string; exitCode?: number | null }
  | { kind: "diff"; path: string; diff: string }
  | { kind: "list"; items: RowText[][] }
  | { kind: "timeline"; rows: ThreadTimelinePresentationRow[] };
```

The presenter owns wording, status labels, file summaries, command formatting,
duration formatting, active shimmer, and diff-stat segments. Renderers only
walk the tree and apply surface-specific styling.

## Export Policy

### Public

- Pipeline functions.
- Presentation DSL types.
- Stable source/timeline/presentation row types.

### Internal

These should stop being root exports and become private implementation details:

- tool bundle label builders
- assistant step summary label builders
- turn summary part builders
- display-status helpers
- command formatting helpers
- file-change identity/name summary helpers
- lifecycle parsers/projection internals
- message-scope helpers
- activity/highlight internals unless represented in presentation output

### Not Thread View

The remaining `@bb/core-ui` exports must not force a second shared package.
They need concrete owners:

- `assertNever`: move to an existing shared owner or inline locally where small.
- `extractErrorMessage` / `toRecord`: move to API/client error handling owner or
  inline in app/CLI clients.
- `formatEnvironmentDisplay`: move to the environment display owner or local
  app/CLI presentation module.
- pending-interaction formatting: either fold into the same presentation system
  if it renders in thread surfaces, or move to a pending-interaction-specific
  owner.
- `timeAgo` / generic duration helpers: only stay in thread view if used by the
  thread presentation DSL; otherwise move to concrete callers.

## Implementation Steps

1. Freeze package movement until the public interface is defined in code.
   - Add the intended root exports to `@bb/thread-view`.
   - Add tests that exercise the public pipeline, not private helper calls.

2. Build `ThreadTimelinePresentation`.
   - Convert existing label/status/file/command helper logic into internal
     presenter functions.
   - Add presentation fixtures for active and completed rows.
   - Cover CLI and app-relevant examples: command, file edit, tasks, error,
     delegation, exploration, web research, turn/group rows.

3. Move CLI/audit formatting onto presentation.
   - `formatThreadTimelineText` takes `ThreadTimelinePresentation`.
   - CLI snapshots verify text output without importing label helpers.

4. Move React timeline rendering onto presentation.
   - React receives `ThreadTimelinePresentationRow[]`.
   - Remove direct imports of helper functions from `@bb/thread-view`.
   - React may own styling and interactions, not wording or summary logic.

5. Remove helper exports.
   - Root exports contain only the agreed public API.
   - Search confirms app/CLI/audit/server do not import private helpers.

6. Eliminate `@bb/core-ui`.
   - Move or inline its remaining non-thread helpers into concrete owners.
   - Remove the package from workspace dependencies.
   - Delete the package once no package imports it.

7. Rename domain/view vocabulary after the presentation boundary is in place.
   - `ViewProjection` -> `ThreadViewProjection`
   - `ViewMessage` -> `ThreadTimelineSourceRow` or the agreed source-row name
   - `TimelineRow` -> `ThreadTimelineRow`
   - File names should match the public concepts, not old implementation names.

## Exit Criteria

- There is one shared thread rendering package.
- `@bb/core-ui` is gone or contains no public exports and no dependents.
- Root `@bb/thread-view` exports are limited to the public pipeline and stable
  public types.
- App, CLI, audit, and server code do not import label/status/file/command
  helper functions.
- React and CLI render from the same presentation tree.
- CLI snapshots and focused presentation tests cover active and completed row
  examples.
- The completed plan file is deleted.

## Validation

Run:

```bash
pnpm exec turbo run typecheck test --filter=@bb/thread-view --force
pnpm exec turbo run typecheck test --filter=@bb/ui-core --force
pnpm exec turbo run typecheck test --filter=@bb/agent-provider-audit --force
pnpm exec turbo run typecheck --filter=@bb/server --force
pnpm exec turbo run typecheck --filter=@bb/cli --force
pnpm exec turbo run typecheck --filter=@bb/app --force
git diff --check
```
