# Timeline Visual State Consistency

## Status

The first batch of high-confidence shippability fixes shipped to main. This plan now drives the remaining work: a small set of product-intent decisions, the durable visual-state policy contract, and the broader grouping/system-operation product behavior.

The companion design spec is `plans/timeline-layout-ascii-spec.md`. That file holds the concrete copy/layout/lifecycle reference; this file holds the engineering plan. Code work should match the spec; misalignments update the spec or the code, not both at once.

## Problem

Timeline visual behavior does not have one durable policy for "something is happening". Ongoing affordances are currently split between row statuses, title builders, renderer options, app-level indicators, row-local detail fallbacks, and pending-interaction banners.

The visible symptom that triggered this plan was narrow: pending system titles requested shimmer, but `buildSystemTitle` had no prefix, and `TimelineTitleView` only applied shimmer to the prefix segment. The broader issue is architectural: visual state is inferred ad hoc from row type, title segment layout, renderer scope, and tail position. That makes behavior inconsistent across system operations, work rows, summaries, steers, pending interactions, and global "Working..." UI.

The durable fix is to define a shared timeline visual-state taxonomy and make one policy produce labels, shimmer, expansion intent, and loading/error treatment for every row concept.

## Relevant Existing And Historical Plans

Current files:

- `plans/thread-view-package-boundary.md`
  - Locks the pipeline `ThreadEventWithMeta[] -> ThreadTimelineProjection -> ThreadTimeline -> server/CLI/audit/React`.
  - `@bb/thread-view` owns projection, grouping, labels, and text.
  - `@bb/ui-core` owns the React renderer.
  - Active turns are not wrapped in lazy turn rows.
  - Group rows are active-run only, with active-tail grouping labels only for grouped tail activity in active scope.
  - User steers are conversation rows, not a side channel.
- `plans/ui-core-design-system.md`
  - Defines ui-core as the owner of canonical domain compositions and shared primitives.
  - Repeated styling and one-off class bundles should be moved into shared primitives.
  - Domain-specific rendering should be canonical, not view-local.
- `plans/tab-split-layout.md`
  - Includes timeline file-change rows in the canonical file-link surface map.
  - Reinforces that timeline affordances should use shared primitives such as `FilePathLink`.

Historical or deleted plans inspected from git history:

- `dfb63aa5:plans/react-timeline-renderer.md`
  - Desired a single React renderer over the semantic timeline model.
  - Centralized `TimelineTitle` and `useTimelineExpansionState`.
  - Leaves derive active wording from their own status.
  - Bundles derive active wording from tail position plus active enclosing scope.
  - Active tail summaries and pending leaves auto-expand; manual override wins.
  - System rows preserve specialized compaction, ownership, prompt, and permission behavior.
- `76b266ca^:plans/timeline-bundle-unification.md`
  - Core principles: readability, live/idle/done clarity, no bundles for bundling's sake, flat rules, one rule per behavior, verbs over status enums.
  - Bundles can be live, summary, or turn-summary.
  - Bundle present-tense labels apply only when the bundle is tail and its enclosing scope is in progress.
  - Auto-expansion is status and scope driven: pending or streaming leaves, tail bundles in active scope, and tail errors.
- `09f8489a^:plans/thread-timeline-grouping-and-auto-expansion.md`
  - Desired status-driven auto-expansion.
  - Multiple concurrent pending commands should be expanded.
  - Active turns should render assistant-delimited groups, with active trailing work shown raw.
  - App and CLI should share the same nested model.
- `09f8489a^:plans/thread-timeline-c-summary-rules.md`
  - Distinguishes tool bundles, assistant-step summaries, and turn summaries.
  - Commands are tool bundles; web is separate from exploration.
  - Operations should not add noise to activity summaries.
  - Errors should affect state and expansion, but not be crammed into summary labels.
- `008cda30^:plans/thread-timeline-losslessness.md`
  - Projection should fail closed and make silent omission impossible.
  - Timeline policy changes should preserve losslessness.
- `e8b52a36^:plans/timeline-auto-scroll-rewrite.md`
  - `Working...`, streaming growth, and late banners must keep bottom pinned.
  - There should be one authoritative scroll signal.
- `5602b429^:plans/timeline-projection-stability.md`
  - Prefix-stability and stable logical keys are invariants.
  - System operations, provisioning, compaction, and permission grants should be key based, not adjacency based.
- `b4fa3c6a^:plans/timeline-projection-overhaul.md`
  - `ViewTurn.status` is authoritative and should not be inferred from children.
  - Completed turns collapse even if a child row appears pending; pending turns stay active even if children are terminal.
- `99c9fd6e:plans/timeline-display-model-rewrite.md`
  - Defines the fact-to-presentation pipeline: `StoredEventRow[] -> ThreadEventWithMeta[] -> TimelineProjection -> TimelineRow[] -> TimelinePresentationRow[] -> React/CLI/audit`.
  - Presentation rows should be built once and shared.
  - One work-source row should represent one user-visible unit of work.
  - `Changed N files` should be a group label only.
- `edeff26f^:plans/timeline-rendering-recovery.md`
  - Visual consistency should come from shared primitives and central visual tiers.
  - Context compaction should never be bundled.
  - No nested bundle rendering, no raw fallback, and no direct legacy file-edit row path.
- `992fe1b5^:plans/timeline-tool-shell-separation.md`
  - Source-derived messages should distinguish command execution, generic tool calls, file changes, and web.
  - Exploration belongs in the bundling layer, not the source-message layer.
