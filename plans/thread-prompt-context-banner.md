# Thread Prompt Context Banner Plan

Status: revised draft for Michael review. Do not implement UI or code changes until sign-off.

## Goal

Replace the current git-only strip above the thread follow-up composer with a high-signal thread context banner. The banner should answer: "What should I know before I send this next message?"

The banner should adapt by thread context:

- Regular threads: keep the current git status behavior and add clean ahead/behind/diverged states when available.
- Manager threads: show active managed threads that the manager is waiting on, with a `Stop all` affordance when there are active managed children.
- Managed threads: make manager ownership visible before the user sends a direct message.
- All threads: show pending TODOs collapsed by default, with user-controlled expansion.

## Product Decisions For Michael

Implementation should not start until Michael signs off on these first-pass product choices. The recommendations below are treated as planning assumptions in the rest of this document.

1. Should clean up-to-date regular threads show a banner?
   - Recommendation: no. Keep the surface high-signal.

2. Should errored managed child threads appear in the banner's managed-work section?
   - Recommendation: no. The banner answers "what is the manager waiting on?" An errored child has already finished waiting, and mixing non-stoppable error states with stoppable active work makes `Stop all` ambiguous. Surface errored work elsewhere if needed.

3. Should failed plan steps appear in the TODO section?
   - Recommendation: no for the first pass. Treat failed work as a separate future signal if needed.

4. Should TODO expansion persist across visits?
   - Recommendation: no. Start with local per-thread state that resets on thread change.

5. Should manager threads with no active children show `No active managed threads`?
   - Recommendation: no. Hide the section unless it has signal.

6. Should the CLI adopt the new banner data sources (timeline `pendingTodos` and managed-children derivation) now?
   - Recommendation: no. Keep this first pass app-focused and avoid widening the scope.

7. If merge-base ahead/behind counts exist but committed file stats are missing or empty, should the banner still show branch divergence?
   - Recommendation: yes. Show textual branch divergence and omit expansion.

8. If the cached project thread list is unavailable, should the banner show a general error?
   - Recommendation: no by default. Preserve managed-by fallback when `thread.parentThreadId` is known, omit uncertain manager-work sections, and keep the composer usable. TODO failures piggyback on the existing timeline query and follow timeline error semantics.

9. Should a `turn/plan/updated` explanation or plan-level label appear in the TODO banner?
   - Recommendation: no for the first pass. Show step text only unless the explanation is short and clearly useful; revisit after seeing real provider plan snapshots.

## Existing Locations And Data Sources

Current app UI path:

- `apps/app/src/views/ThreadDetailView.tsx`
  - Loads `thread`, `parentThread`, `timeline`, `environment`, and `workspaceStatus`.
  - Computes `workspaceChangedFilesSection`, `promptBannerSummary`, `showPromptGitStatsBanner`, `canExpandPromptChangeList`, and passes banner props into `ThreadDetailPromptArea`.
- `apps/app/src/views/ThreadDetailPromptArea.tsx`
  - Owns current prompt-banner expansion state via `isChangeListExpanded`.
  - Passes a `banner` prop object to `ThreadFollowUpComposer`.
- `apps/app/src/views/ThreadFollowUpComposer.tsx`
  - Renders the current rounded muted git banner above queued follow-ups and `PromptBox`.
  - Uses `WorkspaceChangesList` and `MergeBaseBranchPicker`.
- `apps/app/src/lib/workspace-change-summary.tsx`
  - `selectWorkspaceChangedFilesSection` decides whether a changed-files section exists.
  - This is why clean ahead/behind status currently does not show in the prompt banner.
- `apps/app/src/lib/workspace-status.tsx`
  - `getGitStatusDisplay` already formats `Ahead`, `Behind`, and `Diverged`.
  - `apps/app/src/lib/workspace-status.test.ts` already covers those display states.

Current git data path:

- `useEnvironmentWorkStatus` in `apps/app/src/hooks/queries/environment-queries.ts`
- `api.getEnvironmentWorkStatus` in `apps/app/src/lib/api.ts`
- `GET /api/v1/environments/:id/status` in `apps/server/src/routes/environments.ts`
- Host command `workspace.status`
- Domain contract `WorkspaceStatus` in `packages/domain/src/thread.ts`
  - `workspaceStatus.workingTree.state`
  - `workspaceStatus.mergeBase.aheadCount`
  - `workspaceStatus.mergeBase.behindCount`
  - `workspaceStatus.mergeBase.mergeBaseBranch`
  - `workspaceStatus.mergeBase.files`

Current manager/managed data path:

- `ThreadWithRuntime.type` and `ThreadWithRuntime.parentThreadId` in `packages/domain/src/thread.ts`
- `ThreadListEntry` includes runtime display status and `hasPendingInteraction`.
- The cached project thread list (already loaded for the sidebar) and the cached parent-thread record (already loaded by `ThreadDetailView`) cover everything the banner needs to derive manager ref and active managed children.
- The new banner reuses these cached queries rather than introducing a parallel route. The only new server endpoint is the bulk-stop action route.

Current TODO data situation:

- `TodoWrite` is known to thread-view formatting in `packages/thread-view/src/tool-call-parsing.ts`.
- The existing private `asTodoWriteTodos` parser in that file already normalizes loose provider arguments into `{ content, status, activeForm }` values. The implementation should replace it with a canonical zod-backed thread-view helper instead of duplicating ad hoc parsing.
- `TodoRead`, `TodoWrite`, and `ToolSearch` are suppressed from timeline rows by `packages/thread-view/src/tool-call-suppression.ts`. Suppression hides rows from the rendered timeline; the projection itself still observes the underlying events.
- Provider plan snapshots also exist as `turn/plan/updated` events. The event has a `plan` array; each step has its own optional `status` field whose value can be `pending`, `active`, `completed`, or `failed`.
- The timeline projection in `@bb/thread-view` already walks events to compute tail-only state such as `activeThinking` and `contextWindowUsage`. Pending TODO snapshot extraction is the same shape of work and should live in the projection rather than a separate server query.
- There is no first-class API contract for "pending TODOs" today. The banner should not parse raw timeline rows client-side; the typed projection result should expose a `pendingTodos` field alongside `activeThinking`.

