# Timeline Event Projection Reset

## Goal

Clean up the `ThreadEvent -> ViewProjection` path before adding a new timeline
API contract or rewriting the React renderer.

The next slice should remove the confusing generic execution projection shape and
make commands, generic tool calls, delegations, and file changes project through
row-specific logic with row-specific fields.

## Why This Comes Next

The failed branch had the right destination but added a new semantic timeline
layer on top of the old projection. That kept the old confusion alive and made
the system harder to reason about.

The correct next move is earlier in the pipeline:

```text
ThreadEvent[] -> ViewProjection
```

not:

```text
ViewProjection -> another semantic projection
```

Once the event projection is clean, grouping and rendering can be changed in
smaller, safer steps.

## Decisions Locked For This Slice

- Projection output is flat. It does not own grouping.
- Grouping belongs to the API response / presentation layer, not source
  projection.
- Task/todo/plan updates stay out of the timeline.
- Permission-grant approvals stay visible as timeline rows.
- CLI formatting must remain stable unless a label change is intentional.
- File changes are one projected row per change item, because diff stats belong
  to a specific change and cannot be combined safely.
- Delegation output is represented by child timeline progress, not by inventing
  a second primary output surface.

## Implementation Steps

1. Audit the event inputs that currently feed `exec-lifecycle` and
   `tool-activity-projection`.
   - Identify command lifecycle events.
   - Identify generic tool-call lifecycle events.
   - Identify delegation lifecycle events and child projection updates.
   - Identify file-change lifecycle events and approval/output deltas.

2. Replace the generic execution update shape with row-specific projection
   inputs.
   - Commands carry command-specific fields only.
   - Generic tools carry `toolName`, `toolArgs`, output, approval, duration, and
     status.
   - Delegations carry delegation metadata, status, duration, and child
     projection state.
   - File changes carry one change per row plus stdout/stderr, approval, and
     status where applicable.

3. Remove projection concepts that only exist because several row kinds were
   mixed together.
   - Remove `ExecCallPartial` or narrow it out of the command/tool/delegation
     path.
   - Remove `activeCell` if row-specific lifecycle state makes it unnecessary.
   - Remove shared fields that force unrelated row kinds to pretend they have
     the same shape.

4. Preserve current app and CLI behavior while changing the internals.
   - Expected label changes must be called out explicitly in snapshot diffs.
   - Unexpected formatting churn is a failure.

5. Add only tests that catch real regressions.
   - Prefer provider-audit fixture snapshots for app/CLI structure.
   - Add focused core projection tests for streaming and lifecycle edge cases.
   - Do not add contract tests that only prove a snapshot was generated.

## Exit Criteria

- The command, generic tool, delegation, and file-change projection paths no
  longer depend on one shared "execution" shape with unrelated optional fields.
- The projection model has one obvious owner for each row kind's lifecycle.
- Existing app/CLI timeline output is unchanged except for intentional,
  reviewed label changes.
- The added or changed tests would fail if command/tool/delegation/file-change
  rows were mixed together again.
- No server API timeline contract or React renderer rewrite is introduced in
  this slice.

## Validation

Run:

```bash
pnpm exec turbo run typecheck test --filter=@bb/core-ui --force
pnpm exec turbo run typecheck test --filter=@bb/ui-core --force
pnpm exec turbo run typecheck test --filter=@bb/agent-provider-audit --force
git diff --check
```