- `53c8c33f^:plans/timeline-event-projection-reset.md`
  - Projection output should be flat; grouping belongs after projection.
  - File changes should be one row per change.
  - Permission grants should be visible.
  - Delegation child progress should remain primary.
- `a4fb7d74^:plans/timeline-grouping-boundary.md`
  - One explicit grouping boundary should sit after flat projection and before server contracts and React.
  - Active tail groups should only exist in active turns.
  - Group status and active wording should derive from children and active context, not from an independent lifecycle.
- `c944c3ae:plans/thread-streaming-experience.md`
  - Active work should be explicit and pending work expanded.
  - Completed work should use semantic groups.
  - Concurrent commands should remain one row per `callId`.
  - CLI verbose mode should preserve details.
- `7d4e5f73^:plans/context-usage-and-compaction.md`
  - Compaction should be visible through timeline events.
  - The context meter and timeline compaction rows are separate concerns.
- `3b68244b^:plans/provider-event-visibility.md`
  - Provider raw events include compaction, retry, and thinking events.
  - Provider-specific compaction events should eventually normalize into shared timeline behavior.
- `236a7923^:plans/approval-timeline-parity.md`
  - Approval lifecycle rows should feel like command and file-edit rows where the same information exists.
  - Approval state should stay semantic; do not fake execution rows.
- `fd396c29^:plans/pending-interaction-transport-redesign.md`
  - Pending interactions have lifecycle states: `pending`, `resolving`, `resolved`, `interrupted`.
  - UI, CLI, and timeline copy should distinguish pending, resolving, resolved, interrupted, and expired.
- `bd45ac9b^:plans/provider-agnostic-pending-interactions.md`
  - Pending interactions are first-class state, not thread status or timeline text.
  - App surfaces should reuse thread, composer, and banner primitives.
- `8d330f8f^:plans/thread-timeline-scroll-controller-refactor.md`
  - Older scroll-controller plan that still calls out the bottom sentinel and `Working...` placement.
- `37ab0197:plans/timeline-resolved-assistant-delta-pruning.md`
  - Narrow assistant-delta pruning plan; relevant mainly as a reminder not to lose semantic content during timeline cleanup.
- `93ab8183:plans/toolcall-rendering-improvement-plan.md`
  - Early exploration and web rendering plan; mostly superseded, but it shows the long-running intent to summarize exploration as a coherent activity concept.
- `08fb8a23^:plans/split-large-runtime-and-timeline-files.md`
  - Maintainability plan for splitting large timeline and runtime files into focused modules.

## Desired Visual-State Taxonomy

The taxonomy should separate resource lifecycle, visual treatment, and row concept. These are currently mixed together.

### Lifecycle State

- `pending`: durable work or interaction is waiting for something before it can complete. Examples: permission request awaiting user action, command/file edit awaiting approval, provider reconnect pending.
- `resolving`: the user or system has answered the pending condition, and the answer is being delivered or reconciled. This is distinct from still waiting.
- `active`: work is currently being performed and may produce more output. Examples: running command, in-progress file change, in-progress web fetch, active delegation, active compaction.
- `ongoing`: visual umbrella for `pending`, `resolving`, and `active` rows that should show live affordance. It is a display category, not a persisted resource state.
- `loading`: client-local fetch or lazy-load state. Examples: lazy turn details loading or initial thread timeline loading. This should not use the same policy as durable timeline work.
- `retryable-error`: a loading or transport failure with an explicit retry path.
- `error`: terminal failure in the work lifecycle.
- `completed`: terminal success.
- `interrupted`: terminal stop or cancellation that is not the same as failure.
- `expired`: terminal timeout of a pending interaction; visually closer to interrupted/error depending on copy and actionability.

### Row Concept

- `system-operation`: compaction, reconnect, ownership, permission grant lifecycle, provider/system operation messages.
- `assistant-activity-summary`: a semantic summary grouping work rows.
- `work-row`: command execution, tool execution, file change, web search/fetch, delegation, approval.
- `turn`: completed assistant/user turn wrapper or lazy summary wrapper.
- `steer`: user-authored steer message, accepted or pending.
- `manager-assignment`: ownership change. This may be modeled as a system operation, but its copy and detail treatment need a specific policy.
- `pending-interaction`: approval or provider prompt surfaced through banner, global indicator, and sometimes timeline rows.
- `global-thread-activity`: the timeline-tail "Working..." or reconnect/waiting indicator.
- `loading-placeholder`: initial timeline loading and lazy turn loading rows.

### Visual Treatment

- `tone`: neutral, muted, success, warning, danger, interactive-waiting.
- `shimmer`: on or off. Shimmer should attach to the title as a whole visual concept, not to whichever segment happened to be named `prefix`.
- `copy`: present-tense, past-tense, waiting, resolving, loading, retry, interrupted, error.
- `expansion`: never, available, auto-while-ongoing, auto-tail-while-scope-active, auto-on-error.
- `detail priority`: inline only, expandable detail, pinned detail, child rows.

## Current Code Audit

The current implementation distributes the same decision across several layers.

### Projection And View Model

- `packages/thread-view/src/build-thread-timeline.ts`
  - Builds command, tool, file-change, delegation, approval, system, error, and pending-steer rows.
  - Active turns render raw rows; completed turns can become lazy turn rows.
  - Pending steers are appended to the canonical row stream after projection/grouping, so they appear at the tail without splitting completed-turn summaries.
