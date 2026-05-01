# Thread View Package Boundary

## Goal

End with one shared package for thread timeline rendering, not both
`@bb/core-ui` and `@bb/thread-view`.

The package owns the thread view pipeline:

```text
ThreadEvent[]
  -> ThreadViewProjection
  -> ThreadTimeline
  -> React renderer | CLI text renderer | audit output
```

The immediate problem is shared row grouping and row titles. We should not
invent a full presentation tree until body/detail rendering has a concrete
duplication problem.

## Locked Decisions

- `@bb/core-ui` is not a final package. It must be deleted or emptied during
  this cleanup.
- `@bb/thread-view` is the only shared package for thread timeline rendering.
- `ThreadTimeline` is the semantic grouped model. Grouping lives there, not in
  a presentation layer.
- The near-term presentation boundary is row titles only.
- React and CLI keep rendering bodies/details from semantic `ThreadTimelineRow`
  data for now.
- Shared title logic is exposed through one title presenter, not through helper
  exports such as `buildToolBundleSummaryLabel`,
  `getTimelineDisplayStatus`, `formatToolCallCommand`, or
  `fileChangeIdentity`.
- Root exports stay small: pipeline functions, row title presenter, text
  formatter, and public types.
- Compatibility re-exports from `@bb/core-ui` are forbidden.

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

function getThreadTimelineRowTitle(
  row: ThreadTimelineRow,
  context: ThreadTimelineTitleContext,
): ThreadTimelineRowTitle;

function formatThreadTimelineText(
  timeline: ThreadTimeline,
  options: FormatThreadTimelineTextOptions,
): string;
```

The root should also export the stable public types used by these functions:

- `ThreadEventWithMeta`
- `ThreadViewProjection`
- `ThreadViewState`
- `ThreadTimeline`
- `ThreadTimelineRow`
- `ThreadTimelineRowTitle`
- `RichTitle`
- option/result/context types for the public functions

Everything else is internal unless there is a concrete public use case that
cannot be represented by `ThreadTimelineRow` plus `ThreadTimelineRowTitle`.

## Title Model

Start with plain text:

```ts
interface ThreadTimelineRowTitle {
  plain: string;
}
```

Then add rich title after the plain title path is proven:

```ts
interface ThreadTimelineRowTitle {
  plain: string;
  rich?: RichTitle;
}

interface RichTitle {
  prefix?: RichTitlePart;
  content: RichTitlePart;
  suffix?: RichTitleSuffix;
  active?: boolean;
}

interface RichTitlePart {
  text: string;
  tone: "muted" | "default" | "emphasis" | "danger";
}

type RichTitleSuffix =
  | { kind: "duration"; ms: number }
  | { kind: "diff-stats"; insertions: number; deletions: number }
  | { kind: "text"; text: string; tone: "muted" | "default" | "emphasis" };
```

Layout behavior such as truncation belongs to the renderer. The presenter
defines title meaning and wording, not CSS behavior.

## Export Policy

### Public

- Pipeline functions.
- `getThreadTimelineRowTitle`.
- `formatThreadTimelineText`.
- Stable source/timeline/title types.

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
- activity/highlight internals unless a public renderer genuinely needs them

### Not Thread View

The remaining `@bb/core-ui` exports must not force a second shared package.
They need concrete owners:

- `assertNever`: move to an existing shared owner or inline locally where small.
- `extractErrorMessage` / `toRecord`: move to API/client error handling owner or
  inline in app/CLI clients.
- `formatEnvironmentDisplay`: move to the environment display owner or local
  app/CLI presentation module.
- pending-interaction formatting: either fold into a pending-interaction
  presentation owner or keep local to the current callers.
- `timeAgo` / generic duration helpers: only stay in thread view if used by the
  thread title/text formatter; otherwise move to concrete callers.

## Implementation Steps

1. Define the public title boundary in code.
   - Add `ThreadTimelineRowTitle`.
   - Add `getThreadTimelineRowTitle(row, context)`.
   - Keep `rich` out until `plain` is used by app and CLI.

2. Route existing title/helper logic through the title presenter.
   - Convert tool bundle, assistant step, turn summary, command, file edit,
     delegation, task, error, web, and operation title logic into internal
     presenter functions.
   - Add focused title tests for active and completed rows.

3. Move CLI/audit title rendering onto `getThreadTimelineRowTitle`.
   - CLI text output still renders existing bodies/details.
   - Snapshots verify title output without importing label helpers.

4. Move React row headers onto `getThreadTimelineRowTitle`.
   - React continues rendering details from semantic `ThreadTimelineRow`.
   - Remove direct React imports of title/status/file/command helper functions.

5. Remove helper exports.
   - Root exports contain only the agreed public API.
   - Search confirms app/CLI/audit/server do not import private helpers.

6. Eliminate `@bb/core-ui`.
   - Move or inline remaining non-thread helpers into concrete owners.
   - Remove the package from workspace dependencies.
   - Delete the package once no package imports it.

7. Rename domain/view vocabulary after the title boundary is in place.
   - `ViewProjection` -> `ThreadViewProjection`
   - `ViewMessage` -> `ThreadTimelineSourceRow` or the agreed source-row name
   - `TimelineRow` -> `ThreadTimelineRow`
   - File names should match the public concepts, not old implementation names.

## Deferred

- Full `ThreadTimelinePresentation` tree.
- Structured body/details DSL.
- Rich titles.
- Moving lazy child loading into presentation.

These can be added later if the semantic-row renderers keep duplicating logic.

## Exit Criteria

- There is one shared thread rendering package.
- `@bb/core-ui` is gone or contains no public exports and no dependents.
- Root `@bb/thread-view` exports are limited to the public pipeline, title
  presenter, text formatter, and stable public types.
- App, CLI, audit, and server code do not import label/status/file/command
  helper functions.
- React and CLI get row titles from the same title presenter.
- Existing body/detail rendering is preserved.
- CLI snapshots and focused title tests cover active and completed row
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
