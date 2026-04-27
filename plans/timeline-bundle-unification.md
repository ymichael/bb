# Timeline Rendering Unification

## Principles

1. **Readability first.** The user can follow what is happening without clicking.
2. **Three modes:** live (turn in flight), idle (between turns), done (collapsed under "Worked for X").
3. **No bundles for bundling's sake.** A wrapper around one same-kind row adds nothing.
4. **Flat rules.** One rule per behavior. Each row decides for itself; no ancestor walking, no bubble-up.
5. **Reuse over special-case.** One canonical rendering path per concept. Per-kind code is limited to verb, truncation rule, and inner detail. Special-casing is allowed only when called out in the plan.
6. **Verbs, not status enums.** User-facing strings describe action (`Running`, `Ran`, `Searching`, `Edited`). Status enum values (`"Completed"`, `"Failed"`, `"Interrupted"`) never reach the UI as copy.

## Model

### Three row shapes

- **bundle** — small, same-kind, in-progress accumulator while a run is live. Tense per the labels rule below: `Running **3 commands**` when tail+active, `Ran **3 commands**` otherwise.
- **summary-bundle** — flat, multi-kind. Created when a run closes (assistant-text lands or turn ends). Always past tense: `Ran **3 commands**, edited **2 files**`.
- **turn-summary** — `Worked for **X**` wrapper. Created when a turn transitions to any non-pending status. Body holds the turn's summary-bundles and mid-turn assistant-text in source order. The turn's final assistant-text stays outside.

`bundle` and `summary-bundle` share one type — distinguished by what they contain, not by row kind:

```ts
TimelineBundleRow {
  kind: "bundle";
  rows: TimelineMessageRow[];        // flat leaves, no nested bundles
  status: TimelineGroupedRowStatus;
  // …id, sourceSeq, startedAt, createdAt, durationMs, turnId
}

TimelineTurnSummaryRow {
  kind: "turn-summary";
  rows: Array<TimelineBundleRow | TimelineMessageRow>;  // bundles + mid-turn text
  // …existing metadata
}
```

The "only assistant-text appears in `turn-summary.rows` as a `TimelineMessageRow`" invariant is enforced by the builder, not the type.

### Lifecycle

Three operations, applied mechanically:

- **Live bundling** — adjacent same-kind rows pack into a `bundle`. Mixed-kind rows stay standalone alongside.
- **Close-and-flatten** — when an assistant-text lands or the turn ends, every live bundle and standalone in the just-finished run fuses into one flat `summary-bundle`.
- **Done-turn wrap** — when the turn becomes non-pending, a `turn-summary` absorbs all the turn's summary-bundles and mid-turn assistant-texts. The final assistant-text stays at the top level.

Walkthrough:

```
Streaming, no assistant-text yet:
  bundle-1: row1, row2
  row3 (standalone)
  bundle-2: row4, row5

Mid-turn assistant-text lands:
  summary-bundle: row1..row5
  assistant message
  bundle-3, row8, bundle-4 (live, accumulating)

Second mid-turn text lands:
  summary-bundle: row1..row5
  assistant message
  summary-bundle: row6..row10
  assistant message
  bundle-5, row13, bundle-6 (live)

Turn done:
  worked-for:
    summary-bundle: row1..row5
    assistant message
    summary-bundle: row6..row10
    assistant message
    summary-bundle: row11..row15
  assistant message  (final, outside)
```

## Rules

### Labels

- **Leaves** read their own event. While the event says it's running → present tense (`Running …`, `Editing …`). Once it says it's done → past tense (`Ran …`, `Edited …`). No context, no inference.
- **Bundles** read present tense (`Running 3 commands`, `Exploring 5 files, 2 searches`) iff the bundle is the **tail of its timeline** AND the parent thread and turn are both active. Otherwise past tense. Children's status is irrelevant.

"Tail of its timeline" applies recursively: a delegation's inner timeline computes its own tail.

### Auto-expand