## Recommended Architecture

Keep the banner as an app-composed surface with three data lanes, all backed by data the app already loads. No new GET route is introduced.

- **Git/workspace context** stays on the existing environment status route.
- **Pending TODO snapshot** is tail-only timeline state and is computed by the existing timeline projection in `@bb/thread-view`, returned alongside `activeThinking` on the existing thread timeline route. It is only meaningful on `latest` page requests.
- **Manager/managed-thread context** is derived client-side from the cached project thread list (the same data that powers the sidebar). The banner reads `ThreadListEntry` records and computes manager ref + active managed children in a view model.

The split is intentional:

- Workspace status is host-local, already has an environment-scoped refresh cadence, and already powers diff-panel and merge-base picker behavior.
- Pending TODOs are derived from the same event stream that already drives `activeThinking` and `contextWindowUsage`. Putting them on the projection avoids a duplicate SQL query, avoids a new indexed projection for tool-call names, and reuses existing timeline cache invalidation.
- Manager/managed-thread context is fully derivable from `ThreadListEntry` records (title, `parentThreadId`, `runtimeDisplayStatus`, `hasPendingInteraction`). The sidebar already loads this list, so adding a parallel server route would re-fetch the same data with a different shape. Use the cached list, do filtering/sorting in the view model.
- The app composes all three lanes into one banner view model so users see one surface.

Single predicate for managed work:

- The banner uses `runtimeDisplayStatus` alone to decide which managed children appear and which the `Stop all` button targets. There is no separate "stoppable" predicate; the visible set IS the stop target set.
- Pick a clear "running" set, for example `active`, `host-reconnecting`, `waiting-for-host`. This must be a published view-model constant, not scattered across components.
- Errored, idle, archived, and pre-start (`created`/`provisioning`) children do not appear in this banner section. The banner answers "what is the manager waiting on?" — finished, idle, or unstarted children are not part of that answer.
- Server-side, the bulk-stop route still runs the existing lifecycle helper per child as a correctness detail: idempotent on already-stopping children, skips children that became ineligible between target resolution and dispatch, returns typed per-child outcomes. That is invisible to the user.

Add shared contracts only where new typed data crosses package boundaries:

- Timeline projection types live in `packages/thread-view/src/build-thread-timeline.ts` and `packages/domain/src/thread-timeline-pending-todos.ts`.
- Bulk-stop request/response types live in `packages/domain/src/thread-manager-bulk-stop.ts` and `packages/server-contract/src/api-types.ts`.
- Public route docs: `packages/server-contract/src/public-api.ts` (timeline route extension + new bulk-stop action route).
- Banner view-model types are app-local; they are not new contract types.

Use repo naming conventions:

- Schemas: `threadTimelinePendingTodosSchema`, `threadTimelinePendingTodoItemSchema`, `threadManagerBulkStopRequestSchema`, `threadManagerBulkStopResponseSchema`
- Types: `ThreadTimelinePendingTodos`, `ThreadTimelinePendingTodoItem`, `ThreadManagerBulkStopResponse`, `ThreadManagerBulkStopChildResult`

Proposed timeline-projection extension:

```ts
// Existing projection result already has activeThinking and contextWindowUsage.
// pendingTodos is added with the same tail-only semantics as activeThinking.
type ThreadTimelineFromEventsResult = {
  rows: TimelineRow[];
  activeThinking: ActiveThinking | null;
  contextWindowUsage: ThreadContextWindowUsage | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
};

type ThreadTimelinePendingTodos =
  | { kind: "unparseable"; latestCandidateSeq: number; latestCandidateSource: "todoWrite" | "turnPlan" }
  | {
      kind: "observed";
      source: "todoWrite" | "turnPlan";
      sourceSeq: number;
      updatedAt: number;
      items: ThreadTimelinePendingTodoItem[];
    };

type ThreadTimelinePendingTodoItem = {
  id: string;
  text: string;
  status: "pending" | "in_progress";
};
```

Proposed bulk-stop contract:

```ts
type ThreadManagerBulkStopRequest = {
  // Empty body. Targets are resolved server-side from the manager threadId in the URL.
};

type ThreadManagerBulkStopOutcome =
  | "requested"
  | "alreadyStopping"
  | "skipped"
  | "failed";

type ThreadManagerBulkStopSkippedReason =
  | "notStoppable"
  | "missingEnvironment"
  | "environmentUnavailable"
  | "archived"
  | "deleted"
  | "reparented"
  | "crossProject";

type ThreadManagerBulkStopChildResult =
  | { threadId: string; outcome: "requested" | "alreadyStopping" }
  | { threadId: string; outcome: "skipped"; reason: ThreadManagerBulkStopSkippedReason }
  | { threadId: string; outcome: "failed"; message: string };

type ThreadManagerBulkStopResponse = {
  managerThreadId: string;
  requestedCount: number;
  alreadyStoppingCount: number;
  skippedCount: number;
  failedCount: number;
  results: ThreadManagerBulkStopChildResult[];
};
```

Notes:

- Use zod schemas as the source of truth, exported from shared packages.
- The banner-visible managed-children set and the bulk-stop targets are the same set, derived from `runtimeDisplayStatus`. There is no `stoppableCount` field; the count is `items.length` on the client.
- `pendingTodos: null` mirrors `activeThinking: null` semantics: it is the response shape for older timeline pages or for a thread where no TODO/plan candidate was observed by the projection. The UI hides the TODO section in either case.
- `pendingTodos.kind === "unparseable"` means one or more TODO/plan candidates were observed by the projection but none could be converted into a valid snapshot. The server should log or meter this.
- `pendingTodos.kind === "observed"` with `items: []` means the latest valid snapshot exists and has no pending or in-progress items.
- Do not expose `unknown` to the app. Parse `TodoWrite` arguments at the projection boundary with a zod-backed helper exported from `@bb/thread-view`.

## Data Semantics

### Git Status

Use the existing `WorkspaceStatus` contract and `getGitStatusDisplay`.

Show a git section for standard threads when one of these is true:

- `workingTree.state` is `untracked`, `dirty_uncommitted`, `committed_unmerged`, or `dirty_and_committed_unmerged`.
- `mergeBase.aheadCount > 0` or `mergeBase.behindCount > 0`, including when `workingTree.state === "clean"`.
- `mergeBase.files.length > 0`, when available.
- Workspace is deleted or status failed with a durable error worth surfacing.

Recommendation: keep clean up-to-date regular threads quiet. This preserves the high-signal goal and avoids turning the banner into persistent chrome.

Open git-data edge:

- If `aheadCount` or `behindCount` is positive but `mergeBase.files` is empty or missing, show the ahead/behind/diverged text and omit file expansion. Do not treat missing file stats as an error.

### Active Managed Threads

The banner derives the active managed-children list client-side from the cached project thread list (the same data that drives the sidebar). No new server query is required for read.

View-model derivation:

- Filter cached `ThreadListEntry` records where `parentThreadId === thread.id`, `projectId === thread.projectId`, `archived === false`.
- Apply the single managed-work predicate based on `runtimeDisplayStatus`. Recommended "running" set: `active`, `host-reconnecting`, `waiting-for-host`. Excluded: `idle`, `error`, `created`, `provisioning`.
- Define this set as a published view-model constant, for example `THREAD_BANNER_ACTIVE_MANAGED_RUNTIME_STATUSES`. Do not duplicate the set across components.
- Sort by status priority, then `latestAttentionAt` descending:
  - pending interaction (`hasPendingInteraction === true`)
  - active or host reconnecting
  - waiting for host
- Apply a soft cap, for example `THREAD_BANNER_ACTIVE_MANAGED_LIMIT = 20`. Compute `totalCount` from the unfiltered match count so the UI can render a truncation note such as `Showing 20 of 37`.

Single predicate, single set:

- The banner-visible managed-children set and the `Stop all` target set are the same set. There is no separate "stoppable" count.
- `Stop all` is shown when `items.length > 0` and the thread is a manager.
- Pre-start children mid-launch (with an active start operation but `runtimeDisplayStatus` still `created`/`provisioning`) are not shown and are not stop targets. This is a small fidelity gap but eliminates the two-predicate confusion. The bulk-stop route still handles them correctly server-side if they happen to be in target resolution at action time.

Manager stop control:

- Show a `Stop all` button when there is at least one item in the managed-work section.
- Place the button near the managed-work summary as a high-signal manager-control affordance, not buried inside the expanded list.
- Do not mutate child `status` client-side. The action POSTs to the bulk-stop route, which calls the existing lifecycle stop owner for each child.
- Require a confirmation step when there is more than one item in the visible managed-work section, with copy that states how many managed threads will be stopped. A single managed child may use the existing stop interaction pattern.
- The banner refreshes through the existing project thread-list invalidation path; no banner-specific cache key is added.

Bulk-stop semantics:

- Add an action route `POST /api/v1/threads/:id/managed-children/stop` (manager threadId in the URL).
- Apply lifecycle gating with `requirePublicThread` (thread exists, not deleted), then `requirePublicProject(managerThread.projectId)` (project exists, not pending-delete). Assert the target thread is a manager.
- Resolve child targets in SQL by `parentThreadId = managerThread.id`, `projectId = managerThread.projectId`, non-archived/live state, and the same `runtimeDisplayStatus`-based predicate the UI uses. Same-project enforcement must happen in the query, not only in UI assumptions.
- Resolve each target child's environment before calling the lifecycle owner. Use the child `environmentId` to load `{ id, hostId }`; if the environment is missing, deleted, or unusable for stop dispatch, emit a typed `skipped` result with `missingEnvironment` or `environmentUnavailable`.
- Call the existing lifecycle stop owner for each target child (e.g. `requestThreadStopIfNeeded`) instead of directly mutating child status.
- Repeated clicks are idempotent: already stopping or already stopped children should not cause the whole operation to fail.
- Partial failures return `ThreadManagerBulkStopResponse` with per-child outcomes (`requested`, `alreadyStopping`, `skipped`, `failed`) plus aggregate counts. The UI shows a compact failure message and relies on existing invalidation/refetch for final state.
- If a child is reparented, archived, deleted, or leaves the runtime status set during resolution, skip it unless the lifecycle stop owner says the stop request is still valid.
- If the server cannot safely scope the manager and same-project child target set, fail the action before issuing any stop requests.
- Bulk stop is intentionally non-atomic. Correctness comes from rechecking each child at dispatch and reporting typed per-child outcomes, not from wrapping fan-out in one transaction.
- This route does not create a new durable bulk lifecycle. The durable lifecycle remains per child thread; lost daemon results, reconnect reconciliation, expired commands, and repeated requests continue to be owned by the existing thread lifecycle module.

### Managed Thread Status

For managed threads, derive the manager ref from cached data:

- Look up `cachedThreads[thread.parentThreadId]` (the existing parent-thread query / cached `ThreadWithRuntime` entry already populated by the sidebar and thread detail view).
- Use the cached `title` and `id`. The fallback if the manager record is unavailable is `thread.parentThreadId` for the link plus a generic "Managed by manager" copy.

Ownership invariants:

- Create/update ownership should continue to use `assertValidManagerParentThread` so `parentThreadId` references only a live manager thread in the same project.
- The view model should silently exclude dirty cross-project refs rather than failing the banner. Include the managed-by notice only when the cached parent exists, is a live manager, and `parent.projectId === thread.projectId`.
- The view-model filter for managed children must be scoped to the target thread's project, so dirty cross-project child refs are not surfaced.

Recommended collapsed text:

- `Managed by <manager title>`
- Link to the manager thread.
- Treat this as high-signal on its own. A managed thread with no git changes and no pending TODOs should still show the banner so the user does not accidentally bypass the manager.

### Pending TODO Extraction Contract

The pending TODO snapshot is computed by the existing timeline projection in `@bb/thread-view`, alongside `activeThinking` and `contextWindowUsage`. There is no separate SQL query, no new indexed event projection, and no separate cache key for TODO state.

Ownership:

- The timeline projection walks decoded events and tracks the latest valid `TodoWrite` tool call and `turn/plan/updated` snapshot.
- The projection produces a typed `ThreadTimelinePendingTodos | null` result; the server timeline route forwards it on `latest` page requests.
- The app receives only the typed contract on the existing timeline response.

Tail-only semantics:

- `pendingTodos` is returned only when the timeline page is `latest`, mirroring `activeThinking`. Older pages return `pendingTodos: null` because the snapshot describes the current head state, not historical state.
- The projection already bounds work via existing timeline construction and pagination; no new candidate-row constant is needed.

Suppression and projection:

- `TodoRead`, `TodoWrite`, and `ToolSearch` remain suppressed from rendered timeline rows. Suppression is a row-rendering decision and does not affect the projection's ability to observe the underlying tool-call events.
- The projection must read TodoWrite event arguments and `turn/plan/updated` events even though their corresponding rows are suppressed.

Parser reuse:

- Replace the existing private `asTodoWriteTodos` parsing path in `packages/thread-view/src/tool-call-parsing.ts` with one canonical exported helper, for example `parseTodoWriteTodos`.
- Back that helper with zod schemas such as `todoWriteArgsSchema` and `todoWriteTodoSchema`.
- Remove the current `toRecord`/`asString` TodoWrite shortcuts as part of the parser extraction. The implementation should not merely wrap or rename defensive parsing that the zod schema should own.
- Keep the helper tolerant at the provider boundary, but return a strongly typed internal result. Invalid entries and invalid statuses should be dropped from the snapshot rather than passed through.
- Update the `formatTodoWriteCommand` caller in the same commit as the parser extraction and delete `asTodoWriteTodos` so no dead parser path remains.
- Keep `ParsedTodoWriteArgs` and `ParsedTodoWriteTodo` internal to `@bb/thread-view`; the app-facing and server-contract shape remains `ThreadTimelinePendingTodos`, which hides completed/failed entries and provider-specific parser details.
- Define a text cap such as `THREAD_TIMELINE_PENDING_TODO_TEXT_MAX_LENGTH = 240`.
- At the parser boundary, trim TODO content and plan-step text, drop items whose text is empty after trim, and truncate accepted text to the cap before returning typed projection data.

Proposed parser shape:

```ts
type ParsedTodoWriteTodo = {
  content: string | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  activeForm: string | null;
};

type ParsedTodoWriteArgs = {
  todos: ParsedTodoWriteTodo[];
};
```

Snapshot selection within the projection:

- The projection tracks the latest valid TODO snapshot as it walks events, comparing by source sequence.
- Convert each parseable `TodoWrite` tool-call argument and each `turn/plan/updated` event into one snapshot candidate. A parsed-empty candidate is valid and represents an observed empty snapshot.
- Pick the newest valid snapshot by sequence. Prefer `TodoWrite` only when it is the newest valid snapshot; do not let an older `TodoWrite` override a newer `turn/plan/updated` snapshot.
- If the newest valid snapshot comes from an interrupted turn, keep it as the latest known state. Interruption does not imply the TODO list is invalid.
- If a `TodoWrite` row is orphaned from a completed turn or has no matching result, still accept it when its arguments parse. The TODO snapshot is the requested list state, not a tool success audit.
- If a candidate fails zod validation or cannot be decoded into the expected source shape, skip that invalid candidate and continue with older candidates seen in the projection's event traversal.
- If a candidate parses successfully but yields no TODO items or no plan steps, stop at that candidate and emit `{ kind: "observed", items: [] }`. This preserves newest-empty semantics and prevents an older `TodoWrite` snapshot from resurrecting stale work.
- If no TODO/plan candidate is observed during the projection's traversal, return `null`; the UI hides the TODO section.
- If candidates exist but every candidate is invalid or unparseable, emit `{ kind: "unparseable", ... }` and log or meter the parse failures; the UI omits the TODO section.
- For `turn/plan/updated`, treat `event.explanation` as source metadata only. Do not include it in the first-pass banner unless Michael signs off on the product question above.

Mapping:

- `TodoWrite.status === "in_progress"` maps to `in_progress`.
- `TodoWrite.status === "pending"` or missing status maps to `pending`.
- Invalid explicit `TodoWrite.status` values are parser-boundary failures for that item and must not surface as `unknown`.
- For `turn/plan/updated`, iterate `event.plan` and map each step independently.
- `step.status === "active"` maps to `in_progress`.
- `step.status === "pending"` or missing status maps to `pending`.
- Completed items are excluded from the banner.
- Failed plan steps should not be included in this first pass unless Michael wants failed work treated as a separate high-signal state.

Empty snapshot semantics:

- A latest valid snapshot with no steps/items, or with only completed or failed items, emits `{ kind: "observed", items: [] }`.
- The UI hides the TODO section for observed-empty snapshots and for `pendingTodos: null`.
- Tests should assert the distinction between `null` (no candidate observed), `unparseable`, and observed-empty.

Stable IDs:

- Since provider TODO items do not carry stable IDs, use a projection-generated ID derived from source kind, source sequence, and item index, such as `seq:<source>:<sourceSeq>:<index>`.

## UI Structure

Introduce a dedicated component and view model rather than growing the current `banner` prop object:

- `apps/app/src/components/thread/ThreadPromptContextBanner.tsx`
- `apps/app/src/views/threadPromptContextBannerModel.ts`
- Tests alongside the component and helper.

Use existing primitives:

- `StatusPill` from `@bb/ui-core`
- `CollapsibleHeader` or `ExpandablePanel` from `@bb/ui-core`
- `Button`, `Link`, `WorkspaceChangesList`, `MergeBaseBranchPicker`
- Lucide icons for section affordances.

UI consistency constraints:

- Use sanctioned typography utilities already present in nearby components, such as `text-xs`, `text-sm`, and muted foreground tokens.
- Do not introduce arbitrary `text-[Npx]` classes.
- Keep one canonical rendering path for prompt context by the end of the migration.
- Extend `ExpandablePanel` or `CollapsibleHeader` in `@bb/ui-core` if needed to satisfy the accessibility contract below. Do not create a banner-local disclosure primitive or a parallel class bundle for expansion behavior.
- Do not nest UI cards inside the banner.

