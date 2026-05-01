# Thread View Package Boundary

## Goal

Create a real package boundary for the thread view pipeline:

```text
ThreadEvent[] -> ThreadViewProjection -> ThreadTimelineRow[] -> renderable text / UI helpers
```

The new package is `@bb/thread-view`. It owns thread event decoding,
projection, grouping, timeline text formatting, and thread timeline helper
logic that is shared by the CLI, audit tools, server timeline service, and
React timeline rendering.

## Non-Goals

- Do not rewrite the React timeline renderer in this slice.
- Do not introduce a new server API contract in this slice.
- Do not move generic helpers such as `assertNever`, `timeAgo`, generic error
  parsing, environment display, or pending-interaction formatting into
  `@bb/thread-view` unless they are directly required by the thread view
  pipeline.
- Do not rename every domain type in one commit. Package ownership comes first;
  type vocabulary can be renamed once imports prove the boundary is right.

## Target Ownership

- `@bb/domain`
  - Durable thread events, scopes, persisted/domain facts, current domain row
    schemas.
- `@bb/thread-view`
  - Decode and normalize thread events for display.
  - Build flat thread view projections.
  - Build grouped thread timeline rows.
  - Format thread timeline rows as CLI/audit text.
  - Provide timeline-specific render helpers for React.
- `@bb/ui-core`
  - React rendering from `@bb/thread-view` and `@bb/domain` types.
- `@bb/core-ui`
  - Temporary package for generic UI-independent presentation utilities and
    backward-compatible re-exports while callers migrate.

## Implementation Steps

1. Create `packages/thread-view` from the current thread-view-related
   `core-ui` implementation and tests.
2. Export the existing public timeline/projection API from `@bb/thread-view`.
3. Make `@bb/core-ui` re-export thread-view APIs temporarily so older callers
   keep working during migration.
4. Migrate direct timeline consumers to `@bb/thread-view`:
   - `apps/server` timeline service and timeline benchmark helper
   - `apps/cli` thread rendering command
   - `packages/agent-provider-audit`
   - `packages/ui-core` thread timeline components/tests
   - app timeline-specific imports
5. Leave generic utility consumers on `@bb/core-ui`.
6. Once callers are migrated, rename modules/types inside `@bb/thread-view`:
   - `ViewProjection` -> `ThreadViewProjection`
   - `ViewMessage` -> `ThreadViewRow` or `ThreadTimelineSourceRow`
   - `TimelineRow` -> `ThreadTimelineRow`
   - `thread-detail-rows.ts` -> `thread-timeline-grouping.ts`
   - `format-timeline-text.ts` -> `thread-timeline-text.ts`

## Exit Criteria

- `@bb/thread-view` exists and builds/tests independently.
- Timeline/projection consumers import from `@bb/thread-view`, not
  `@bb/core-ui`.
- Generic utility consumers are not forced into `@bb/thread-view`.
- `@bb/core-ui` does not own the canonical timeline pipeline anymore.
- The package move is behavior-neutral: snapshots do not change except for
  package names in command strings or test labels if explicitly updated.
- The completed plan file is deleted.

## Validation

Run:

```bash
pnpm exec turbo run typecheck test --filter=@bb/thread-view --force
pnpm exec turbo run typecheck test --filter=@bb/core-ui --force
pnpm exec turbo run typecheck test --filter=@bb/ui-core --force
pnpm exec turbo run typecheck test --filter=@bb/agent-provider-audit --force
pnpm exec turbo run typecheck --filter=@bb/server --force
pnpm exec turbo run typecheck --filter=@bb/cli --force
git diff --check
```