- **Leaves:** expanded iff the row's own status is pending or streaming.
- **Bundles:** expanded iff the bundle is the tail of its timeline AND the parent thread and turn are both active.
- **Errors:** expanded iff the error is the tail of its timeline.
- **User toggles override** auto-expand. Manual collapse/expand sticks.

Each row decides for itself. No ancestor walking. No "expand a bundle because a child wants expansion." No `expandErrors` flag, no `DelegationRow` override.

A mid-turn error that the agent recovered from stays collapsed by default — the user can still click in.

## Row copy

Per-row copy spec, derived from the principles and rules above. **Bold** marks the `EventTitle` emphasis slot. Tense for leaves comes from the row's own status; tense for bundles comes from "tail of timeline AND thread+turn active".

**Conventions**

- First verb capitalized; mid-sentence verbs lowercase (e.g., `Ran 3 commands, edited 2 files`).
- Singular/plural by count (`1 query` / `3 queries`).
- Long emphasis content truncated with end-ellipsis at a character cap.
- No red chrome or strikethrough on tool rows for error/interrupted states. The standalone `ErrorRow` is the lone exception (its purpose is to surface a problem).
- Status enum values (`"Completed"`, `"Failed"`, `"Interrupted"`) never appear as bare copy. Verb phrases that contain them (`Failed to edit`, `Provisioning interrupted`) are fine — they're describing the action.

**Cut from the timeline** (handled in Phase A step 1, never rendered): `assistant-reasoning`, `tasks`, `permission-grant-lifecycle`, Codex `turn/plan/updated` (full removal incl. adapter), `plan-updated` operation opType.

### Slow-tool leaves

#### Shell command (`tool-call`)

| State | Render |
|---|---|
| live | Running **git diff** · 5s |
| done / error / interrupted | Ran **git diff** · 5s |
| awaiting approval | Awaiting approval to run **rm -rf node_modules** |
| denied | Denied **rm -rf node_modules** |

#### Web search (`web-search`)

| State | Render |
|---|---|
| live | Searching **"q1", "q2", "q3"** · 2s |
| done / interrupted | Searched **"q1", "q2", "q3"** · 2s |
| no query (fallback) | Searched **the web** |

All queries comma-separated; end-ellipsis when long.

#### Web fetch (`web-fetch`)

| State | Render |
|---|---|
| live | Fetching **example.com/docs** · 1s |
| done / interrupted | Fetched **example.com/docs** · 1s |

End-ellipsis on long URLs.

#### Delegation single (`delegation`, inline — not bundled)

| State | Render |
|---|---|
| live | Running Subagent **<title>** · 5s |
| done / error / interrupted | Ran Subagent **<title>** · 1m20s |

`<title>` from `formatDelegationSummary`: `<subagentType>: <description>` / `<subagentType>` / `<description>` / `<command>` fallback. End-ellipsis when long.

### File-edit (`file-edit`)

#### Single-change message (1 file)

| State | Render |
|---|---|
| live, edit | Editing **bar.ts** · +5 -2 |
| done, edit | Edited **bar.ts** · +5 -2 |
| live/done, create | Creating/Created **bar.ts** · +30 |
| live/done, delete | Deleting/Deleted **bar.ts** · -42 |
| live/done, pure rename | Renaming/Renamed **bar.ts → baz.ts** |
| live/done, rename + diff | Editing/Edited **baz.ts** · +5 -2 *(destination only)* |
| error / interrupted | Failed to edit/create/delete/rename **bar.ts** |
| awaiting approval | Awaiting approval to edit/create/delete/rename **bar.ts** |
| denied | Denied edit/create/delete/rename **bar.ts** |

Path: basename only (full path on hover). Diff stats (`+N -M`) in suffix.

#### Multi-change message OR bundled file edits (≥2 files)