Banner layout:

- Single rounded strip above queued follow-ups and the prompt box.
- Sections render as compact rows within the same strip:
  - Managed ownership or manager work summary.
  - Git/workspace summary.
  - TODO summary.
- Expanded content appears inside the same strip below its summary row.
- Preserve the current changed-file expansion behavior, but route it through the new banner model.

Recommended section order:

1. Management context: shown managed work or managed-by notice.
2. Git context: workspace or branch state.
3. TODO context: pending work from the latest TODO snapshot.

Collapsed TODO behavior:

- Default collapsed on thread load.
- Summary examples:
  - `3 TODOs - 1 in progress, 2 pending`
  - `TODO in progress: Update prompt banner model`
- Expanded list shows each pending or in-progress item with a small status pill.
- Expansion state should be local component state keyed by `thread.id`; do not persist until there is evidence users need persistence.
- Expanded TODO list max height should be quantified, for example `max-h-32`, then scroll.

Git expanded behavior:

- Keep file list collapsed by default when a file list exists.
- Clean ahead/behind/diverged states have no file-list expansion unless `mergeBase.files.length > 0`.
- Git summary remains clickable to open the diff panel when `canUseGitUi` is true.
- The merge-base picker stays in the git row when branch comparison is available.

Managed work expanded behavior:

- Collapsed summary: `Waiting on 3 managed threads`.
- When `items.length > 0`, show a `Stop all` button next to the collapsed summary or in the same manager-control row.
- Expanded list rows link to child threads and show title, runtime display status, and pending-approval marker when present.
- Expanded managed-thread list max height should be quantified, for example `max-h-40`, then scroll.

## Transition From Current Banner

Replace the current git banner in small implementation steps after sign-off:

1. Add `ThreadPromptContextBannerModel` and build only the current git section from existing props/data.
2. Replace `ComposerBannerProps` with a new cohesive `promptContextBanner` prop while keeping visual parity for the existing git banner.
3. Replace `isChangeListExpanded` with section expansion state keyed by section:
   - `gitFiles`
   - `managedThreads`
   - `todos`
4. Map the current changed-file toggle to `gitFiles`.
5. Add manager and TODO sections to the same component after git parity is covered by tests.
6. Delete the old git-only banner branch and old `ComposerBannerProps` path once parity and new states pass.

End state:

- `ThreadFollowUpComposer.tsx` has one canonical context-banner render path.
- Git, manager, managed-by, and TODO rows are sections in `ThreadPromptContextBanner`.
- The old `banner.showPromptGitStatsBanner` branch no longer exists.

## Loading, Error, And Empty States

Overall banner:

- Hide the entire banner when there are no high-signal sections and no durable error.
- Do not reserve empty vertical space.

Git:

- If cached workspace status exists, keep showing it during refetch.
- If no cached status exists and status is loading, omit the git section unless another section is already rendering, then show compact `Checking workspace...`.
- If the workspace was deleted, show `Workspace deleted`.
- For transient status failures, prefer a compact unavailable state over a toast.

Pending TODOs:

- TODO snapshot lives on the existing timeline query; cached timeline data already powers the rest of the UI.
- If the timeline page is not `latest` (older-page view), the TODO section is hidden because `pendingTodos` is null.
- If the timeline query fails or has no cached data, omit the TODO section. Do not show a separate TODO loading state.

Manager and managed-children context (cached lookups):

- Manager ref is read from cached parent-thread records; managed children are filtered from the cached project thread list.
- If the cached parent record is unavailable but `thread.parentThreadId` is known, render a fallback managed-by notice using the manager id.
- If the cached project thread list is unavailable, omit the manager active-children section. The managed-by notice can still render from `thread.parentThreadId`.
- Do not show a `Checking manager...` loading state; the cached data is loaded with the rest of the page.

Empty states:

- Regular clean up-to-date unmanaged thread with no pending TODOs: no banner.
- Manager thread with no shown managed work and no pending TODOs: no banner.
- Managed thread with no other context: show the managed-by notice because managed ownership is itself high-signal.
- Latest TODO source exists but no pending or in-progress items: no TODO section.

## Accessibility

- Wrap the banner in a `section` with `aria-label="Thread context before sending"`.
- Use real buttons for expandable sections with `aria-expanded` and `aria-controls`.
- Expanded bodies should be named regions, for example `role="region"` with `aria-labelledby` pointing to the section button.
- Do not put click handlers on non-interactive parent divs for primary actions.
- Keep links to manager and managed child threads keyboard-focusable.
- Expanded TODO and managed-thread lists should have clear list semantics.
- Status-only icons must have text labels or `aria-hidden`.
- The banner must remain usable at narrow widths:
  - Truncate thread titles and paths.
  - Keep action buttons from shrinking below their icon target.
  - Move secondary metadata to the next line rather than overlapping.

## App Implications

Add app API and hooks:

- `api.bulkStopManagerManagedChildren(managerThreadId)` plus a mutation hook for the bulk-stop action route.
- Pending TODOs reuse the existing timeline query; no new hook is needed for that lane.
- Manager ref and managed children come from the cached project thread list and the existing parent-thread query; no new read query is needed.

Refactor app composition:

- `ThreadDetailView.tsx` should build a `ThreadPromptContextBannerModel` from:
  - `thread`
  - `workspaceStatus`
  - `workspaceStatusError`
  - `workspaceChangedFilesSection`
  - `showBranchComparisonUi`
  - `effectiveMergeBaseBranch`
  - `threadTimeline.pendingTodos` (from existing timeline query)
  - cached project thread list (existing query) for managed children
  - cached parent thread (existing query) for manager ref
  - relevant loading/error flags
- `ThreadDetailPromptArea.tsx` should own only local section expansion state and pass a cohesive context-banner prop.
- `ThreadFollowUpComposer.tsx` should render `ThreadPromptContextBanner` above `QueuedFollowUpList`.

## Realtime Invalidation Plan

The first-pass design adds no new query keys for the banner. Each lane invalidates through its existing path.

Pending TODO invalidations:

- TODOs are returned on the existing timeline response. The existing timeline cache already invalidates on `events-appended`, which is exactly when TODO snapshots can change. No additional plumbing.

Manager ref and managed-children invalidations:

- The banner reads from the cached project thread list and the cached parent-thread record. Both are already invalidated by existing realtime cache effects on:
  - `status-changed`
  - `interactions-changed`
  - `title-changed`
  - `archived-changed`
  - `thread-created`, `thread-deleted`, project `threads-changed`
- A child status change refreshes the project thread list, which the manager's banner reads from; no manual parent-targeted invalidation is required.
- A manager title/archive/delete change refreshes the cached manager record and the project list, which the managed child's banner reads from; no manual child-targeted invalidation is required.
- Reparenting events also flow through existing project thread-list invalidation, so old- and new-parent banners both refresh.

Verify before implementation:

- Confirm that cached `ThreadListEntry` records actually update on `status-changed`/`interactions-changed`/`title-changed`/`archived-changed` for the affected thread. If the existing realtime cache effects only update `ThreadWithRuntime` for the active detail view and not the project list, add the missing project-list invalidations as part of slice 3. The banner correctness depends on the project list being live.
- Confirm that cached parent-thread records (`ThreadWithRuntime` for `thread.parentThreadId`) update on the manager's `title-changed`/`archived-changed`. If the parent-thread query has its own key not invalidated by manager updates, fix that in the same slice.

Omitted invalidations:

- No new query key for the banner, so there is nothing to invalidate on `queue-changed` or `read-state-changed`.

## API And CLI Implications

API:

- Extend the existing thread timeline route response to include `pendingTodos: ThreadTimelinePendingTodos | null` on `latest` page requests, alongside `activeThinking`. Document the new field in `packages/server-contract/src/public-api.ts`.
- Add `POST /api/v1/threads/:id/managed-children/stop` for manager `Stop all`. Document it in `packages/server-contract/src/public-api.ts`.
- The bulk-stop route resolves the manager with `requirePublicThread`, then requires `requirePublicProject(managerThread.projectId)`, asserts the manager type, and enforces same-project child targeting in SQL before fan-out.
- The bulk-stop route response uses `ThreadManagerBulkStopResponse` with typed per-child outcomes and aggregate counts, rather than a single ambiguous success boolean.
- Tighten existing `GET /api/v1/threads/:id` in the same backend slice to require `requirePublicProject(thread.projectId)` after `requirePublicThread`. Today the route returns threads whose project is pending-delete; matching the bulk-stop route's lifecycle gating closes that inconsistency.
- No new GET route is added for the banner. Manager and managed-child data come from the existing project thread list and parent-thread queries.

CLI:

- No required CLI change for the first implementation.
- Existing `bb status` and `bb manager` commands already show basic parent/managed thread information.
- Future CLI enhancement could use the timeline route's `pendingTodos` field, but that is a separate product decision.

## Implementation Slices After Sign-Off

1. Timeline projection: pending TODOs
   - Add `ThreadTimelinePendingTodos` and `ThreadTimelinePendingTodoItem` domain schemas/types.
   - Replace the existing `asTodoWriteTodos` TodoWrite parser with a canonical exported zod-backed `parseTodoWriteTodos` and update existing call sites in the same commit.
   - Extend the timeline projection (`@bb/thread-view`) to track the latest valid TODO snapshot and emit `pendingTodos` on `ThreadTimelineFromEventsResult`.
   - Extend `threadTimelineResponseSchema` and the server timeline service to forward `pendingTodos` on `latest` page requests; older pages return `null`.
   - Add projection tests for: no candidate observed (`null`), only `TodoWrite` snapshots (newest wins), only `turn/plan/updated` snapshots (newest wins), mixed `TodoWrite` and `turn/plan/updated` (newest by sequence wins), unparseable candidates, observed-empty snapshots, interrupted-turn snapshots, orphaned `TodoWrite` snapshots, completed-only items, suppressed tool-call rows still observed by projection.

2. Bulk-stop action route
   - Add `ThreadManagerBulkStopResponse`, `ThreadManagerBulkStopChildResult`, and their outcome/reason enums to domain/server-contract schemas.
   - Add `POST /api/v1/threads/:id/managed-children/stop` route and service.
   - Resolve target children in SQL by `parentThreadId`, `projectId`, non-archived, and the same `runtimeDisplayStatus` set the UI uses.
   - Per-child: load environment, call `requestThreadStopIfNeeded`, emit typed outcome.
   - Tighten existing `GET /api/v1/threads/:id` to require `requirePublicProject` after `requirePublicThread` in the same slice.
   - Add server action tests: lifecycle gating (deleted thread, pending-delete project), no eligible children, one child, multiple children, per-child missing/unusable environment skips, mixed eligible/idle/archived/cross-project children, partial failure, repeated clicks, children deleted or reparented during resolution, already-stopping children.
   - Tests use in-memory SQLite with `createConnection(":memory:")` plus `migrate(db)`.

3. Project thread-list cache invalidation parity
   - Verify that cached `ThreadListEntry` records and cached parent-thread records refresh on `status-changed`, `interactions-changed`, `title-changed`, `archived-changed`, `thread-created`, `thread-deleted`, and project `threads-changed`.
   - Add any missing invalidations needed for the banner to reflect realtime manager/managed-child changes without a banner-specific cache key.
   - Add tests for: child status change refreshing manager banner, manager title change refreshing managed-child banner, child reparenting refreshing both old and new parent banners, child deletion refreshing manager banner.

4. Banner view model and component
   - Add `ThreadPromptContextBannerModel` and `ThreadPromptContextBanner`.
   - Define published view-model constants: `THREAD_BANNER_ACTIVE_MANAGED_RUNTIME_STATUSES`, `THREAD_BANNER_ACTIVE_MANAGED_LIMIT`.
   - Derive manager ref from cached parent thread and managed children from cached project thread list.
   - Extend and reuse `ExpandablePanel` or `CollapsibleHeader` so expandable banner sections get `aria-controls`, named regions, and `aria-labelledby` without adding a banner-local disclosure primitive.
   - Move current git banner behavior into the new component first.
   - Add collapsed TODO and managed-work expansion states.
   - Add the manager `Stop all` affordance near the managed-thread summary, gated by `items.length > 0`.
   - Add confirmation for multiple stop targets.
   - Add UI behavior for bulk-stop partial failure/retry states without directly mutating child status.
   - Preserve diff-panel and merge-base picker behavior.
   - Add view-model and component tests for all numbered scenarios in the exit criteria.