- `packages/thread-view/src/timeline-view.ts`
  - `shouldSummarizeRun` keeps single non-terminal work rows and single completed non-denied work rows as direct leaves; multi-row runs and single denied/error/interrupted rows still summarize.
  - Summary label tense is based on row status.
  - Summary status is merged from child statuses using error, pending, interrupted, completed precedence.
  - Whether multi-work runs should continue to summarize at all remains an open product question against the historical "no bundles for bundling's sake" direction.
- `packages/thread-view/src/operation-projection.ts`
  - Emits compaction begin/end/failure/interruption titles. Pending uses `Compacting context`; completed/failed/interrupted retain their existing copy.
  - Compaction visual state is encoded as system-row status and title text rather than a shared operation policy.
- `packages/thread-view/src/parse-operation-message.ts`
  - Maps permission-grant `pending` and `resolving` to the same pending row status.
  - Ownership rows suppress detail text when it duplicates the title and use production action titles for `assign`, `release`, and `transfer`.
  - Ownership metadata still carries only ids/action/status, not display names or link-ready labels.
- `packages/thread-view/src/user-message-parsing.ts`
  - Pending steers are parsed from unaccepted active-turn client requests and emitted as canonical tail conversation rows that stay outside projection/grouping.
  - Accepted steers become conversation rows and can split completed turn grouping.

### Title And Ongoing Affordances

- `packages/thread-view/src/timeline-row-title.ts`
  - `TimelineTitle` now encodes a semantic shimmer flag (`TimelineTitle.motion`).
  - Work row title builders independently decide active copy and shimmer.
  - Activity summary title wording comes from summary row status; renderer summary style still decides whether a summary looks like an active bundle or muted background.
  - Pending system rows request shimmer through `TimelineTitle.motion`; content-only title rendering honors that request.
- `packages/ui-core/src/thread-timeline/TimelineTitleView.tsx`
  - Applies shimmer to the prefix when present, and to content-only titles when no prefix exists.
- `packages/ui-core/src/thread-timeline/TimelineRowDetails.tsx`
  - Delegation details render a local `Working...` shimmer fallback for pending empty output.
  - This is another row-local ongoing affordance outside the title and expansion policy.

### Expansion, Tail State, And Loading

- `packages/ui-core/src/thread-timeline/ThreadTimelineRows.tsx`
  - `scopeActive` is derived from runtime display status, not from a shared timeline visual policy.
  - Pending-summary active bundle style and auto-expansion now share one predicate.
  - Auto-expansion still separately checks row expandability, scope activity, and row pending status for non-summary rows.
  - Lazy turn loading and retry UI are local renderer states.
- `apps/app/src/views/ThreadTimelinePane.tsx`
  - Renders durable `ConversationWorkingIndicator` inside the timeline column after rows and host notices.
  - Initial thread loading uses a delayed neutral `ConversationStatusIndicator`, not the durable working indicator.
- `apps/app/src/views/ThreadDetailView.tsx`
  - Consumes canonical `timeline.rows`; pending steers are no longer an app-local side channel.
  - Computes `showOngoingIndicator` from runtime status and pending interactions.
  - Uses global labels such as `Waiting for approval` independently of timeline row policy.
- `packages/ui-core/src/thread-timeline/ConversationWorkingIndicator.tsx`
  - Always applies shimmer to its label, with default copy `Working...` or `Thinking...`.

### Pending Interactions

- `apps/app/src/components/thread/ThreadPendingInteractionBanner.tsx`
  - Has explicit pending and resolving copy, including `Delivering`.
  - This state distinction is not consistently reflected in timeline rows or global thread activity.
- `apps/server/src/services/interactions/pending-interaction-timeline.ts`
  - Permission-grant lifecycle emits timeline events for `pending`, `resolving`, `resolved`, `interrupted`, and `expired`.
  - Command and file-change approval pending interactions do not emit a resolving timeline event.
- `apps/server/src/services/threads/thread-events.ts`
  - Ownership change events persist message and metadata ids, but not enough display data to render linked names without another lookup.
- `apps/server/src/services/threads/thread-send.ts`
  - Sends are queued as auto or steer mode with expected active turn id, which affects steer placement and turn grouping.

### Current Test Coverage

- `packages/thread-view/test/timeline-view.test.ts`
  - Tests direct-leaf behavior for single non-terminal and completed non-denied work rows.
  - Tests active summary labels for pending command, delegation, and file-change summaries when runs contain multiple rows.
- `packages/thread-view/test/timeline-row-title.test.ts`
  - Tests active wording and semantic shimmer for active summaries.
- `packages/ui-core/test/thread-timeline-rows.test.tsx`
  - Tests auto-expansion for pending summaries and lazy turn behavior.
  - Tests that pending work summarized by an active bundle still expands its pending children.
  - Tests system rows with detail are expandable/pinned.
  - Tests accepted and pending steer metadata rendering.
- `packages/ui-core/test/timeline-title-view.test.tsx`
  - Tests title segment emphasis and truncation, including content-only shimmer.

## Systemic Failures

- There is no single visual-state resolver. Present-tense copy, shimmer, expansion, and global activity are each decided in different files.
- `pending`, `active`, `ongoing`, `loading`, and `resolving` are treated as interchangeable in several surfaces.
- Shimmer is now encoded semantically, but broader visual state still lacks one resolver for copy, tone, expansion, and loading/error treatment.
- Active-tail policy lives in React renderer options, while title text lives in `@bb/thread-view`; the same state is not available to server, CLI, audit, and React equally.
- Activity-summary grouping is broader than the latest plans describe. Current tests lock "summarize every work run", while current plans point toward active-run grouping and fewer bundles.
- Pending interactions have richer lifecycle state in the app banner than they have in timeline work rows.
- System operations are a mixed bucket: compaction, reconnect, ownership, permission grants, and errors share row shape but need different copy, detail, shimmer, and expansion behavior.
- The global `Working...` indicator is still app-level state rather than a semantic timeline row, even though scroll plans treat it as bottom timeline content.

