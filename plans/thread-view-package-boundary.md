# Thread View Salvage Plan

## Goal

Keep the useful work already on `main`, salvage the good architecture from
`backup/timeline-attempt-1`, and end with one timeline rendering path:

```text
ThreadEventWithMeta[]
  -> ThreadTimelineProjection
  -> ThreadTimeline
  -> server response | CLI text | provider audit | React
```

`ThreadTimelineProjection` is flat source facts plus projection state. It does
not contain grouping. `ThreadTimeline` is the grouped semantic tree consumed by
the API response and renderers. "Semantic" means source/lifecycle semantics,
not display-only labels: a row keeps the provider item that owns status,
approval, output, duration, and identity.

## Current Status

The committed baseline now has the semantic row contract in
`@bb/server-contract`, the `@bb/thread-view` timeline builder, the server
timeline response, CLI formatting, and provider-audit replay snapshots on
semantic rows.

Two important pieces are intentionally still unfinished:

- `@bb/thread-view` still uses the old `ViewMessage`/`ViewProjection` projector
  internally before converting to semantic rows. That compatibility layer should
  be replaced by a direct `ThreadEventWithMeta[] -> ThreadTimelineProjection`
  projector, but it is not a React-renderer prerequisite.
- React still renders through the current app/UI path. Do not start the React
  renderer cutover until `plans/ui-core-design-system.md` has been completed.

Non-React cleanup is allowed before the React cutover when it removes dead code,
fixes stale package boundaries, or makes audit/server/CLI behavior clearer.

## Package Boundaries

- `@bb/domain` owns durable domain facts only: persisted event schemas,
  durable resource types, and domain enums. It must not receive timeline
  presentation helpers, environment display formatting, pending-interaction
  copy, error extraction helpers, or generic UI utilities.
- `@bb/server-contract` owns API wire schemas and API response/request types.
  The semantic `ThreadTimelineRow` wire schema lives here.
- `@bb/thread-view` owns timeline projection, grouping, timeline labels, and
  CLI/audit text formatting. It may import `@bb/server-contract` timeline row
  types because it produces that API shape. `@bb/server-contract` must not
  import `@bb/thread-view`. Its public API is intentionally small; helpers stay
  module-private unless app, CLI, audit, and tests all need the same stable
  behavior.
- `@bb/ui-core` owns React primitives and the generic React timeline renderer.
  It renders semantic rows; it does not define timeline facts. It may use
  `@bb/thread-view` label helpers, but row facts come from
  `@bb/server-contract`.
- `@bb/core-ui` is not a final package. It is deleted after timeline consumers
  are cut over. Its non-thread helpers are inlined or moved to concrete
  existing consumers, never to `@bb/domain` by default.

## Public API Budget

`@bb/thread-view` root exports are limited to the stable timeline pipeline:

- `projectThreadTimeline(events, options)`
- `buildThreadTimeline(projection, options)`
- `formatThreadTimelineText(timeline, options)`
- stable public timeline types that consumers need to compile

Everything else is internal by default. Helpers such as shell-tool detection,
file-name summaries, activity label builders, duration formatting, latest
activity helpers, and bundle summaries are not public exports just because a
second caller appears. If app, CLI, and audit must share wording, that wording
is reached through the single row title/text formatter, not by exporting
another small helper. One-off helpers are inlined or kept private.

## Locked Decisions

- Do not reset to the abandoned branch. Port ideas, not commits.
- Do not add a public presentation DSL. The semantic row tree is the shared
  model. React owns layout and truncation.
- `ThreadTimelineResponse.rows` is the grouped semantic row tree.
- `activeThinking` and `contextWindowUsage` stay outside rows on the response.
- User inputs, including steers, are conversation rows in the projection. They
  are not kept in side-channel projection state and are never ordered with
  sentinel sequence values.
