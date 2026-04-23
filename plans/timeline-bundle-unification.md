# Timeline Bundle Unification

## Problem

Inside a turn-summary, the timeline currently renders two layers of grouping:

```
Explored 1 search, ran 3 commands   ← assistant-step-summary
  Explored 1 search                 ← tool-bundle (exploration)
    Search foo …                    ← leaf
  Ran 3 commands                    ← tool-bundle (commands)
    ls
    pnpm test
    pnpm build
```

The inner layer adds no information the outer layer doesn't already convey, and it forces two clicks to reach the actual leaf a user wants to inspect. The two row types — `tool-bundle` and `assistant-step-summary` — grew independently, and the "single-kind step" case is today special-cased via a `presentation: "assistant-step-summary-placeholder"` shortcut that skips the step wrapper. Single-kind vs multi-kind ends up encoded in both the data model and the rendering, for no user-visible reason.

## Target model

**One row type for grouped work.** It holds a flat list of leaf messages and derives a label from their kinds. Whether the contents are all one kind ("Ran 3 commands") or many ("Ran 3 commands, explored 1 search") is an emergent property of the `rows` field, not a different row kind.

```ts
interface TimelineBundleRow {
  kind: "bundle";
  id: string;
  rows: TimelineMessageRow[];   // always flat leaves
  // …plus sourceSeq, startedAt, createdAt, status, durationMs, turnId
}
```

No `bundleKind`, no `presentation` discriminator, no nested bundles.

### Lifecycle

A bundle is visual grouping. *When* we build it determines what it contains:

- **Open stretch (still working)** — greedy same-kind bundling of adjacent messages, exactly like today's `buildToolBundleRows`. Small labeled bundles sit next to standalone non-bundleable rows (errors, tasks, delegations, etc.).
- **Closed stretch** (the stretch is terminated by an `assistant-text`, or ends at the terminal boundary of a completed turn) — absorb every leaf from the preceding bundles plus every standalone row into **one** bundle. That bundle's label spans multiple kinds; its `rows` are flat.

The existing active-vs-completed turn distinction becomes "do we absorb at boundaries yet or not" — no new concept.

### Label builder

A pure function over `MessageRow[]`:

1. Walk messages, classify each by kind (exploration / file-edits / commands / web-research / delegations / tools / tasks-etc fallback).
2. Aggregate counts per kind.
3. Emit phrases in first-appearance order, joined by commas, with the first capitalized.

Today's `formatTimelineAssistantStepSummary` already does step 2–3 over `(tool-bundle | message)[]`; the refactor is mechanical — it reads the same facts from messages directly.

## Migration plan

Three commits. Each is independently shippable; 1 and 2 don't change rendered output.

### Commit 1: introduce the unified bundle type

- Add `TimelineBundleRow` in `@bb/domain` alongside the existing types. (Name TBD — see Open Questions.)
- Teach `@bb/core-ui` builders to emit `TimelineBundleRow` with flat leaves in both the open-stretch and closed-stretch cases.
- Label builder moves from `TimelineAssistantStepSummaryChildRow[]` to `TimelineMessageRow[]`.
- Update callers in `@bb/ui-core`, CLI rendering, and audit fixtures to consume the new shape.
- Delete `TimelineToolBundleRow`, `TimelineAssistantStepSummaryRow`, the `"assistant-step-summary-placeholder"` presentation marker, `materializeAssistantStepSummaryRows`, and the `bundleKind` field. These have no remaining consumers once the migration is done.

### Commit 2: collapse the rendering path

- Remove `AssistantStepSummaryEntry` and the single-kind `ToolBundleEntry` placeholder branch.
- One component renders the new bundle: expandable header with derived label, expansion body renders `rows` as a flat list via the existing leaf row components.
- Adopt the spacing you want inside the expansion (tighter than the default `pt-1`, closer to the exploration detail list feel). Pass it via `rowContainerClassName` scoped to bundle children only.
- Update snapshot tests; update `grouped-summary-presentation.ts` or delete it if no longer needed.

### Commit 3: validate at the public surfaces

- Replay fixture snapshots (`packages/agent-provider-audit`) update to show the collapsed structure. Audit visually for regressions.
- CLI rendering snapshots (`timeline-cli-rendering.snapshots.test.ts`) update and audit.
- Manual sweep of representative threads in the dev app: a turn with mixed-kind work, a turn with only commands, an active turn, an error turn, a multi-step turn with intermediate assistant-text.

## Validation / exit criteria

- `pnpm exec turbo run typecheck test --filter=@bb/domain --filter=@bb/core-ui --filter=@bb/ui-core --filter=@bb/agent-provider-audit` passes.
- The turn from `thr_tgkmx3ce85` (3 commands + 1 search, no mid-turn assistant-text) renders "Ran 3 commands, explored 1 search" → expand → 3 command rows + 1 exploration row, flat, no intermediate bundle wrappers.
- A turn with a single kind (only commands) renders "Ran N commands" → expand → N flat command rows. Same visual tier as the mixed case — no de-emphasized placeholder variant.
- Active turns (pending status) still show small same-kind bundles + standalone rows as they do today, with no step-level absorption until a completing `assistant-text` lands.
- No `tool-bundle`, `assistant-step-summary`, `bundleKind`, or `assistant-step-summary-placeholder` string appears anywhere under `packages/` or `apps/` after the migration (rg check).

## Open questions

1. **Name.** `bundle`? `group`? `grouped-work`? `tool-bundle` is misleading once it holds tasks/delegations/errors; `assistant-step-summary` is wordy and turn-centric. My vote: `bundle`, matching the mental model you sketched.
2. **Status aggregation across kinds.** Today's closed-stretch status comes from merging child-bundle statuses. Under the unified model we merge leaf message statuses directly — equivalent in outcome, but the reduction is now over more rows. Any preference on priority order? (Current: pending > error > interrupted > completed, via `mergeGroupedRowStatus`.)
3. **`durationMs`.** A closed-stretch bundle spans many messages; duration = last message `createdAt` − first message `startedAt`. Is that the interval you want to display, or do you want only the final assistant-text's `createdAt` as the endpoint?
4. **What happens to same-kind adjacency inside a closed bundle.** Example: a closed bundle contains `[cmd, cmd, explore, cmd, cmd]`. The label reads "Ran 4 commands, explored 1". The expansion shows the rows in *source order* (cmd, cmd, explore, cmd, cmd) — not reordered by kind. Confirm: order is preserved, label doesn't care about adjacency.
5. **Error rows inside the bundle.** An error that isn't a reconnect retry today gets a standalone treatment. Under the unified model: does an error inside a closed bundle stay flat inside the bundle, or does it split the bundle at the error? My default: stay flat, because the bundle represents one assistant step and the error is part of that step.
6. **CLI rendering.** The CLI snapshot format mirrors the structure. Target aesthetic when a bundle expands — one blank-line separator per leaf, or tighter? Matches-rendering-in-app would be ideal; confirm that's the goal.
7. **Downstream surfaces.** `@bb/agent-provider-audit` replays and the Ladle stories depend on the current row shape. They'll update mechanically, but the audit snapshots are the biggest blast radius — any reason to stage that separately?