| State | Render |
|---|---|
| live, all same action | Editing **N files** · +12 -8 |
| done, all same action | Edited **N files** · +12 -8 |
| live, mixed actions | Changing **N files** · +12 -50 |
| done, mixed actions | Changed **N files** · +12 -50 |
| error / interrupted | Failed to edit **N files** |

The previous basename list (`a.ts, b.ts, c.ts +2 more`) is removed from the title; full file list appears on expand.

### Tool-exploring (`tool-exploring`)

A single message already aggregates Read/Search/List intents with internal counts.

| State | Render |
|---|---|
| live, files+searches | Exploring **3 files, 2 searches**… |
| live, only searches | Exploring **2 searches**… |
| live, no parsed intents | Exploring… |
| done | Explored **3 files, 2 searches** |
| done, no counts | Explored **workspace** |
| error / interrupted | Same as done |

No duration. The `…` suffix marks ongoing.

### Standalone error (`error`)

| State | Render |
|---|---|
| done, no detail | Error: **<title>** *(red)* |
| done, expandable | Error: **<title>** *(red, expand affordance)* |

`<title>` resolved by `code` lookup (per Phase A step 2: `KNOWN_ERROR_COPY: Record<string, {title: string, hint?: string}>`). Falls back to raw `message` for unknown codes. `detail` and optional `hint` render in body. Red chrome retained — lone exception.

### Operation rows (`operation`)

#### Thread provisioning (`opType=thread-provisioning`)

| State | Render |
|---|---|
| live | Provisioning · 12s |
| done | Provisioned · 12s |
| error | Provisioning failed · 12s |
| interrupted | Provisioning interrupted · 12s |

No emphasis slot.

#### Thread interrupted (`opType=thread-interrupted`)

| State | Render |
|---|---|
| done | Stopped by user |

Single static state. Body shows optional reason if present.

#### Compaction (`opType=compaction`)

| State | Render |
|---|---|
| live | Compacting · 2s |
| done | Compacted · 2s |
| error | Compaction failed · 2s |
| interrupted | Compaction interrupted · 2s |

No emphasis slot.

#### Ownership change (`opType=operation`, `metadata.operation=ownership_change`)

Always `status: completed` (instantaneous, no live/error/interrupted states). Server enriches event metadata with `previousParentName` / `nextParentName` at emit time (`routes/threads/base.ts:137`).

| Action | Render |
|---|---|
| assign (prev=null, next=X) | Thread assigned to **<newManager>** |
| release (prev=X, next=null) | Thread unassigned from **<priorManager>** |
| transfer (prev=X, next=Y) | Thread re-assigned from **<priorManager>** to **<newManager>** |

#### Warning, deprecation, provider-unhandled

Render `message.title` directly. No verb structure. Body shows optional detail.

### Bundles

Format: `<verb> <emphasis> · <duration>`. Verb tense from the rule above.

#### Live bundle (single-kind)

| Bundle contents | Tail + active | Otherwise |
|---|---|---|
| 3 shells | Running **3 commands** · 5s | Ran **3 commands** · 5s |
| 3 tool-exploring (counts aggregated across messages) | Exploring **5 files, 3 searches** · 5s | Explored **5 files, 3 searches** · 5s |
| 3 web ops (all searches) | Researching **3 queries** · 5s | Researched **3 queries** · 5s |
| 3 web ops (all fetches) | Researching **3 pages** · 5s | Researched **3 pages** · 5s |
| 3 web ops (mixed) | Researching **2 queries, 1 page** · 5s | Researched **2 queries, 1 page** · 5s |
| 5 file edits (all same action) | Editing **5 files** · +12 -8 | Edited **5 files** · +12 -8 |
| 5 file edits (mixed actions) | Changing **5 files** · +12 -50 | Changed **5 files** · +12 -50 |
| 4 delegations | Running **4 subagents** · 1m | Ran **4 subagents** · 1m |

Live bundle, single-row case: bundle is invisible — the inner row's header renders in place.

#### Summary bundle (multi-kind, post-close, always past tense)