## Shippability Discrepancy And Intent Matrix

This section is the current decision point. It focuses on high-impact discrepancies only.

Side inputs incorporated here:

- Current-UX audit: `/Users/michael/.bb-dev/thread-storage/thr_bj3p5vk9py/reports/timeline-current-ux-consistency-audit.md`
- ASCII layout/spec artifact, source branch commit `28c1988e`: `/Users/michael/.bb-dev/thread-storage/thr_bj3p5vk9py/reports/timeline-layout-ascii-spec.md`
- Old behavior/plans audit: `/Users/michael/.bb-dev/thread-storage/thr_bj3p5vk9py/reports/timeline-old-behavior-plan-audit.md`

The ASCII artifact is the concrete layout reference for spacing, title matrices, lifecycle matrices, nesting, CLI/app notes, and representative S1-S7 scenarios. This plan references it as an input spec instead of duplicating its diagrams.

| Area | Evidence | Classification | Resolved Intent / Default | Next Action |
| --- | --- | --- | --- | --- |
| Manager view placeholder/reset mismatch | Current-UX audit found timeline query keys include `managerTimelineView`, while placeholder reuse and lazy turn loader reset only key by thread id. Batch-2 review also found the ui-core requested lazy-load ref was not scoped to view identity. | P0 shippability bug. | Switching manager timeline modes must not show stale rows/details from the previous mode, and must not suppress reloading the same lazy row id in the new mode. | Done in `b6bba144` and `0be5f97f` with placeholder, lazy loader reset, stale-response, and ui-core reload tests. |
| Active and streaming work visibility | Old renderer before the semantic cutover kept the active trailing buffer as leaf rows in `595c4f21^:packages/thread-view/src/thread-detail-rows.ts` (`buildAssistantStepSummaryRows(..., "active")` pushes trailing buffered rows directly). Old-behavior audit cites final plans that group active tails only when `>1` or active multi-row. Current `packages/thread-view/src/timeline-view.ts` summarized every non-empty work run via `shouldSummarizeRun`, and ui-core tests asserted pending work summarized by an active bundle did not auto-expand children. Historical plans `76b266ca^:plans/timeline-bundle-unification.md`, `09f8489a^:plans/thread-timeline-grouping-and-auto-expansion.md`, and current `plans/thread-view-package-boundary.md` all point toward active-tail grouping only, not hiding active leaves. User intent says streaming/active/non-terminal steps should prioritize WHAT and individual leaf rows should stay visible. | High-confidence regression for active/non-terminal app UX. | Active/non-terminal work should keep leaf rows visible. Active single work rows should render as leaves. Active multi-row summaries may exist, but pending child output must be visible/expanded even if completed work follows. | Done in `be71b62f`, `c59a78dc`, and `e687c5de` for non-terminal leaf visibility, pending-child expansion, and non-tail pending summary visibility; completed single-work intent is now handled separately in `0966e50f`. |
| Completed historical single work | Old renderer summarized completed terminal turn segments in `595c4f21^:packages/thread-view/src/thread-detail-rows.ts` via `buildTerminalTurnRows` and assistant-step summaries. The semantic renderer initially summarized every completed work run, including single commands/file changes. The user resolved the ambiguity: a completed single work item should be a direct leaf row, but that leaf title should use the same muted visual weight as a summary row so historical review stays quiet. | Product intent resolved. | Completed single work items render as direct leaf rows with muted summary-style titles in the app. CLI uses the same semantic direct leaf stream without inventing an extra one-item wrapper. Completed multi-work runs remain summaries. Denied approval and non-success terminal single rows keep their existing terminal summary behavior until separately decided. | Done in `0966e50f` with grouping, title, app rendering, and CLI snapshot coverage. The one-child detail-title question remains separate. |
| Single-row summary nesting | Old rendering-recovery plan explicitly rejected `Ran 1 command` expanding into a nested duplicate `Ran command`. Completed successful single work rows no longer use this path after `0966e50f`, but remaining one-child summaries can still exist for denied approval, error, interrupted, and other terminal exception states. User agrees duplicate nested titles should be avoided but wants back-and-forth before locking behavior. | Open product/design discussion; do not implement yet. | Detail bodies are mostly standalone: command details include the command line, tool details include `Tool: <name>`, and file diffs include file context. Web/approval bodies are currently null. Delegation details need care because the current delegation expandable body combines child rows and output. | Prepare options before implementation: keep nested title, direct detail-body extraction for one-child summaries, or a hybrid with titleless detail only when a standalone body exists. |
| Ongoing visual-state mechanics | `packages/thread-view/src/timeline-row-title.ts` now exposes semantic `TimelineTitle.motion`; pending system and approval rows can request motion without depending on prefix structure. `packages/ui-core/src/thread-timeline/TimelineTitleView.tsx` applies shimmer to the prefix when present and to content-only titles when no prefix exists. Historical plans still require a broader shared visual policy. | Local shippability bug fixed; durable policy remains future design work. | If a title requests shimmer, a content-only title should display shimmer. | Done in `7b977b2e` and the final readiness cleanup; broader resolver remains in the durable design batch. |
| Loading versus ongoing | `apps/app/src/views/ThreadTimelinePane.tsx` previously used `ConversationWorkingIndicator` for `Loading thread...`, while durable activity used the same primitive for `Working...` and pending approval labels. Lazy turn loading in `ThreadTimelineRows.tsx` has separate retry UI. User intent says loading means loading. | High-confidence consistency bug for initial thread loading; broader loading skeleton/spinner treatment is product/design. | Loading is client-local fetch state and should not be styled or narrated as durable thread work. | Initial thread loading fixed in `7d55c038`; broader loading visual policy remains in the durable design batch. |
| `Working...` indicator placement | `ThreadTimelinePane.tsx` rendered `ConversationWorkingIndicator` after a `ConversationTimeline className="flex-1"` sibling. Old-behavior audit found the old app also placed the indicator after the timeline, but manager investigation traced the new distance bug to commit `007c722d9` adding `flex-1`. ASCII artifact says global activity should be adjacent to the timeline tail and not pushed away by empty flex space. | High-confidence layout regression. | Keep the app-level tail indicator, but render it inside the timeline column so it stays visually attached to the latest timeline content while preserving composer pinning. CLI minimal global `Working...` remains an intent question. | Done in `0aca094a` with an app render test. |
| Active-tail label and expansion predicate | Old `595c4f21^:packages/ui-core/src/thread-timeline/NestedTimelineRows.tsx` built one auto-expand map from pending/error state and child rows. `ThreadTimelineRows.tsx` previously passed `preferOngoingLabel` for active tail summaries separately from `shouldAutoExpandRow`; a completed tail could get ongoing copy without matching expansion. Review then found `[pending,pending,completed,completed]` can leave real pending summaries before completed rows. | High-confidence consistency bug. | The same pending-summary predicate should decide active summary copy and default expansion, even when completed work follows. Completed summaries stay past tense/collapsed. | Done in `c59a78dc` and `e687c5de`. |
| Compaction and system rows | Current compaction titles come from `packages/thread-view/src/operation-projection.ts`; generic system operations and ownership come through `packages/thread-view/src/parse-operation-message.ts`. Historical `7d4e5f73^:plans/context-usage-and-compaction.md` and `3b68244b^:plans/provider-event-visibility.md` require compaction/provider operations to be visible, but not necessarily bundled. Current system rows share one title/detail/shimmer path. | Mixed: visible compaction is intentional; visual treatment inconsistency is a bug; exact broader system copy is product intent. | Compaction uses `Compacting context`, `Context compacted`, `Context compaction interrupted`, and `Context compaction failed`; provider/system operations still need sub-policies under the shared visual-state resolver. | Pending compaction title fixed in `df72e830`; content-only shimmer already fixed in `7b977b2e`. |
| Failed system operations | Current-UX audit found operation failures map to `status: "error"` but app title tone only checks `systemKind === "error"`. | P1 shippability bug. | Failed system operations should render destructive/error treatment even when the system kind is `operation`. | Done in `b2fbf81c` with title/tone coverage. |
| Delegation error/interrupted wording | Current-UX audit found app delegation titles use only pending vs ran, while CLI has failed/interrupted verbs. | P2 app/CLI consistency bug. | App and CLI should share delegation lifecycle wording. | Done in `b2fbf81c` with failed/interrupted title coverage. |
| Active exploration tense | Current-UX audit found compact exploration detail labels always use completed tense (`Read`, `Listed`, `Searched`) even when active. | P1 consistency bug. | Active exploration labels should use present tense in active contexts. | Done in `b2fbf81c` for shared title/text formatters; active leaf visibility remains a separate grouping batch. |
| Manager assignment / ownership rows | Server ownership events in `apps/server/src/services/threads/thread-events.ts` persist ids/action/status and message, not display names. Current `parse-operation-message.ts` previously built detail from `decoded.message`, which could duplicate the row title, and mapped release/transfer to misleading titles. Manager timeline tests in `apps/server/test/threads/timeline-service.test.ts` intentionally keep manager-visible operations. | Duplicate detail and action titles fixed; names/links remain ambiguous product intent. | Ownership rows should not expand only to repeat their title. Titles should mirror production `assign`, `release`, and `transfer` messages. Rich manager labels need a product/data decision. | Done in `7a1b0c50` and `00764ab6`. Ask intent question 4 before adding names/links. |
| Steers | Steer grouping audit `/Users/michael/.bb-dev/thread-storage/thr_bj3p5vk9py/reports/timeline-steer-turn-grouping-audit.md` verified pending steers previously never entered projection/grouping, while accepted steers intentionally become normal user conversation rows at acceptance position and split completed-turn/activity grouping. User aligned that pending steers should be shared semantic rows, with the invariant that a trailing pending steer must not block pending/latest expandable work expansion. | Product intent resolved and implemented. | Accepted steers stay canonical accepted user rows at acceptance position. Pending steers are canonical tail conversation rows but remain outside projection/grouping, so they do not split historical turn summaries. Manager-conversation timelines continue hiding pending steers unless standard manager view is requested. | Done in `4f11c810` with app/CLI side-channel removal, server-contract cleanup, manager visibility tests, grouping guard assertions, and active-expansion coverage for a trailing pending steer. |
| Command/file-edit/tool bundling | Old `595c4f21^:thread-detail-rows.ts` bundled exploration, commands, web, and delegations; file edits were counted in assistant-step summaries. Current `timeline-view.ts` summarizes multi-work command/tool/file-change/web/delegation runs uniformly and excludes approval only. Current `timeline-cli-rendering.snapshots.test.ts` locks summary text such as `Working on 3 items` and `Worked on 2 items`. Historical `992fe1b5^:plans/timeline-tool-shell-separation.md` says source messages should distinguish command, generic tool, file changes, and web; `76b266ca^` says no bundles for bundling's sake. | Mixed: active leaf hiding was a regression and is fixed; completed single direct leaf is now intentional; broader multi-work summary style remains a product/design area. | Keep concept-specific leaf rendering and summary labels; do not collapse generic tools, commands, and file edits into indistinguishable rows. Active and completed single work leaves stay visible; completed multi-work runs stay summarized unless product changes that rule. | Done for active/non-terminal and completed-single cases in `be71b62f`, `c59a78dc`, `e687c5de`, and `0966e50f`. Revisit only broader multi-work bundling and remaining one-child exception summaries. |
| App versus CLI divergence | Current CLI `packages/thread-view/src/format-timeline-text.ts` formats the same `buildTimelineViewRows` model with text-only hierarchy, status labels, and verbose detail. App has lazy loading, shimmer, expansion, file actions, and global indicators. Audit code records semantic and rendered row counts in `packages/agent-provider-audit/src/build-artifacts.ts`. | Acceptable divergence if documented. | App and CLI should share semantic rows and summary decisions; presentation-only differences are acceptable. | Document this explicitly in the plan and add tests when behavior changes. |
| Web search/fetch result text | App web rows are non-expandable and `TimelineRowDetails.tsx` returns null for web-search/web-fetch. CLI verbose previously rendered `row.resultText` for direct web rows. Keeping `resultText` on timeline rows or internal projection messages would be an accepted-but-unrenderable payload. Raw provider events still carry provider result text, but projection lifecycle/message state and the shared timeline row contract ignore it. | High-confidence shippability bug for CLI and projection/contract cleanup. | Neither app nor CLI should expose web result text. Timeline row conversion should not populate result payloads for consumers, and the CLI formatter should not render them defensively. | Done in `0f7465a0`, `33a50f84`, and the internal projection cleanup with regression coverage for direct active web rows and completed web rows inside summaries. |
| Performance parity | Old renderer computed row activity and auto-expand maps with recursive walks in `595c4f21^:NestedTimelineRows.tsx`. Current `ThreadTimelineRows.tsx` memoizes `buildTimelineViewRows` through `useTimelineViewRowsCache` and records rendered/semantic counts in provider audit. Any richer visual policy must not add per-frame or per-row unstable work during streaming. | Risk area, not proven regression. | Policy resolution should be linear in row count, memoized by stable row identity, and should not expand lazy turn details automatically outside active needs. | Add perf guard notes to implementation batches; use existing timeline benchmark fixtures if grouping changes are broad. |

