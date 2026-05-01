# Timeline Grouping Boundary

## Goal

Move timeline grouping into an explicit `core-ui` boundary after flat
`ViewProjection` rows, before any server contract or React renderer rewrite.

This slice should make grouping behavior inspectable and shared by CLI/audit
paths first. It should not introduce a new server API contract.

## Why This Comes Next

The event projection path now emits cleaner semantic view messages:

```text
ThreadEvent[] -> ViewProjection
```

The remaining confusion is that grouping is still distributed across timeline
row builders, summary helpers, render text, and React consumers. The next
boundary should be:

```text
ViewProjection -> grouped timeline model -> CLI/audit presentation
```

## Decisions Locked For This Slice

- Source projection stays flat.
- Grouping is derived from projected rows and never mutates source rows.
- Completed/historical turns may be represented as turn groups.
- Active tail activity-run grouping is allowed only inside active turns.
- Activity-run groups summarize consecutive non-terminal work rows only when
  there is more than one row.
- Supported active run labels are exploration, subagents, editing, web
  research, and commands.
- Group status and active wording are derived from children plus active turn
  context, not stored as independent lifecycle state.
- Existing CLI formatting should stay stable except for intentional label or
  grouping changes called out in snapshots.
- React rendering should keep consuming the existing row model until the grouped
  boundary is proven through CLI/audit.

## Implementation Steps

1. Audit existing grouping producers and consumers.
   - `thread-detail-rows`
   - `timeline-assistant-step-summary`
   - `timeline-tool-bundle-summary`
   - `format-timeline-text`
   - `NestedTimelineRows` / `ThreadTimelineRows`
   - provider-audit replay summaries

2. Introduce a named grouped timeline builder in `core-ui`.
   - Keep the existing public row types if possible.
   - Move grouping policy behind one function.
   - Make active-turn context explicit in the function input.

3. Make CLI/audit use the grouped builder through the named boundary.
   - Preserve snapshot output unless a grouping-policy change is intentional.
   - Add readable audit output for the grouped shape if existing output is not
     enough to review the model.

4. Remove duplicated grouping decisions from callers.
   - Callers should choose detail/expansion mode, not recreate grouping rules.

5. Add focused regression tests.
   - Completed turns group as expected.
   - Active tail activity runs group only in active turns.
   - Active labels apply to grouped active tail rows only.
   - Non-active/historical rows keep normal pending/completed status labels.
   - Nested delegation timelines follow the same grouping rules where the data
     is available.

## Exit Criteria

- There is one named `core-ui` boundary for grouped timeline rows.
- CLI and provider-audit use that boundary.
- Existing app rendering is not rewritten in this slice.
- Grouping behavior is covered by tests that would fail if grouping crossed
  assistant/user boundaries or grouped inactive historical work incorrectly.
- No server API timeline contract is added.
- The plan file is deleted when the slice is complete.

## Validation

Run:

```bash
pnpm exec turbo run typecheck test --filter=@bb/core-ui --force
pnpm exec turbo run typecheck test --filter=@bb/ui-core --force
pnpm exec turbo run typecheck test --filter=@bb/agent-provider-audit --force
git diff --check
```