Comma-joined kind contributions in emphasis. First verb capitalized; subsequent verbs lowercase mid-sentence. End-ellipsis when long.

| Kind | Contribution |
|---|---|
| shell | `Ran N commands` |
| tool-exploring | `Explored X files, Y searches, Z lists` |
| web | `Researched X queries, Y pages` |
| file-edit (same action) | `Edited N files` |
| file-edit (mixed actions) | `Changed N files` |
| delegation | `Ran N subagents` |

Examples:

- `Ran **3 commands** · 12s`
- `Ran **3 commands**, researched **1 query** · 12s`
- `Ran **2 commands**, edited **3 files** · 8s`
- `Explored **8 files, 4 searches**, researched **1 page** · 5s`
- `Ran **2 commands**, edited **3 files**, ran **1 subagent** · 1m20s`

Summary bundle, single-row case: summary header (matches multi-row visual); expand reveals the inner row directly, no nested bundle.

### Turn-summary

| Status | Render |
|---|---|
| completed / error / interrupted | Worked for **12.4s** |

Turn-summary only forms when a turn ends, so duration is always available — no count-based fallback needed. Outcome (error vs clean completion vs user stop) surfaces via inner rows when expanded; the wrapper stays neutral.

## View-surface improvements

These are general improvements to how rows render. Independent of the fundamentals above; they could land in any order once the model is in place.

### Shared bundle/slow-tool header

All bundle headers — live multi-row, summary, turn-summary — share one visual: prefix + emphasis + duration (+ shimmer when ongoing). The same primitive backs the four slow-tool leaves (shell, delegation, web-search, web-fetch). One component, one truncation rule, one duration formatter. Working name: `SlowToolHeader`. File-edits, tool-exploring, operations, and errors keep their purpose-specific chrome.

Bundle bodies render tight — same density as today's exploration list (`mt-0.5 space-y-0.5`, no per-row outer padding). The container owns vertical rhythm; leaves don't.

### Delegation bundling

Adjacent delegations bundle like any other same-kind work. One delegation: inline. Multiple: `Ran N subagents`.

### Single-row rendering

From the user's perspective, bundle headers should look consistent regardless of live-vs-summary state, with two refinements for the one-row case:

- **Live bundle, one row** — the bundle is invisible. Header = the inner row's own header. No "Ran 1 command" wrapper.
- **Summary bundle, one row** — standard summary header (so it sits visually with multi-row summaries). Expanding shows the inner row directly, not a nested bundle.

This is a render-layer decision: the builder always emits a `TimelineBundleRow`; the renderer decides whether to unwrap.

## Migration

Two phases. Phase A (fundamentals) lands first and end-to-end before Phase B (view-surface). Within each phase, order matters; each commit lands behind passing tests for the previous step.

**Phase A — fundamentals**