## Reviewer Nit Triage

- `preferOngoingLabel` was dead after active summary changes: production only set it for activity summaries, and activity summaries no longer read it. Removed in `c585d34a`.
- CLI active streaming command coverage was too loose. `c585d34a` added an inline snapshot for the single active command leaf shape.
- `[pending,pending,completed,completed]` is realistic for concurrent or out-of-order tool completion. `e687c5de` keeps pending summaries active/expanded even when completed work follows.

## Visual/Layout Audit Findings

- `Working...` tail distance was a concrete flex-layout regression and is fixed in `0aca094a`.
- Initial thread loading reused durable work shimmer and is fixed in `7d55c038`; lazy turn loading/retry already uses separate local copy.
- Pending compaction now uses `Compacting context` in `df72e830`; completed, failed, and interrupted compaction copy remains unchanged.
- Large command output is already clamped by `TerminalOutputBlock` through `getDetailScrollMaxHeightClass("regular")` and uses sticky-bottom detail scrolling. No concrete performance regression was found from code inspection; measure before changing height, truncation, or virtualization.
- Nested delegation timelines still render inside a bordered rounded container in `ThreadTimelineRows.tsx`. The ASCII spec prefers rail-only nested timelines, but changing that is a broader visual design pass because it affects all delegation/subagent detail framing.