- File changes project as one source/work row per element in the provider
  `changes[]` array. If the same file appears multiple times in one event,
  each array element remains a separate row with its own diff and stats.
- Source work rows preserve the provider item that owns lifecycle state. Parsed
  exploration activity such as read/search/list is a capability of a command or
  tool row; it must not replace the source row when that would erase command
  identity, output, duration, or approval state.
- Approval state lives on the concrete source row when there is one. Approval
  lifecycles without a concrete source row, such as permission grants and
  file-change approvals before concrete changes are known, project as
  structured approval work rows. They must carry the approval subject; no fake
  file paths, fake commands, or label-only rows.
- Approval-only rows are reconciled by source identity. If a later concrete
  command/tool/file-change row for the same item appears, the concrete row owns
  the lifecycle and the approval-only row does not remain as a duplicate.
- Pending command approvals remain command rows even when the command parses as
  exploration. Pending `rg X` is a command with a search intent, not a bare
  search row.
- Tasks/todo/plan updates are removed from the timeline. Any remaining
  `TasksRow`/`ViewTasksMessage` timeline code is dead unless a real producer is
  reintroduced end to end.
- Delegation child progress is represented by child timeline rows. Delegation
  rows do not invent a second primary output surface. If provider output needs
  to be visible, it is represented as child rows, not as an extra delegation
  body competing with child progress.
- Delegation children are inline for now so active progress streams naturally.
  Lazy loading is only for completed turn rows.
- Completed turns are represented as turn rows. Top-level completed turn
  children may be `null` and fetched through a turn-details route keyed by the
  turn row/turn id. Source sequence fields are ordering/debug facts, not the
  public identity for lazy loading.
- Active turns are not wrapped in a lazy turn row. Active-tail grouping is
  derived from the current active scope and row position.
- Grouping never crosses conversation/system/approval boundaries.
- Group rows are active-run groups only. They are allowed only in active scopes,
  only for consecutive non-terminal work rows, and only when there is more than
  one row to summarize.
- Only grouped tail activity in an active scope gets ongoing labels such as
  `Exploring`, `Editing`, or `Running N commands`. Regular rows use their own
  pending/completed/error/interrupted status.
- The same active-tail rule applies inside delegation child timelines, using
  the delegation row status as the enclosing active scope.
- Latest-activity helpers are UI-local containment/highlight helpers only. They
  are not API state and they do not decide active tense.
- Optimistic composer rows are app-local rows passed separately or adapted at
  the app boundary. They must not be inserted into the API response cache as
  server rows with fake source sequence numbers.
- Existing useful fixture/audit coverage stays. Deleted row tests must be
  replaced by behavior tests that catch the same regressions.
- Delete-first rule: if a helper, row type, component, status conversion, or
  compatibility adapter cannot be justified by the final semantic pipeline, it
  is deleted instead of carried forward. `isShellToolName` is not part of the
  final public API; if shell detection is still needed for legacy provider
  events during projection, it stays private to that parser and disappears once
  providers emit explicit command/tool events.

## Salvage From Main

- Provider audit fixture readability and dev replay captures.
- CLI snapshot coverage and provider-audit artifacts.
- File-change splitting work.
- Delegation semantic projection and child progress work.
- Command/delegation projection cleanup.
- The `@bb/thread-view` package boundary and Turbo wiring.

## Salvage From Abandoned Branch

- Semantic row contract shape:
  conversation rows, work rows, system rows, group rows, and turn rows.
- Flat source projection before grouping.
- Turn rows with lazy `children: null` for completed top-level turns.
- One generic React renderer that switches on semantic row kind.
- Work details for commands, file diffs, generic tools, and delegation
  children.
- The idea of grouping work rows after projection, but not its
  read/search/list-as-source-row implementation.

## Reject From Abandoned Branch