1. **Trim `ViewMessage` to timeline kinds.** Four concepts get cut from the timeline:
   - `assistant-reasoning` — already shown via the active-thinking banner. Data continues to flow for that surface.
   - `tasks` — will move to a future peer surface (out of scope for this plan). Data continues to flow for that surface, fed by Claude's `TodoWrite` tool calls.
   - `permission-grant-lifecycle` — represents ongoing-permission grant lifecycles (distinct from per-call approval state, which lives on tool items). Not useful enough to surface as a row. Wire event continues to be recorded for replay/audit; it just stops becoming a `ViewMessage`.
   - Codex `turn/plan/updated` (and the `plan-updated` operation row it eventually fed) — provider-specific leak with no Claude/Pi analogue. Cut at the source: the Codex adapter stops translating this event entirely, so empty and non-empty plans alike are silently ignored. Codex sessions lose the plan signal — accepted trade-off; the future tasks peer surface is fed by Claude's `TodoWrite` only.

   Make the boundary structural:
   - Remove `assistant-reasoning`, `tasks`, and `permission-grant-lifecycle` from `ViewMessage["kind"]`. Move each to a sibling type only the relevant consumer reads, or drop it entirely if no consumer remains.
   - Delete the `turn/plan/updated` ThreadEvent type from `provider-event.ts`, the translation in `codex/event-translation.ts:683-686`, the `turn/plan/updated` branches in `task-message-parsing.ts` and `parse-operation-message.ts`, the `"plan-updated"` member of `ViewOperationMessage["opType"]`, and the `plan-updated` branch in `OperationRow.tsx`.
   - Delete the `system/permissionGrant/lifecycle` parsing branch in `parse-operation-message.ts:331-348`, `PermissionGrantLifecycleRow`, and the `ConversationEntry` permission-grant-lifecycle case.
   - `to-view-messages` produces a timeline stream that excludes the cut kinds, plus separate streams for any that have a real consumer.
   - Delete `isTimelineHiddenMessage`, `toTimelineVisibleMessages`, `ReasoningRow.tsx`, `TasksRow.tsx`, the `ConversationEntry` cases for cut kinds, and the dead branches in `getMessageStatus`, `getToolBundleKind`, `thread-detail-activity.ts`, `format-timeline-text.ts`, and `timeline-assistant-step-summary.ts`.
   - After this commit, every exhaustive switch on `ViewMessage["kind"]` handles only kinds the timeline actually renders — no filter call required, no provider-specific opType, no Codex-only ThreadEvent.

   Adjacent server-side hygiene that lands in the same Phase A step 1 diff: add `environmentId` to `PendingInteraction` (set when the interaction is created, since interaction → thread → environment is stable), and drop the `getThread` lookups inside `appendPermissionGrantTimelineEvent` and `appendApprovalItemEvent` in `pending-interaction-timeline.ts`. Emit helpers stop doing DB reads for routing scaffold; `environmentId` flows in from the caller, matching every other emit path in `thread-events.ts`. Removes the silent `thread?.environmentId ?? null` fallback that hides race-condition failures.
2. **Stop squishing error events.** Today `parseErrorMessage` flattens the wire format's `{code, message, detail}` into a single string (`"<message> - <detail>"`), drops `code` entirely, and `ErrorRow.parseErrorDisplay` then reverses the squish — splitting on ` - ` and running regex matches against specific server-emitted message strings (`"Project folder not found"`, `"Provisioning thread failed"`) to recover a nicer title. The wire format is structured; the view layer broke its own data.

   - Add `code?: string` and `detail?: string` to `ViewErrorMessage`. Preserve them as-is in `parseErrorMessage` instead of flattening.
   - Delete `formatErrorDetail` and the magic ` - ` delimiter contract between parser and display.
   - Replace `parseErrorDisplay`'s string-matching special cases (`isThreadProvisioningFailureTitle`, the `Project folder not found` regex block) with a `KNOWN_ERROR_COPY: Record<string, {title: string, hint?: string}>` table keyed on `code`. Codes already exist on the wire (`provider_reconnect`, etc.); we just stop ignoring them. Servers emitting new error classes get nicer copy by adding a code, not by hoping a regex matches their message.
   - Fall back to raw `message` for unknown codes; `detail` renders directly in the body.