5. Thread detail integration
   - Replace the current git-only banner prop shape in `ThreadDetailView`, `ThreadDetailPromptArea`, and `ThreadFollowUpComposer`.
   - Wire `pendingTodos` from the existing timeline query, cached parent thread, and cached project thread list into the banner view model.
   - Replace `isChangeListExpanded` with section expansion state.
   - Keep queued follow-ups and `PromptBox` behavior unchanged.
   - Remove the old banner render branch once the new path covers git parity and new context sections.

6. Verification and polish
   - Run Turbo validation.
   - Run the app locally and verify with desktop and mobile viewport checks.
   - Confirm typography uses existing tokens and no arbitrary `text-[Npx]` classes.

## Exit Criteria

Planning exit criteria:

1. This plan is committed under `plans/`.
2. Michael reviews the open product decisions and signs off before implementation begins.

Implementation exit criteria after sign-off:

1. Given a standard thread with `workspaceStatus.workingTree.state === "dirty_uncommitted"` and changed files, the banner shows a Dirty git summary, the git file section is collapsed by default, expansion reveals the changed files, and clicking a file opens the diff panel.
2. Given a standard thread with `workspaceStatus.workingTree.state === "untracked"` and untracked files, the banner shows an Untracked git summary and expandable files.
3. Given a standard thread with `workspaceStatus.workingTree.state === "committed_unmerged"` and `mergeBase.files.length > 0`, the banner shows committed-unmerged git context and expandable committed files.
4. Given a standard thread with `workingTree.state === "clean"`, `mergeBase.aheadCount > 0`, and `mergeBase.behindCount === 0`, the banner shows an Ahead git summary even when no files are listed.
5. Given a standard thread with `workingTree.state === "clean"`, `mergeBase.aheadCount === 0`, and `mergeBase.behindCount > 0`, the banner shows a Behind git summary even when no files are listed.
6. Given a standard thread with `workingTree.state === "clean"`, `mergeBase.aheadCount > 0`, and `mergeBase.behindCount > 0`, the banner shows a Diverged git summary.
7. Given a standard unmanaged thread with clean up-to-date workspace status, `pendingTodos === null` from the timeline, and no managed ownership, the banner is hidden.
8. Given a standard unmanaged thread with clean up-to-date workspace status, `pendingTodos.kind === "unparseable"` from the timeline projection, and no managed ownership, the banner is hidden and the server log/metric records the unparseable candidates.
9. Given a standard unmanaged thread with clean up-to-date workspace status, observed-empty TODOs from the timeline projection, and no managed ownership, the banner is hidden.
10. Given a manager thread with child threads whose `runtimeDisplayStatus` is in the active set (`active`, `host-reconnecting`, `waiting-for-host`), the banner shows the managed-thread count and expansion reveals child links, statuses, and pending-approval markers.
11. Given a manager thread whose only children have `runtimeDisplayStatus` outside the active set (e.g. `idle`, `error`, `created`, `provisioning`, `archived`), the managed-work section is hidden and no `Stop all` button is shown.
12. Given a manager thread with exactly one child in the active set, the banner shows `Stop all` near the managed-thread summary and invokes lifecycle stop semantics for that child without client-side status mutation.
13. Given a manager thread with multiple children in the active set, `Stop all` requires confirmation that states how many managed threads will be stopped.
14. Given a manager thread with mixed children (some in the active set, some idle, archived, errored, or dirty cross-project), `Stop all` targets only same-project children in the active set, and the visible list shows exactly the targets.
15. Given the bulk-stop route is called repeatedly while children are already stopping, the route remains idempotent and returns typed per-child outcomes.
16. Given a bulk-stop request where a child has no usable environment, the route skips that child with `missingEnvironment` or `environmentUnavailable` and continues handling other children.
17. Given a bulk-stop request where one child fails, is deleted, archived, or reparented during resolution, the route reports partial outcomes and does not mutate any child status directly.
18. Given children leave the active runtime set (complete, stop, error, become idle), the banner updates so the count and `Stop all` visibility reflect the latest state via existing project thread-list invalidation.
19. Given the unfiltered match count exceeds the soft cap (e.g. > 20), the collapsed summary uses the true count and the expanded list shows a truncation note such as `Showing 20 of 37`.
20. Given a managed thread with a cached parent thread record present, the banner shows a managed-by notice with a link to the manager even when no git or TODO sections render.
22. Given a latest `turn/plan/updated` snapshot with `plan: []`, the timeline projection emits `pendingTodos.kind === "observed"` with `items: []` and does not select an older `TodoWrite`.
23. Given a latest valid `turn/plan/updated` snapshot and an older valid `TodoWrite`, the timeline projection selects the newer plan snapshot.
24. Given an interrupted turn has the newest valid TODO or plan snapshot, the timeline projection keeps it as the latest known TODO state.
25. Given an orphaned `TodoWrite` row has parseable arguments, the timeline projection accepts it as a TODO snapshot even without a matching successful tool result.
26. Given the timeline page is `older`, the response returns `pendingTodos: null`, mirroring `activeThinking` tail-only semantics.
27. Given a non-`TodoWrite` tool-call event appears in the projection's event traversal, the projection ignores it for TODO snapshot selection and does not emit a snapshot from it.
28. Given `pendingTodos.kind === "observed"` with one in-progress item and two pending items, the banner shows a collapsed TODO summary with those counts.
29. Given the TODO section is expanded, the UI renders a list of pending/in-progress TODO items with status labels and no completed items.
30. Given `pendingTodos.kind === "observed"` with `items: []`, the TODO section is hidden.
31. Given no TODO/plan candidate is observed during the timeline projection's event traversal, the timeline response returns `pendingTodos: null` and the UI omits the TODO section.
32. Given TODO/plan candidates are observed during the projection's traversal but every candidate is invalid or unparseable, the projection emits `pendingTodos.kind === "unparseable"`, logs or meters the condition, and the UI omits the TODO section.
33. Given any expandable section, the toggle is a button with `aria-expanded`, `aria-controls`, and an associated region.
34. Given mobile-width viewport checks, banner text truncates or wraps without overlapping the prompt box, queued follow-ups, manager `Stop all` button, or footer controls.
35. Given a thread whose project is pending-delete, existing `GET /api/v1/threads/:id` rejects after `requirePublicProject(thread.projectId)` (lifecycle gating tightened in the same slice as the bulk-stop route).
36. Given a manager thread whose project is pending-delete, the bulk-stop route rejects before resolving or stopping child threads.
37. Given a managed child changes `runtimeDisplayStatus`, the manager's banner refreshes via existing project thread-list invalidation, without a banner-specific cache key.
38. Given a manager title changes, cached managed-child banners refresh via existing parent-thread or project list invalidation.
39. Given a manager is archived or deleted, cached managed-child banners refresh via existing realtime cache effects so child banners do not retain stale manager links.
40. Given a managed child is reparented, both the old and new parent banners refresh via existing project thread-list invalidation.
41. Given a managed child is deleted, the manager's banner refreshes via existing project thread-list invalidation and no longer shows the deleted child.
42. Given an `events-appended` change on a thread, the timeline query (which carries `pendingTodos`) is invalidated through its existing path. No banner-specific cache key exists.
43. The implementation uses shared contracts and existing UI primitives, the old git-only banner render path is removed, and no new GET route is added for the banner.
44. Turbo typecheck and targeted tests pass.