- Timeline ownership in `@bb/core-ui`.
- Broad test deletion without equivalent behavior coverage.
- Presentation DSL as public API.
- Caller-controlled truncation flags in model data.
- Replacing approval-owning command/tool rows with bare read/search/list rows.
- Step-summary or semantic-bundle rows that compact completed history outside
  turn rows.
- Synthetic file-change rows that use `callId` or placeholder text as `path`.
- `Number.MAX_SAFE_INTEGER` or similar sentinel ordering.
- Unrelated DB/app/server churn mixed into the timeline rewrite.
- Grouping rules that exclude delegations or contradict active-tail behavior.

## Target Row Model

The API row schema is explicit and semantic:

- `conversation`: user or assistant text, attachments, accepted/pending steer
  metadata when applicable.
- `work`: one visible unit of source work with `workKind`.
  Supported work kinds: `command`, `tool`, `file-change`, `web-search`,
  `web-fetch`, `delegation`, `approval`.
  Command and tool rows may carry derived `activityIntents` such as
  `read`, `search`, `list`, or `unknown`. Renderers and grouping use those
  intents for labels like `Searched packages`, but the row remains the command
  or tool that owns output, duration, terminal treatment, and approval state.
  Activity intents are not rows; they carry the parsed command string plus
  structured fields such as `path`, `query`, and `name`.
  Command rows carry `callId`, `command`, `cwd`, `output`, `exitCode`,
  `durationMs`, `approvalStatus`, and `activityIntents`.
  Tool rows carry `callId`, `toolName`, `toolArgs`, `output`, `durationMs`,
  `approvalStatus`, and `activityIntents`.
  File-change rows represent concrete change entries and carry `callId`,
  `changeIndex`, `path`, `movePath`, `changeKind`, `diff`, `diffStats`,
  `stdout`, `stderr`, and `approvalStatus`.
  Web rows carry the result text/details needed to render the body, not just
  the query or URL.
  Delegation rows carry `callId`, `toolName`, `subagentType`, `description`,
  `durationMs`, and `childRows`.
  Approval rows carry structured approval subject data for permission grants or
  pre-change file approvals; they do not carry pre-rendered titles as their
  only useful data.
- `system`: operation, error, or debug rows.
- `group`: active-run grouped work rows only. Group rows summarize children;
  they do not erase child facts. Supported activity kinds are `exploration`,
  `commands`, `delegations`, `file-changes`, and `web-research`.
- `turn`: completed turn container. Children are either inline or `null` when
  deferred.

Projection output:

```text
ThreadTimelineProjection = {
  rows: ThreadTimelineSourceRow[];
  turns: ThreadTimelineProjectedTurn[];
  state: {
    activeThinking: ActiveThinking | null;
  };
}
```

Grouped output:

```text
ThreadTimeline = {
  rows: ThreadTimelineRow[];
  state: ThreadTimelineProjection["state"];
}
```

## Simplified Grouping Algorithm

Grouping is a small deterministic pass over already-projected source rows:

1. Sort rows by real source order.
2. Partition completed turns into `turn` rows. Active turns remain inline.
3. Leave conversation, system, and approval rows as hard boundaries.
4. For each active scope, inspect only the trailing consecutive non-terminal
   work rows.
5. If that trailing run has more than one row and shares one activity family,
   wrap it in one `group`; otherwise leave rows ungrouped.
6. Apply the same rule recursively inside active delegation child rows.

There is no recursive grouping zoo, no completed-history work bundles, no
step-summary layer, no hidden sentinel ordering, and no active-tense decision
based on latest-activity highlighting.

## Deletion And Edge-Case Audit

Before implementation work continues, audit the current timeline code and mark
each item as keep, replace, or delete. The default answer is delete unless it
protects a real behavior in the final model.

Items that must be explicitly justified or removed:

- shell/tool classification helpers such as `isShellToolName`
- latest-activity and ongoing-label helpers
- nested timeline row controllers and lazy-loading adapters
- ID namespacing helpers for delegation children
- `ViewMessage`/`ViewProjection` compatibility layers
- task/todo/plan timeline rows and formatters
- synthetic file-change rows
- status/display-status conversion ladders
- package root exports that are not part of the public API budget