## Open Product Intent Questions

1. ~~Remaining one-child summary expansion behavior for exception states~~ **Resolved.** Single terminal work rows are muted direct leaves regardless of status. Non-success rows append a status suffix to the title — `Ran <cmd> 2s (error)`, `(denied)`, `(interrupted)` — and tone shifts on the suffix. No summary wrapper around a single child. `shouldSummarizeRun` should treat all single terminal rows uniformly. (See Q1 in `plans/timeline-layout-ascii-spec.md`.)
2. ~~Intended behavior for completed assistant-boundary steps~~ **Resolved.** Each assistant-message boundary inside an unfinished turn closes the current step. Completed work between two assistant messages becomes one muted step summary; the next assistant message is its sibling. The final assistant message of a finished turn renders outside `Worked for <duration>` as its sibling. This matches the existing `Active Streaming Progression` and `Historical Turn, Expanded` examples in the ASCII spec.
3. What is the intended compaction/system-operation copy hierarchy?
   - Old plans require compaction to be visible, but do not settle exact labels.
   - Default recommendation: `Compacting context`, `Compacted context`, `Context compaction interrupted`, `Context compaction failed`, with shimmer only for non-terminal compaction.
4. What should manager assignment rows show: plain status text only, manager/thread display names, links, avatars, or other ownership metadata?
   - Current events do not persist names.
   - Default recommendation: use production action titles already fixed; defer rich labels until event metadata or lookup policy is chosen.
