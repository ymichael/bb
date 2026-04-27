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

- **bundle (phase = "live")** — small, same-kind, in-progress accumulator while a run is live. Tense per the labels rule below: `Running **3 commands**` when tail+enclosing-scope-active, `Ran **3 commands**` otherwise.
- **bundle (phase = "summary")** — flat, multi-kind. Created when a run closes (assistant-text lands or turn ends). Always past tense: `Ran **3 commands**, edited **2 files**`.
- **turn-summary** — `Worked for **X**` wrapper. Created when a turn transitions to any non-pending status. Body holds the turn's summary bundles and mid-turn assistant-text in source order. The turn's final assistant-text stays outside.

The two bundle phases share `kind: "bundle"` and most fields; they differ on a `phase` discriminator that the builder sets at construction time. The renderer reads `phase` directly — no implicit context required.

```ts
TimelineBundleRow {
  kind: "bundle";
  phase: "live" | "summary";
  rows: TimelineMessageRow[];        // flat leaves, no nested bundles
  // …id, sourceSeq, startedAt, createdAt, durationMs, turnId
  // (no status — see Phase A step 6)
}

TimelineTurnSummaryRow {
  kind: "turn-summary";
  rows: Array<TimelineBundleRow | TimelineMessageRow>;  // bundles + mid-turn text
  // …existing metadata
}
```

The "only assistant-text appears in `turn-summary.rows` as a `TimelineMessageRow`" invariant is enforced by the builder, not the type. Same-kind for `phase: "live"` and multi-kind for `phase: "summary"` are also builder-enforced invariants.

### Lifecycle

Three operations, applied mechanically:

- **Live bundling** — adjacent same-kind rows pack into a `bundle`. Mixed-kind rows stay standalone alongside. Visual fragmentation during alternating mixed-kind streams (e.g., command, edit, command, search → four separate rows) is an accepted trade-off; close-and-flatten resolves it once the run ends.
- **Close-and-flatten** — when an assistant-text lands or the turn ends, every live bundle and standalone in the just-finished run fuses into one flat `summary-bundle`. Skipped if the buffer is empty (e.g., back-to-back assistant-texts with no tool work between them) — no empty `summary-bundle` is emitted.
- **Done-turn wrap** — when the turn becomes non-pending, a `turn-summary` absorbs all the turn's summary-bundles and mid-turn assistant-texts. The final assistant-text stays at the top level. If the wrap would be empty (a turn that produced only the final assistant-text — no tool work, no mid-turn text), suppress the wrapper; the final assistant-text stands alone.
- **Thread-interrupted positioning** — when the user stops a thread, `thread-interrupted` is a thread-level peer rather than absorbed into a turn-summary. The terminating turn's `turn-summary` reads `Worked for X` (interrupted status), and the `Stopped by user` row appears after it as a top-level row.

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
- **Bundles** read present tense (`Running 3 commands`, `Exploring 5 files, 2 searches`) iff the bundle is the **tail of its timeline** AND **its enclosing scope is in-progress**. Otherwise past tense. Children's status is irrelevant.

Concrete consequence: in an active turn with multiple bundles, only the last one reads present tense. A timeline mid-stream might show `Ran **3 commands**` (non-tail bundle, past tense) above `Running **2 commands**` (tail bundle, present tense) — both during the same active turn.

Both predicates apply recursively, since timelines nest:

- **Tail of its timeline.** Each timeline level computes its own tail. The outer (thread) timeline has one; a delegation's inner timeline has its own; nested delegations recurse.
- **Enclosing scope is in-progress.** For the outer timeline, this is "the thread is active AND the turn is active". For a delegation's inner timeline, it's `delegation.status === "pending"`. The pattern: each timeline level's "active" predicate is the pending state of whatever leaf encloses it. So a completed delegation's inner tail bundle reads past tense even when the outer thread+turn are still active.

### Auto-expand

- **Leaves:** expanded iff the row's own status is pending or streaming.
- **Bundles:** expanded iff the bundle is the tail of its timeline AND its enclosing scope is in-progress (same predicate as the Labels rule above — recursive: outer is thread+turn active, delegation inner is the delegation pending).
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