3. **Unified bundle type.** Add `TimelineBundleRow`; teach builders to emit it for both live and summary cases; delete `TimelineToolBundleRow`, `TimelineAssistantStepSummaryRow`, `bundleKind`, `assistant-step-summary-placeholder`, `materializeAssistantStepSummaryRows`.
4. **Single rendering path.** Replace bundle/step-summary entries with one `BundleEntry`. Delete `ExplorationDetailList` and the bundle-kind branch in the body.
5. **Rule simplification.** Replace the scattered ongoing-label and auto-expand helpers with the four-rule set above. Delete `containsLatestActivity`, `buildTimelineRowActivityInfoMap`, `groupedRowsUseOngoingLabels`, `shouldPreferOngoingLabelsForMessage`, `expandLatestActivity`, `expandErrors`, and `DelegationRow`'s expansion override. The auto-expand builder becomes one short function over (row, isTail, threadActive, turnActive).

   With the new rules, the `status` field on bundle and turn-summary rows is no longer read by any renderer (label tense, auto-expand, and chrome are all driven by tail+active or the row's own state). Drop it: remove `status` from `TimelineBundleRow` and `TimelineTurnSummaryRow` (domain schema + types), stop computing it in the builders, delete `mergeGroupedRowStatus` and `getRowStatus` along with their callers, and update the bundle/turn-summary label builders (`timeline-tool-bundle-summary.ts`, `timeline-turn-summary.ts`, and the CLI's `formatTurnSummary` in `format-timeline-text.ts`) to take an `isOngoing: boolean` derived from tail+active at the call site instead of reading status. Update tests that asserted on the field. No external API consumer reads bundle status, so the wire-contract change is internal.

**Phase B — view-surface**

6. **Shared header primitive.** Extract `SlowToolHeader` and the duration/truncation helpers; migrate the four slow-tool leaves and the bundle/turn-summary headers onto it.
7. **Bundle delegations and file edits.** Add `delegation` and `file-edit` to `canAppendToToolBundle`'s same-kind set. Multi-change file-edit messages stop rendering the comma-joined basename list in the title (`<a.ts, b.ts, c.ts +2 more>`) — both the bundle aggregator and a single multi-change row use the same count-based emphasis (`Editing **N files**`, `Changing **N files**` for mixed actions). Single-change messages keep the basename title (`Editing **bar.ts**`). Delete `summarizeChangedFileNames` and the expanded-vs-collapsed label switching in `FileEditRow`.
8. **Single-row rendering.** In `BundleEntry`: live single-row bundle renders the inner row's header in place (no wrapper); summary single-row bundle wraps with the standard summary header and expands directly to the inner row.
9. **CLI parity.** Mirror the app's structure in `format-timeline-text.ts`. The data layer is already shared (the type changes from steps 1–5 propagate automatically); this step is about updating the text formatters to match the locked copy spec. CLI has no clickable expand affordance, so collapse/expand is replaced by an existing/new verbose flag — collapsed by default renders the bundle/turn-summary headers; verbose shows the full body inline. Tail+active logic adapts naturally: in static `bb thread show` snapshots no row is "active", so all bundles render past tense; in live-streaming commands the tail bundle reads present tense.

## Tests

Active-state behavior is tested directly. Snapshots catch visual drift but aren't the contract.

Targeted cases — each asserted at the rule layer (label and auto-expand outputs) and the render layer (which row IDs are expanded, which prefixes read present tense):

- Live tail bundle with active thread+turn → present-tense label, expanded.
- Same bundle after the turn closes → past-tense label, collapsed.
- Pending leaf inside a non-tail bundle → leaf is expanded, bundle is not (no bubble-up).
- Tail error after a failed turn → expanded.
- Mid-turn error followed by recovery → collapsed.
- Done turn → `Worked for X` collapsed by default; expansion shows summary-bundles + mid-turn text.
- Delegation in flight → delegation row expanded; inside its timeline, the tail bundle reads present tense.

## Exit criteria

- A turn with mixed kinds expands to a flat list under one header.
- A live, currently-running tool call as the tail of an active timeline renders inline (the tool row's own header), no bundle wrapper visible.
- After a turn closes with one tool call, the single-row summary-bundle shows the standard summary-bundle header (`Ran ... · 5s`), and expanding it reveals the inner tool row directly — no nested bundle.
- `12.4s` renders identically across the four slow-tool leaves and the bundle/turn-summary headers.
- Active thread with a completed Explore bundle as the tail reads `Exploring …`, not `Explored …`.
- Mid-turn errors don't auto-expand; tail errors do.
- Done turn collapses to `Worked for X`; expansion shows summary-bundles + mid-turn text.
- The auto-expand builder is one function with four cases.

## Open questions

None. All decisions captured above.