5. Should CLI expose the app's standard manager timeline/debug view, or is manager standard mode intentionally app-only?
   - App has a manager timeline preference; CLI currently uses the default manager conversation timeline.
   - Default recommendation: document app-only debug mode unless CLI users need manager internals.
6. What maximum expanded command-output height or virtualization threshold is required for performance parity?
   - Dev DB samples have very large command-output volume.
   - Default recommendation: clamp or virtualize only after measuring current expanded output behavior.
7. Should nested subagent timelines move from the current bordered detail container to the ASCII spec's rail-only treatment?
   - Default recommendation: handle this in the broader timeline visual design pass, not as a local patch.

## Shipped Shippability Fixes

The following local consistency fixes shipped to main and no longer need plan tracking. They are listed once for context; future work should not re-litigate them without a separate proposal:

- Content-only shimmer for pending system and approval rows.
- Ownership/manager-assignment duplicate-detail suppression and production-aligned action titles.
- Manager timeline view mode propagated through placeholder reuse, lazy turn-row reset/stale-response handling, and ui-core lazy-load suppression.
- Active exploration tense, failed system-operation tone, and delegation failed/interrupted wording aligned across app and CLI.
- Active/non-terminal single work rows kept as leaves; completed runs split correctly.
- Active summary style and default expansion now share one predicate; pending children inside active bundles auto-expand even when completed work follows.
- App `Working...` indicator stays attached to timeline content; initial thread loading uses neutral loading state instead of durable shimmer.
- Pending compaction copy normalized to `Compacting context`.
- Web search/fetch result text suppressed in timeline rows, CLI verbose rendering, contract types, and projection lifecycle/message state.
- Pending steers moved into canonical timeline rows while staying outside projection/grouping and hidden from manager-conversation timelines.
- Stale `preferOngoingLabel` title option removed.

## Remaining Work

In rough priority order:

1. Lock the open product-intent questions below (one-child summary expansion for exception states, manager assignment metadata, nested subagent rail vs bordered container, multi-work bundling direction).
2. Introduce the durable visual-state policy contract (Batch 1) once the product answers above are stable enough to encode.
3. Measure large expanded command-output behavior before changing height, truncation, or virtualization.

## Local Bugs Or Safe Fix Candidates

No remaining low-risk local fixes were identified in the current visual/layout pass. The remaining items need product/design choice or measurement.

## Product Or Design Choices Needed

These should not be patched locally without a product decision:

- Remaining one-child summary expansion behavior for denied, error, interrupted, and other exception states.
- Whether completed assistant-boundary steps need explicit separate summaries inside expanded turn details.
- Whether command and file-edit approval interactions need explicit resolving timeline rows, or whether resolving should remain banner-only.
- Exact copy hierarchy for pending interaction surfaces when both a banner and global thread activity indicator are visible.
- Whether manager assignment rows need display names, links, avatars, or just non-expandable production action text.
- Whether CLI should expose standard manager timeline internals or keep them app-only.
- Whether nested subagent timelines should use rail-only layout instead of the current bordered detail container.
- Whether app command output should keep the current scroll clamp, add explicit truncation notices, or virtualize very large output.

## Durable Design

Add a shared visual-state policy after projection/grouping and before rendering. It should live in `@bb/thread-view` unless implementation proves a narrower package boundary is needed, because `@bb/thread-view` already owns projection, grouping, labels, and shared timeline semantics.

The policy should produce a required, strongly typed presentation contract for every row:

- row lifecycle display state: pending, resolving, active, loading, retryable-error, error, completed, interrupted, expired.
- row concept: system-operation, assistant-activity-summary, work-row, turn, steer, manager-assignment, pending-interaction, global-thread-activity, loading-placeholder.
- title copy and tense.
- title shimmer as a semantic value.
- tone and icon treatment.
- expansion intent.
- whether this row participates in active-tail policy.
- detail treatment: inline, expandable, pinned, child rows, or none.

Renderer code should consume this policy and map it to components. It should not rediscover active-tail status or special-case shimmer based on title segment names. Manual expansion overrides remain renderer state, but the default expansion intent should come from the shared policy.

The transition can preserve current behavior first by adding an adapter that expresses today's rules in the new contract. After that, product-visible changes can be made deliberately.

## Implementation Batches

### Batch 1: Introduce The Policy Contract Without UX Churn

- Define shared timeline visual-state types in the appropriate `@bb/thread-view` type module.
- Add a resolver that takes row, runtime scope context, tail context, and row concept, then returns a required visual-state object.
- Keep `TimelineTitle.motion` as the current semantic shimmer field and avoid prefix-specific shimmer contracts.
- Update `TimelineTitleView` to apply shimmer to the semantic title target, including content-only titles.
- Keep existing labels and expansion outcomes unless tests reveal contradictions that must be decided.

Validation:

- `pnpm exec turbo run typecheck --filter=@bb/thread-view --filter=@bb/ui-core`
- `pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/ui-core`

Behavior tests:

- Pending system and pending approval titles expose ongoing visual treatment even without prefix text.
- Completed, idle system rows do not expose ongoing treatment.
- Existing command, file-change, delegation, web, and activity-summary copy remains unchanged in compatibility mode.

### Batch 2: Centralize Active-Tail And Expansion Rules

Status: local predicate alignment is done in `c59a78dc` and `e687c5de`; the broader shared-policy migration remains future work.