## Implementation Order

0. Do the deletion and edge-case audit.
   - Produce a short keep/replace/delete list in this plan before changing
     production code.
   - Remove immediately dead timeline exports/components that have no producer
     or final-model role.
   - Identify compatibility helpers that may exist only inside the projector
     while consumers are being cut over.

1. Add the semantic contract.
   - Define `ThreadTimelineRow` schemas/types in `@bb/server-contract`.
   - Stop importing old `timelineRowSchema` from `@bb/domain` in the API
     contract.
   - Add the `@bb/thread-view -> @bb/server-contract` dependency and update
     package exports intentionally.
   - Do not add schema-only contract tests. Validation for the contract comes
     from behavior tests in the projector, server route, CLI text, provider
     audit, and React renderer.

2. Build the semantic projector in `@bb/thread-view`.
   - Add `projectThreadTimeline(events, options): ThreadTimelineProjection`.
   - Source rows are flat and ungrouped.
   - Project directly from `ThreadEventWithMeta[]`; do not build the new model
     by first producing old `ViewMessage`/`ViewProjection` rows.
   - Use current `main` work for file-change splitting and delegation child
     projection.
   - Preserve command/tool rows even when their parsed intents are purely
     exploration. Do not project approval-owning shell commands into bare
     search/read/list rows.
   - Preserve server timeline compaction of excessive assistant deltas.
   - Keep current regression tests that prove boundaries, ordering, approvals,
     interrupted turns, user steers, manager filtering, and nested delegation
     behavior.

3. Build semantic grouping in `@bb/thread-view`.
   - Add `buildThreadTimeline(projection, options): ThreadTimeline`.
   - Implement completed turn rows and lazy top-level turn children.
   - Implement active-run groups for exploration, commands, delegations, file
     changes/editing, and web research.
   - Do not group completed history except by completed turn rows.
   - Prove grouping does not cross assistant/user/system boundaries.
   - Prove grouping does not cross approval rows.
   - Prove nested delegation active-tail grouping uses delegation status as
     active scope.

4. Move server timeline routes to the semantic pipeline.
   - `GET /threads/:id/timeline` returns semantic `ThreadTimelineResponse`.
   - Replace the source-sequence turn-summary details contract with a turn-row
     or turn-id keyed details contract.
   - Turn-details route returns semantic child rows for the requested turn.
   - Preserve `activeThinking` and `contextWindowUsage` response fields.
   - Manager-thread filtering remains server policy, not renderer policy.
   - Preserve accepted-input lookup for steers when loading turn details.

5. Move CLI and provider audit to semantic rows.
   - `formatThreadTimelineText` formats `ThreadTimelineRow[]`.
   - CLI text has one formatter path. It does not render old `ViewMessage`
     rows, reuse React-specific presentation code, or branch through abandoned
     bundle helpers.
   - CLI formatting changes only where labels intentionally change.
   - Provider-audit snapshots remain truncated/readable and cover streaming
     prefixes plus idle states.

6. Replace frontend timeline rendering with one generic path.
   - `ThreadTimelineRows` renders semantic rows directly.
   - The generic renderer switches on `row.kind`; work details switch on
     `workKind`.
   - `ThreadTimelinePane` and query-cache optimistic insertion stop importing
     old domain timeline row types.
   - Optimistic user input is rendered through the same conversation row UI but
     remains app-local until the server response arrives.
   - Latest-activity highlighting, if kept, is computed locally from semantic
     rows and is not used for ongoing labels.
   - Reuse useful primitives: user row, assistant markdown, terminal output,
     diff block, expandable panel, and shared text/tone primitives.
   - Delete `ConversationEntry` and old per-message row components once the
     generic renderer reaches feature parity:
     `ToolCallRow`, `FileEditRow`, `DelegationRow`, `WebSearchRow`,
     `OperationRow`, `ErrorRow`, `DebugEventRow`, `TasksRow`,
     `ToolBundleBody`, and `ToolExploringRow`.