**Cut from the timeline** (handled in Phase A step 1, never rendered): `assistant-reasoning`, `tasks` (data still parsed for the future peer surface — both Claude's `TodoWrite` and Codex's `turn/plan/updated` feed the unified `ViewTasksMessage` stream), `permission-grant-lifecycle`, the `plan-updated` operation opType (parseOperationMessage branch only — Codex's `turn/plan/updated` continues to flow into the task stream).

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

`<title>` resolved by `code` lookup (per Phase A step 3: `KNOWN_ERROR_COPY: Record<string, {title: string, hint?: string}>`). Falls back to raw `message` for unknown codes. `detail` and optional `hint` render in body. Red chrome retained — lone exception.

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

Single static state. Body shows optional reason if present. Positioned as a thread-level peer per the lifecycle section — not absorbed into the turn-summary.

#### Compaction (`opType=compaction`)

| State | Render |
|---|---|
| live | Compacting · 2s |
| done | Compacted · 2s |
| error | Compaction failed · 2s |
| interrupted | Compaction interrupted · 2s |

No emphasis slot.

#### Ownership change (`opType=operation`, `metadata.operation=ownership_change`)

Always `status: completed` (instantaneous, no live/error/interrupted states). Per Phase A step 2, the server is updated to enrich event metadata with `previousParentName` / `nextParentName` at emit time (`routes/threads/base.ts:137`); without that enrichment, the row would render raw thread IDs.

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

General improvements to how rows render. These sit on top of Phase A's structural changes — none can land before the new model is in place.

### Shared bundle/slow-tool header

All bundle headers — live multi-row, summary, turn-summary — share one visual: prefix + emphasis + duration (+ shimmer when ongoing). The same primitive backs the four slow-tool leaves (shell, delegation, web-search, web-fetch). One component, one truncation rule, one duration formatter. Working name: `SlowToolHeader`. File-edits, tool-exploring, operations, and errors keep their purpose-specific chrome.

Bundle bodies render tight — same density as today's exploration list (`mt-0.5 space-y-0.5`, no per-row outer padding). The container owns vertical rhythm; leaves don't.

#### `SlowToolHeader` prop contract (locked)

Per AGENTS.md "Reuse Discipline" — no optional args added later to support new callers. Lock the shape now:

```ts
interface SlowToolHeaderProps {
  prefix: ReactNode;     // leading verb(s), unbold (e.g., "Running", "Ran Subagent", "Researched")
  emphasis: ReactNode;   // bold portion (counts, names, queries — single or comma-joined)
  duration?: string;     // pre-formatted (e.g., "12.4s"); omitted when not applicable
  ongoing: boolean;      // drives shimmer on the prefix
}
```

Mapping per row:

- **Shell:** prefix=`"Running"|"Ran"`, emphasis=command, duration=set, ongoing=isLive.
- **Web search/fetch:** prefix=`"Searching"|"Searched"|"Fetching"|"Fetched"`, emphasis=query/url, duration=set, ongoing=isLive.
- **Delegation (single):** prefix=`"Running Subagent"|"Ran Subagent"`, emphasis=title, duration=set, ongoing=isLive.
- **Bundle (live, single-kind):** prefix=`"Running"|"Ran"|"Exploring"|"Explored"|"Researching"|"Researched"|"Editing"|"Edited"|"Changing"|"Changed"`, emphasis=count detail (e.g., `"3 commands"`, `"5 files, 3 searches"`), duration=set, ongoing=isLive.
- **Bundle (summary, multi-kind):** prefix=first contribution's verb (capitalized), emphasis=full comma-joined contribution string with mid-sentence verbs included as part of the emphasis text (e.g., `"3 commands, edited 2 files, ran 1 subagent"`), duration=set, ongoing=false.
- **Turn-summary:** prefix=`"Worked for"`, emphasis=duration value (e.g., `"12.4s"`), duration=omitted (the duration *is* the emphasis), ongoing=false.

If a future use case can't fit these four slots, that's a design signal, not a reason to add a prop.

### Delegation bundling

Adjacent delegations bundle like any other same-kind work. One delegation: inline. Multiple: `Ran N subagents`.

### Single-row rendering

From the user's perspective, bundle headers should look consistent regardless of live-vs-summary state, with two refinements for the one-row case:

- **Live bundle, one row** — the bundle is invisible. Header = the inner row's own header. No "Ran 1 command" wrapper.
- **Summary bundle, one row** — standard summary header (so it sits visually with multi-row summaries). Expanding shows the inner row directly, not a nested bundle.

The unwrap decision lives in one shared helper (`shouldUnwrapAsInnerRow(bundle, isLive)`) in `core-ui` so the web renderer and the CLI text formatter behave identically — neither owns its own copy of the rule. The builder always emits a `TimelineBundleRow`.

## Migration

Two phases. Phase A (fundamentals) lands first and end-to-end before Phase B (view-surface). Within each phase, order matters; each commit lands behind passing tests for the previous step.

**Phase A — fundamentals**

1. **Trim `ViewMessage` to timeline kinds.** Four concepts get cut from the timeline:
   - `assistant-reasoning` — already shown via the active-thinking banner. Data continues to flow for that surface.
   - `tasks` — will move to a future peer surface (out of scope for this plan). Data continues to flow for that surface from both providers: `parseTaskMessage` keeps parsing Claude's `TodoWrite` tool calls AND Codex's `turn/plan/updated` events into the same `ViewTasksMessage` shape, which becomes a sibling stream (no longer in `ViewMessage["kind"]`).
   - `permission-grant-lifecycle` — represents ongoing-permission grant lifecycles (distinct from per-call approval state, which lives on tool items). Not useful enough to surface as a row. Wire event continues to be recorded for replay/audit; it just stops becoming a `ViewMessage`.
   - The `plan-updated` operation row — provider-specific leak with no Claude/Pi analogue, redundant with the unified task stream. Delete the `parseOperationMessage` `turn/plan/updated` branch, the `"plan-updated"` member of `ViewOperationMessage["opType"]`, and the `OperationRow` branch. The Codex adapter, the wire schema, and `parseTaskMessage`'s `turn/plan/updated` branch stay alive — they remain the data path for Codex plan signal into the (sibling) task stream. Empty plans (zero steps) cause `parseTaskMessage` to return null, which now means the event is silently ignored rather than falling through to the operation row.

   Make the boundary structural:
   - Remove `assistant-reasoning`, `tasks`, and `permission-grant-lifecycle` from `ViewMessage["kind"]`. Move each to a sibling type only the relevant consumer reads, or drop it entirely if no consumer remains. (For `tasks`, the consumer is the future peer surface; the sibling stream stays live.)
   - Delete the `turn/plan/updated` branch in `parse-operation-message.ts`, the `"plan-updated"` member of `ViewOperationMessage["opType"]`, and the `plan-updated` branch in `OperationRow.tsx`.
   - Delete the `system/permissionGrant/lifecycle` parsing branch in `parse-operation-message.ts:331-348`, `PermissionGrantLifecycleRow`, and the `ConversationEntry` permission-grant-lifecycle case.
   - `to-view-messages` produces a timeline stream that excludes the cut kinds, plus separate streams for any that have a real consumer.
   - Delete `isTimelineHiddenMessage`, `toTimelineVisibleMessages`, `ReasoningRow.tsx`, `TasksRow.tsx`, the `ConversationEntry` cases for cut kinds, and the dead branches in `getMessageStatus`, `getToolBundleKind`, `thread-detail-activity.ts`, `format-timeline-text.ts`, and `timeline-assistant-step-summary.ts`.
   - After this commit, every exhaustive switch on `ViewMessage["kind"]` handles only kinds the timeline actually renders — no filter call required, no provider-specific opType.

   *Persistence note:* historical events stored in the DB (e.g., previously recorded `system/permissionGrant/lifecycle` payloads) remain on disk. Per `feedback_no_legacy_data.md`, no migration or backfill — accepted that legacy events that no longer have a parser branch are silently skipped on replay. State this assumption explicitly so future readers don't re-litigate it.

2. **Server-side event hygiene.** Two related cleanups in the server layer; lands as its own diff to keep view-layer changes (step 1) and event-emit changes (here) independently revertable.

   - Add `environmentId` to `PendingInteraction` (set when the interaction is created, since interaction → thread → environment is stable), and drop the `getThread` lookups inside `appendPermissionGrantTimelineEvent` and `appendApprovalItemEvent` in `pending-interaction-timeline.ts`. Emit helpers stop doing DB reads for routing scaffold; `environmentId` flows in from the caller, matching every other emit path in `thread-events.ts`. Removes the silent `thread?.environmentId ?? null` fallback that hides race-condition failures.
   - Enrich the `system/operation` ownership-change event with `previousParentName` and `nextParentName` at emit time. The route handler at `routes/threads/base.ts:137` already has `thread` and `updated` in scope; resolve the prior and next parent thread titles there and pass them in as new metadata fields on `appendThreadOwnershipChangeEvent`. Update the metadata schema in `thread-events.ts` and the parsing branch in `parse-operation-message.ts` to read them. Without this, the ownership-change row would render raw `thr_*` IDs instead of human names.

3. **Stop squishing error events.** Today `parseErrorMessage` flattens the wire format's `{code, message, detail}` into a single string (`"<message> - <detail>"`), drops `code` entirely, and `ErrorRow.parseErrorDisplay` then reverses the squish — splitting on ` - ` and running regex matches against specific server-emitted message strings (`"Project folder not found"`, `"Provisioning thread failed"`) to recover a nicer title. The wire format is structured; the view layer broke its own data.

   - Add `code?: string` and `detail?: string` to `ViewErrorMessage`. Preserve them as-is in `parseErrorMessage` instead of flattening.
   - Delete `formatErrorDetail` and the magic ` - ` delimiter contract between parser and display.
   - Replace `parseErrorDisplay`'s string-matching special cases (`isThreadProvisioningFailureTitle`, the `Project folder not found` regex block) with a `KNOWN_ERROR_COPY: Record<string, {title: string, hint?: string}>` table keyed on `code`. Codes already exist on the wire (`provider_reconnect`, etc.); we just stop ignoring them. Servers emitting new error classes get nicer copy by adding a code, not by hoping a regex matches their message.
   - Fall back to raw `message` for unknown codes; `detail` renders directly in the body.

4. **Unified bundle type.** Add `TimelineBundleRow` with the `phase: "live" | "summary"` discriminator (see Model). Define it *without* a `status` field from the outset — the new rules don't read bundle status, so introducing then removing it would just churn type history. Teach builders to set `phase` correctly: `live` while accumulating, `summary` after close-and-flatten. Delete `TimelineToolBundleRow`, `TimelineAssistantStepSummaryRow`, `bundleKind`, `assistant-step-summary-placeholder`, `materializeAssistantStepSummaryRows`.
5. **Single rendering path.** Rename `ToolBundleEntry` to `BundleEntry` and absorb the assistant-step-summary entry's logic — one component handles both `phase: "live"` and `phase: "summary"`. Delete `ExplorationDetailList` and the bundle-kind branch in the body.
6. **Rule simplification.** Replace the scattered ongoing-label and auto-expand helpers with the four-rule set above. Delete `containsLatestActivity`, `buildTimelineRowActivityInfoMap`, `groupedRowsUseOngoingLabels`, `shouldPreferOngoingLabelsForMessage`, `expandErrors`, and `DelegationRow`'s expansion override. The auto-expand builder becomes one short function over `({ row, isTail, enclosingScopeInProgress })`.

   With the new rules, the `status` field on `TimelineTurnSummaryRow` is no longer read (label tense and auto-expand are driven by tail+enclosing-scope-in-progress; chrome doesn't differentiate). Drop it: remove `status` from `TimelineTurnSummaryRow` (domain schema + type), stop computing it in the builder, delete `mergeGroupedRowStatus` and `getRowStatus`, and update the bundle/turn-summary label builders (`timeline-tool-bundle-summary.ts`, `timeline-turn-summary.ts`, and the CLI's `formatTurnSummary` in `format-timeline-text.ts`) to take a single object argument `({ rows, isOngoing })` / `({ row, isOngoing })` derived from tail+enclosing-scope-in-progress at the call site. Single-object signatures match AGENTS.md "Reuse Discipline" — adding a future field doesn't break callers. Update tests that asserted on the field.

   *Verification before merging:* project-wide grep for `\.status` reads against `TimelineTurnSummaryRow`, including query keys, React Query memos, telemetry, and tests. The earlier audit covered renderers only; AGENTS.md "search project-wide for the old name" rule applies here.

**Phase B — view-surface**

Phase B sits on top of Phase A — none of these can land until the model is in place. Within Phase B, steps 7/8/9 are mutually independent and can land in any order; step 10 (CLI) is genuinely last because it consumes everything.

7. **Shared header primitive.** Extract `SlowToolHeader` with the locked prop contract (see View-surface section); migrate the four slow-tool leaves (shell, delegation, web-search, web-fetch) and the bundle/turn-summary headers onto it.
8. **Bundle delegations and file edits.** Add `delegation` and `file-edit` to `canAppendToToolBundle`'s same-kind set. Multi-change file-edit messages stop rendering the comma-joined basename list in the title (`<a.ts, b.ts, c.ts +2 more>`) — both the bundle aggregator and a single multi-change row use the same count-based emphasis (`Editing **N files**`, `Changing **N files**` for mixed actions). Single-change messages keep the basename title (`Editing **bar.ts**`). Delete `summarizeChangedFileNames` and the expanded-vs-collapsed label switching in `FileEditRow`.
9. **Single-row rendering.** Add `shouldUnwrapAsInnerRow(bundle)` to `core-ui` (reads `bundle.phase`) as the single source of the unwrap rule. In `BundleEntry`: call the helper. Live single-row bundle → renders the inner row's header in place (no wrapper). Summary single-row bundle → wraps with the standard summary header and expands directly to the inner row.
10. **CLI parity.** Mirror the app's structure in `format-timeline-text.ts`. The data layer is already shared (type changes from steps 1–6 propagate automatically); this step updates the text formatters to match the locked copy spec, calling the same `shouldUnwrapAsInnerRow` helper from step 9 so the unwrap rule has one definition. CLI has no clickable expand affordance, so collapse/expand becomes a verbose flag — collapsed by default renders the bundle/turn-summary headers; `--verbose` shows the full body inline. The recursive "enclosing scope in-progress" predicate adapts naturally: in static `bb thread show` snapshots no scope is in-progress, so all bundles render past tense; live-streaming commands evaluate the predicate normally.

## Tests

Behavior is tested directly. **Snapshot tests are not a substitute for assertions on row-copy spec behavior** — every row in the spec needs at least one rule-layer or builder-layer assertion. Snapshots only guard against unintended visual drift; if a row's copy is in the spec, a copy assertion must exist independently.

### Builder structural

Given an event stream, assert the exact row tree shape. The Lifecycle walkthrough is the contract.

- Streaming with no assistant-text yet → mixed standalones and live `phase: "live"` bundles, no summary-bundle, no turn-summary.
- Mid-turn assistant-text lands → all preceding live bundles + standalones fuse into a single `phase: "summary"` bundle; assistant-text follows at top level.
- Two adjacent assistant-texts with no tool work between them → close-and-flatten skipped; no empty summary-bundle emitted.
- Turn ends → done-turn-wrap absorbs all summary-bundles + mid-turn assistant-texts into a `turn-summary`; final assistant-text stays at top level.
- Turn with only a final assistant-text → empty wrapper suppressed; assistant-text renders at top level alone.
- Standalone row sandwiched between two bundles when assistant-text lands → all three fuse into one flat summary-bundle (asserts the exact transition from the walkthrough).
- Thread-interrupted event mid-turn → terminating turn becomes turn-summary; `Stopped by user` row appears as a thread-level peer after it.

### Rule layer (labels + auto-expand)

Each case asserted on label outputs and auto-expand maps:

- Live tail bundle with active thread+turn → present tense, expanded.
- Same bundle after the turn closes → past tense, collapsed.
- Mid-turn non-tail bundle in active turn → past tense (verifying tail-only-tail-tense rule).
- Pending leaf inside a non-tail bundle → leaf expanded, bundle not (no bubble-up).
- Tail error in a failed turn → expanded.
- Mid-turn error followed by recovery → collapsed.
- Done turn → `Worked for X` collapsed by default.
- Delegation in flight → delegation row expanded; its inner tail bundle reads present tense (recursive predicate).
- Completed delegation inside an active thread → delegation's inner tail bundle reads past tense (recursive predicate's negative case).