- Pending summary active styling now uses the same predicate as default expansion.
- Pending children inside active bundles are default-expanded so active work remains visible.
- Completed tail summaries no longer borrow present-tense copy from active scope.
- Manual expansion overrides remain renderer-owned.

Validation:

- `pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/ui-core`

Behavior tests:

- A pending summary that shows active copy has the matching default expansion behavior.
- A pending non-tail summary does not auto-expand just because the thread is active.
- Manual collapse and manual expand continue to override defaults.

### Batch 3: Put Global Activity And Loading Into The Right Surface

- Treat `Working...`, reconnect waiting, pending approval waiting, and initial loading as separate visual concepts.
- Keep client-local loading separate from durable timeline activity.
- Keep the existing separate app tail indicator unless visual QA shows it is detached from the latest timeline content.
- Fix spacing/flex behavior if the tail indicator is pushed away from the latest row.
- Verify bottom-pinning behavior with the existing scroll controller.

Validation:

- `pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/ui-core`
- `pnpm exec turbo run test --filter=@bb/app --filter=@bb/ui-core`

Behavior tests:

- Active thread activity appears adjacent to the latest timeline content.
- Initial thread loading does not masquerade as durable in-thread work.
- Reconnect and pending-approval waiting copy remains distinct.

### Batch 4: Resolve Pending Interaction State Consistency

- Preserve `pending` versus `resolving` in timeline presentation for permission grants.
- Decide whether command and file-change approval interactions emit resolving timeline rows.
- Ensure banner, global indicator, and timeline rows use the same lifecycle vocabulary.

Validation:

- `pnpm exec turbo run test --filter=@bb/server --filter=@bb/thread-view --filter=@bb/app`

Behavior tests:

- Pending approval shows waiting copy.
- Resolving approval shows delivering/resolving copy.
- Denied, interrupted, and expired interactions render distinct terminal outcomes.

### Batch 5: Revisit Remaining Grouping And Bundling Product Behavior

- Active/non-terminal leaf-first behavior is done in `be71b62f` and `c59a78dc`; completed single-work grouping is resolved separately.
- Completed successful single-work direct-leaf behavior is done in `0966e50f` with muted app title treatment.
- Decide whether current completed multi-work activity-summary behavior is still desired.
- If not, implement the existing completed-state plan direction for multi-work runs: no bundles for bundling's sake, flat grouping boundary after projection, and no nested duplicate one-child exception summaries.
- Keep one command row per `callId`.
- Keep file changes lossless and preserve canonical file-link behavior.
- Make CLI/server/audit/React consume the same grouped presentation model.

Validation:

- `pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/ui-core`
- Add or update CLI/audit tests if their rendering contracts change.

Behavior tests:

- Completed single command remains a leaf if that product choice is selected.
- Active single command remains a leaf.
- Pending child command output stays visible while active.
- Active tail work groups only while the enclosing scope is active.
- Web, exploration, command, file-change, delegation, and approval concepts do not collapse into misleading labels.

### Batch 6: Ownership And Manager Assignment Rows

- Completed local cleanup: duplicate title detail suppression and production action titles for `assign`, `release`, and `transfer`.
- Decide whether ownership rows should include names, links, avatars, or only ids/action text.
- If names or links are required, extend server event metadata or add a typed lookup path at the correct boundary.
- Keep ownership rows non-expandable when no additional detail exists.

Validation:

- `pnpm exec turbo run test --filter=@bb/server --filter=@bb/thread-view --filter=@bb/ui-core`

Behavior tests:

- Ownership rows do not duplicate title text in expandable detail.
- Manager assignment rows show the agreed display data.
- Existing historical ownership events remain renderable.

## Exit Criteria

- One shared visual-state policy determines copy, shimmer, expansion intent, loading, retry, and terminal treatment for timeline rows.
- `pending`, `active`, `ongoing`, `loading`, and `resolving` have explicit meanings and are not used interchangeably.
- Shimmer is not tied to `prefix` segment existence.
- Active-tail labels and auto-expansion are driven by the same predicate.
- Global thread activity, lazy loading, and pending interaction banners have distinct visual concepts and copy.
- System operations have explicit sub-policies for compaction, reconnect, permission grants, ownership, generic operations, errors, and interruptions.
- Activity-summary grouping behavior is either reconciled with the active-run historical plan direction or explicitly retained with tests and rationale.
- Tests assert user-visible behavior and model outcomes, not brittle private call sequences or incidental class names.
- All validation uses Turbo commands.

## Validation Plan

Recent validation for completed implementation slices:

- `pnpm exec turbo run typecheck --filter=@bb/app`
- `pnpm exec turbo run test --filter=@bb/app`
- `pnpm exec turbo run typecheck --filter=@bb/thread-view`
- `pnpm exec turbo run test --filter=@bb/thread-view`
- `pnpm exec turbo run typecheck --filter=@bb/ui-core`
- `pnpm exec turbo run test --filter=@bb/ui-core`
- `pnpm exec turbo run typecheck --filter=@bb/thread-view --filter=@bb/ui-core`
- `pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/ui-core`

For remaining broader implementation, use Turbo for checks:

```sh
pnpm exec turbo run typecheck --filter=@bb/thread-view --filter=@bb/ui-core --filter=@bb/app --filter=@bb/server
pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/ui-core --filter=@bb/app --filter=@bb/server
```

For slow or broad test runs, pipe output to a file and inspect it afterwards:

```sh
pnpm exec turbo run test --filter=@bb/ui-core --force > /tmp/timeline-ui-core-test-out.txt 2>&1
```