## Validation Instructions After Implementation

Run targeted checks with Turbo:

```sh
pnpm exec turbo run typecheck --filter=@bb/domain
pnpm exec turbo run typecheck --filter=@bb/thread-view
pnpm exec turbo run typecheck --filter=@bb/server-contract
pnpm exec turbo run typecheck --filter=@bb/server
pnpm exec turbo run typecheck --filter=@bb/app
pnpm exec turbo run test --filter=@bb/thread-view
pnpm exec turbo run test --filter=@bb/server
pnpm exec turbo run test --filter=@bb/app
```

Manual app scenarios:

- Standard thread with uncommitted files: banner shows git summary, file list expands, file click opens diff panel.
- Standard thread clean but ahead/behind/diverged: banner shows branch comparison summary.
- Standard clean up-to-date thread: banner is hidden unless TODOs or managed-by context exist.
- Manager thread with at least one child in the active runtime set: managed-work section renders, count matches the visible children, `Stop all` is shown.
- Manager thread with no children in the active runtime set: managed-work section is hidden and no `Stop all` button is shown.
- Manager thread with one active child: `Stop all` activates lifecycle stop semantics for that child.
- Manager thread with multiple active children: `Stop all` shows confirmation before stopping.
- Manager thread with mixed children (active, idle, errored, archived, cross-project): the visible list and `Stop all` target only same-project active children; the count matches what the user sees.
- Bulk stop with a child missing a usable environment: response reports a skipped child and still reports other child outcomes.
- Manager thread with more active children than the cap: summary uses true count, expanded list shows capped rows and a truncation note.
- Manager thread after children complete or stop: banner refreshes via project thread-list invalidation and hides `Stop all` when no active children remain.
- Managed thread: banner shows managed-by notice and links to manager.
- Any thread with pending TODOs: TODO section is collapsed by default and expands with keyboard and pointer.
- TODO snapshot with all completed items: TODO section is hidden.
- TODO snapshot where the latest valid candidate is empty: TODO section is hidden and older snapshots do not reappear.
- TODO candidates present but unparseable: TODO section is omitted and the server log/metric is observable.
- Non-`TodoWrite` tool-call events: timeline projection ignores them for TODO snapshot selection.
- Older timeline page: `pendingTodos` is null and the TODO section is hidden.
- Existing `GET /api/v1/threads/:id`: rejects threads whose project is pending-delete (lifecycle gating tightened to match the bulk-stop route).
- Managed child banner after manager title/archive/delete: refreshes via existing parent-thread or project-list invalidation.
- Managed child reparenting: both old and new parent banners refresh via existing project thread-list invalidation.
- Workspace status loading/error/deleted states do not block sending a follow-up.
- Cached parent-thread record unavailable: managed-by fallback still renders when `thread.parentThreadId` is known.
- Mobile viewport: banner rows wrap or truncate without overlapping the prompt box.

## AGENTS.md Review Notes

- Plan only: no UI or code implementation before sign-off.
- Contracts should live in shared packages, not inline function signatures.
- Provider TODO data must be parsed at the timeline projection boundary and not leak `unknown` into app code.
- Reuse the existing project thread list and parent-thread queries for manager/managed-child data; do not add a parallel server route for what the sidebar already loads.
- Pending TODOs are tail-only timeline projection state, computed alongside `activeThinking`. Do not introduce a separate SQL query, indexed event projection, or candidate-row constant for TODO extraction.
- One predicate, not two: the visible managed-children set and the `Stop all` target set are the same, derived from `runtimeDisplayStatus`. No `stoppableCount` field.
- The bulk-stop action route applies lifecycle gating (`requirePublicThread` + `requirePublicProject`) and reuses the existing per-child lifecycle stop owner. It does not mutate child status directly.
- Tighten existing `GET /api/v1/threads/:id` to also call `requirePublicProject` in the same backend slice, so both routes refuse to operate on threads whose project is pending-delete.
- Replace/reuse the existing `asTodoWriteTodos` parsing path instead of duplicating it, and remove the old helper once the zod-backed parser is canonical.
- Reuse `StatusPill`, `CollapsibleHeader` or `ExpandablePanel`, `WorkspaceChangesList`, `MergeBaseBranchPicker`, `Button`, and existing layout conventions.
- Use sanctioned typography utilities; do not add arbitrary `text-[Npx]` classes.
- Use Turbo for typecheck and tests.
- Do not add route/query fields unless implemented end to end.