### Render layer

Verify which row IDs are expanded and which prefixes read present tense for each row kind in the spec, in both live and post-close states.

### Error copy (`KNOWN_ERROR_COPY` lookup)

- Each known code resolves to its specced title (and hint, if present).
- Unknown code falls back to raw `message`.
- Error with `detail` shows it in the body, not in the title.

### CLI (step 10)

- Default (collapsed) output renders bundle/turn-summary headers with the locked copy spec; full bodies hidden.
- `--verbose` flag shows full bodies inline.
- Static `bb thread show` snapshot — no scope is in-progress, so all bundles render past tense.
- Live-streaming command — tail bundle of the active scope reads present tense.
- `shouldUnwrapAsInnerRow` produces the same result as the web renderer for the same input (single-source rule).

## Exit criteria

- A turn with mixed kinds expands to a flat list under one header.
- A live, currently-running tool call as the tail of an active timeline renders inline (the tool row's own header), no bundle wrapper visible.
- After a turn closes with one tool call, the single-row summary-bundle shows the standard summary-bundle header (`Ran ... · 5s`), and expanding it reveals the inner tool row directly — no nested bundle.
- `12.4s` renders identically across the four slow-tool leaves and the bundle/turn-summary headers.
- Active thread with a completed Explore bundle as the tail reads `Exploring …`, not `Explored …`.
- Mid-turn errors don't auto-expand; tail errors do.
- Done turn collapses to `Worked for X`; expansion shows summary-bundles + mid-turn text.
- The auto-expand builder is one function with four cases.
- **Project-wide grep returns zero callers of:** `containsLatestActivity`, `buildTimelineRowActivityInfoMap`, `groupedRowsUseOngoingLabels`, `shouldPreferOngoingLabelsForMessage`, `expandErrors`, `mergeGroupedRowStatus`, `getRowStatus`, `summarizeChangedFileNames`, `formatErrorDetail`, `isTimelineHiddenMessage`, `toTimelineVisibleMessages`, `materializeAssistantStepSummaryRows`, and `parseErrorDisplay`'s string-matching special cases.

## Open questions

None. All decisions captured above.