7. Remove the old timeline model.
   - Delete `@bb/domain` timeline display row schemas/types.
   - Delete old `ViewProjection`/`ViewMessage` timeline-only plumbing after no
     production consumer imports it.
   - Delete `ViewTasksMessage`, `TasksRow`, `taskStatusGlyph`, and task/todo
     timeline formatting.
   - Remove old helper exports from `@bb/thread-view`; root exports become the
     semantic pipeline, text formatter, and stable public types.

8. Delete `@bb/core-ui`.
   - This is cleanup after timeline cutover, not the first move.
   - `assertNever`: use existing local helpers or inline small local versions.
   - `extractErrorMessage`/`toRecord`: keep at app/CLI API boundary modules.
   - `formatEnvironmentDisplay`: keep app/CLI local unless a separately agreed
     environment presentation owner exists.
   - Pending-interaction formatting: keep with app/CLI/server concrete
     consumers unless a separately agreed pending-interaction presentation owner
     exists.
   - `timeAgo`: app-local.
   - Shared duration formatting stays in `@bb/thread-view` only if it is used by
     timeline labels/text formatting; otherwise it is local.
   - Remove `@bb/core-ui` package files and workspace dependencies when
     `rg "@bb/core-ui"` has no product imports.

## Review Gates

Each implementation commit must satisfy at least one of these:

- Introduces the semantic contract or projector with tests.
- Cuts one consumer over to semantic rows.
- Deletes an old timeline path made unreachable by the cutover.
- Removes `@bb/core-ui` dependency from a package without moving presentation
  code into `@bb/domain`.

Each commit review checks:

- No new `@bb/domain` presentation helpers.
- No new root export from `@bb/thread-view` unless it is part of the public API
  budget above.
- No new parallel renderer path without deleting or making the old path
  unreachable in the same slice.
- No implementation path that produces semantic rows from old `ViewMessage`
  rows for production.
- No accepted-but-ignored fields.
- Optional fields have a real absent/unknown meaning.
- Nullable fields use `null` only for a real unknown/not-applicable state, and
  are filled once at the projection boundary.
- Tests cover behavior, not implementation call order.
- `rg` checks listed in the exit criteria move toward zero.

## Exit Criteria

- `ThreadTimelineResponse.rows` is the semantic row tree used by app, CLI, and
  audit.
- React timeline rendering enters through one generic semantic row renderer.
- Old per-message timeline row components are deleted.
- Tasks/todo/plan rows are absent from projection, contract, and rendering.
- `@bb/domain` no longer exports timeline display row types.
- Production timeline code no longer imports `ViewMessage` or `ViewProjection`.
- `@bb/thread-view` root exports are limited to semantic projection, grouping,
  text formatting, and stable public types.
- CLI timeline rendering has one semantic-row text path.
- `rg "@bb/core-ui"` returns no product imports and the package is gone.
- CLI/provider-audit snapshots cover app and CLI formatting.
- Focused tests cover source projection, grouping, lazy turn children, command
  rows with exploration intents, pending/denied command approvals, pending
  file-change approvals, permission grants, concrete file-change rows,
  delegation rows, active-run grouping, user steers, and manager-thread
  filtering.
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
rg "@bb/core-ui" apps packages --glob '!packages/agent-provider-audit/build/**'
rg "ViewTasksMessage|TasksRow|taskStatusGlyph" apps packages
rg "ViewProjection|ViewMessage" apps packages --glob '!**/test/**' --glob '!packages/agent-provider-audit/fixtures/**' --glob '!packages/agent-provider-audit/build/**'
rg "Number.MAX_SAFE_INTEGER" apps packages
```
