# Thread Tags Plan

## Goal

Add project-scoped tags to threads so users and manager threads can categorize,
follow, and filter high-volume work. Threads can have multiple tags such as
`code review` and `react perf`; tags render as pills in the sidebar and thread
detail header; tags are editable from the app three-dot menu and the CLI.

Do not treat the existing manager/managed labels as tags. Those remain
derived state. Tags are user/manager-maintained categorization metadata.

## Current Findings

- Thread persistence is a single `threads` table in
  `packages/db/src/schema.ts` with project/type/parent/archive indexes. There is
  no generic metadata column to reuse, and embedding tags there would make list
  filters and uniqueness weak.
- Thread API responses currently come from `@bb/domain` thread schemas via
  `packages/server-contract/src/api-types.ts`. The persisted `Thread` shape is
  also used as a DB row shape, so tag response fields should be introduced as an
  explicit response extension rather than silently changing persisted thread
  records.
- `GET /threads` uses `listThreadsWithPendingInteractionState` and returns a
  project-scoped list filtered by type, parent thread, and archived state.
  Tag filtering must be pushed into SQL with indexes, not applied in JS after
  loading project threads.
- `PATCH /threads/:id` currently updates title and manager parent assignment.
  Parent changes queue manager ownership messages; tag mutations should be
  separate from this route to keep lifecycle ownership isolated.
- Realtime invalidation is driven by `ThreadChangeKind`; app cache logic treats
  title/read/archive/status as list-affecting thread changes. Tags need their
  own change kind that invalidates both thread detail and thread lists.
- The thread detail header uses
  `StatusPill` for `manager` and `managed`. Add one canonical
  thread-tag pill renderer reused in both locations instead of duplicating local
  class bundles.
- The three-dot menu is centralized in `ThreadActionsMenu` and
  `ThreadActionsProvider`, which already host rename/delete/archive dialogs.
  Tag editing belongs there.
- CLI thread commands already support `list`, `show`, `update`, `spawn`,
  lifecycle, and manager flows. Managers use `bb thread spawn` and inherit
  `BB_THREAD_ID` as the parent, so managers can tag child threads through the
  same CLI assignment commands.

## Data Model

Use normalized project-scoped tag tables.

Add `thread_tags`:

- `id text primary key` using a new `tag_` ID helper.
- `project_id text not null references projects(id) on delete cascade`.
- `name text not null`.
- `normalized_name text not null`.
- `color text null`.
- `deleted_at integer null`.
- `created_at integer not null`.
- `updated_at integer not null`.

Add indexes:

- `thread_tags_project_active_name_idx` on `(project_id, normalized_name)` with
  `WHERE deleted_at IS NULL` as a raw migration partial unique index. Drizzle
  schema can document the partial index limitation as existing schema does.
- `thread_tags_project_updated_idx` on `(project_id, updated_at)`.

Add `thread_tag_assignments`:

- `thread_id text not null references threads(id) on delete cascade`.
- `tag_id text not null references thread_tags(id) on delete cascade`.
- `position integer not null`.
- `created_at integer not null`.
- `updated_at integer not null`.
- Primary/unique key `(thread_id, tag_id)`.

Add indexes:

- `thread_tag_assignments_thread_position_idx` on `(thread_id, position, tag_id)`.
- `thread_tag_assignments_tag_thread_idx` on `(tag_id, thread_id)`.

Semantics:

- Tags are project-scoped. This matches existing thread/project ownership,
  manager workflows, and expected project-specific vocabularies.
- `normalized_name` is computed at the server boundary by trimming, collapsing
  internal whitespace, and lower-casing. Names are unique per project after
  normalization while the tag is active.
- `color` is required in responses and nullable. `null` means use the neutral
  default pill style. Non-null values are canonical `#RRGGBB` hex strings.
- Rename updates the tag row, so all assigned threads show the new name.
- Delete soft-deletes the tag row. Assignment responses filter out deleted
  tags. Recreating the same normalized name creates a new tag id with no old
  assignments unless a future restore feature is explicitly added.
- Assignment order is per thread. `set` writes positions from the submitted
  order; `add` appends after the current max; `remove` compacts positions.

## Domain And Contracts

Add explicit tag schemas, ideally in a new domain module:

- `threadTagColorSchema`: nullable canonical hex in response schemas; request
  schemas validate input hex or mapped preset before persistence.
- `threadTagSchema`: `{ id, projectId, name, normalizedName, color, createdAt,
  updatedAt }`.
- `projectThreadTagSchema`: `threadTagSchema.extend({ threadCount:
  z.number() })` for project tag-list responses.
- `threadTagAssignmentSchema`: `{ threadId, tagId, position, createdAt,
  updatedAt }` if DB/service callers need it.

Do not add `tags` to the persisted `threadSchema` DB-row shape. Instead update
server-contract response schemas:

- `ThreadResponse = threadWithRuntimeSchema.extend({ tags:
  z.array(threadTagSchema) })`.
- `ThreadListResponse = z.array(threadListEntrySchema.extend({ tags:
  z.array(threadTagSchema) }))`.

Every response includes `tags: []` when untagged. No optional tag field.

Recommended public API:

- `GET /api/v1/projects/:id/tags`
  - Returns active project tags as `ProjectThreadTag[]`, ordered by name.
  - `threadCount` is required and counts assignments to non-deleted threads in
    the project, including archived threads. Archived visibility is controlled
    by thread-list filters, not by the project tag inventory.
- `POST /api/v1/projects/:id/tags`
  - Body `{ name: string, color: string | null }`.
  - Creates a new active tag only.
  - If an active tag with the same normalized name already exists, return
    `409 tag_name_conflict`. Do not mutate the existing tag and do not ignore a
    submitted `color`; existing colors change only via
    `PATCH /api/v1/projects/:id/tags/:tagId`.
- `PATCH /api/v1/projects/:id/tags/:tagId`
  - Body may include `name` and/or `color`. Omitted fields mean unchanged;
    `color: null` means clear custom color.
- `DELETE /api/v1/projects/:id/tags/:tagId`
  - Soft-deletes the active tag.
- `PUT /api/v1/threads/:id/tags`
  - Body is a discriminated union:
    `{ mode: "ids", tagIds: string[] }` or
    `{ mode: "names", names: string[], createMissing: boolean }`.
  - Replaces the thread's assignments in submitted order after server-side
    resolution.
- `POST /api/v1/threads/:id/tags`
  - Body is the same discriminated union as `PUT`.
  - Appends missing tags in submitted order after server-side resolution.
- `POST /api/v1/threads/:id/tags/remove`
  - Body is the same discriminated union as `PUT`, but `createMissing` must be
    `false` for `mode: "names"`.
  - Removes resolved assignments and compacts remaining positions.
- `DELETE /api/v1/threads/:id/tags/:tagId`
  - Removes one assignment by id and compacts remaining positions.

For name-based assignment, removal, and filtering, the server resolves names by
`normalized_name` with targeted SQL inside the route. When `createMissing` is
`true`, the server creates missing project tags with `color: null` before
assignment. When `createMissing` is `false`, any missing name rejects the
request with a 400 validation error that identifies the missing normalized
names. CLI/app clients must not fetch all tags and resolve/filter names
client-side.

Extend `ThreadListQuery` with tag filters after the base assignment endpoints
exist. Prefer structured repeated `tagId` and `tagName` query support if the
typed route layer supports it; otherwise add narrowly parsed `tagIds` and
`tagNames` boundary strings and convert them once at the route boundary. Support
`tagMatch=all|any`, defaulting at the server boundary to `all`. Tag names are
normalized and resolved in SQL before building the thread-list query.

## DB And Services

Add `packages/db/src/data/thread-tags.ts` with strongly typed functions:

- `listProjectTags(db, { projectId })`, returning active tags with
  `threadCount` from a grouped assignment count over non-deleted project
  threads, including archived threads.
- `getActiveProjectTagById(db, { projectId, tagId })`.
- `getActiveProjectTagByNormalizedName(db, { projectId, normalizedName })`.
- `listActiveProjectTagsByNormalizedNames(db, { projectId, normalizedNames })`.
- `createProjectTag(db, notifier, { projectId, name, normalizedName, color })`.
- `updateProjectTag(db, notifier, { projectId, tagId, name, normalizedName,
  color })`.
- `softDeleteProjectTag(db, notifier, { projectId, tagId })`.
- `listTagsForThreadIds(db, { threadIds })`.
- `setThreadTags(db, notifier, { threadId, tagIds })`.
- `addThreadTags(db, notifier, { threadId, tagIds })`.
- `removeThreadTag(db, notifier, { threadId, tagId })`.

Validation/service rules:

- Resolve the thread first, then require each tag to be active and in the same
  project as the thread.
- Resolve submitted names on the server with indexed `normalized_name` queries;
  create missing tags only when the discriminated assignment request explicitly
  sets `createMissing: true`.
- Deduplicate repeated tag ids in assignment requests while preserving first
  occurrence order.
- Run `set/add/remove` in transactions so positions and notifications stay
  consistent.
- Notify thread `"tags-changed"` and project `"threads-changed"` when
  assignment membership changes. Notify project `"tags-changed"` and
  `"threads-changed"` when tag definitions change, because thread list
  responses embed tag names and colors.
- Attach tags to list/detail responses using `listTagsForThreadIds`, not N+1
  per-thread queries and not JS filtering over all project tags.

For thread list filtering:

- `any`: join assignments by requested tag ids.
- `all`: query candidate `thread_id`s from assignments grouped by `thread_id`
  with `count(distinct tag_id) = requestedTagIds.length`, then join/filter the
  thread list query.
- Always include `threads.project_id`, `threads.deleted_at`, and archived
  predicates in SQL.

## CLI UX

Add a top-level `bb tag` command for project tag definitions:

```text
bb tag list [projectId] --project <id> --json
bb tag create <name> --project <id> --color <preset|#RRGGBB> --json
bb tag rename <tag-id-or-name> <new-name> --project <id> --json
bb tag color <tag-id-or-name> --project <id> --color <preset|#RRGGBB> --json
bb tag color <tag-id-or-name> --project <id> --clear-color --json
bb tag delete <tag-id-or-name> --project <id> --yes --json
```

Add nested thread assignment commands:

```text
bb thread tag list [threadId] --self --json
bb thread tag add [threadId] <tag...> --self --json
bb thread tag remove [threadId] <tag...> --self --json
bb thread tag set [threadId] <tag...> --self --json
```

Command details:

- `<tag...>` accepts tag names or ids; quoted multi-word names are supported.
- `add` creates missing project tags with `color: null`, then assigns them.
- `set` replaces the full ordered tag set.
- `remove` fails when a named tag cannot be resolved in the thread's project.
- `bb thread list --tag <tag-id-or-name>` is added once API tag filtering lands;
  allow multiple `--tag` flags with `--tag-match all|any`.
- `bb thread show` prints `Tags: code review, react perf`.
- JSON output is the API response shape, including `tags`.
- The CLI calls thread assignment/removal/list-filter routes in `mode: "names"`
  or query `tagName` form for name arguments. `bb thread tag add` uses
  `createMissing: true`; `set`, `remove`, and tag-filtering commands use
  `createMissing: false` semantics and fail on missing names.

Manager workflow:

- Managers can run `bb thread tag add <child-id> "react perf"` after spawning
  or taking over child threads.
- Update `bb guide threads`, `bb guide managers`, and
  `manager-agent-instructions.md` to mention tags for grouping child work.
- Do not add a manager-only tagging tool in the first pass; the manager already
  uses the CLI for thread lifecycle operations.

## App UX

Shared rendering:

- Add a canonical `ThreadTagPill` and `ThreadTagPillList` component, using
  `Pill` from `@bb/ui-core`.
- The component owns color contrast, neutral fallback, truncation, `title`, and
  `aria-label` behavior.
- Use the same component in sidebar rows, detail header, archived thread list,
  and any future search/filter surfaces.

Sidebar:

- Render compact tag pills after the title in `ThreadRow`.
- Keep row dimensions stable. Show the first one or two tags plus a `+N` pill
  when space is constrained; expose the full tag list in a tooltip/title.
- Preserve existing manager child count, environment icon, pending interaction,
  unread, and action-menu behavior.

Thread detail header:

- Render the full tag pill list next to the thread title and existing
  `manager`/`managed` status pills.
- Allow wrapping within the header center area on narrow widths without
  overlapping actions.

Editing:

- Add `Edit tags` to `ThreadActionsMenu`.
- Extend `ThreadActionsProvider` with a `ThreadTagsDialog`.
- Dialog content:
  - Loading state while project tags are fetched.
  - Empty state: "No tags yet" plus create flow.
  - Search/create input for multiple tags.
  - Assigned tags as removable pills, ordered by assignment order.
  - Project tag list with checkboxes for assignment.
  - Color controls for tag definitions using presets plus a custom hex input.
  - Clear-color action when a tag has a custom color.
- Mutations should optimistically update the thread detail and cached thread
  lists where straightforward; still invalidate the canonical thread/list/tag
  queries after settlement.
- Ensure keyboard navigation, focus return to the menu trigger, clear labels
  for color swatches, and visible focus states.

Archived lists, search, and filters:

- Show tag pills in `ProjectArchivedThreadsView`.
- Include archived threads in tag filters when `archived=true`.
- Add project sidebar or archived-list filtering only after the API list filter
  exists; do not create app-local filtering over a fetched project list.
- Prompt mention suggestions may show tags later, but that is not required for
  the first implementation unless product asks for it.

## Realtime And Cache

Add change kinds:

- `ThreadChangeKind`: `tags-changed`.
- `ProjectChangeKind`: `tags-changed` if project tag definitions change.

Realtime invalidation:

- Thread `"tags-changed"` invalidates `threadQueryKey(threadId)`,
  `threadsQueryKey()`, and status only if tag filters become part of the status
  payload later. Initially status does not need invalidation.
- Project `"tags-changed"` invalidates `projectTagsQueryKey(projectId)` and
  thread lists, because tag definition edits change embedded list pill labels
  and colors.

Query keys:

- Add `PROJECT_TAGS_QUERY_KEY` with `projectTagsQueryKey(projectId)`.
- Extend `ThreadListQueryFilters` with `tagIds` and `tagMatch` only when the
  API supports those filters.
- Update cache placeholder helpers and optimistic insert/update paths to carry
  `tags: []` for new thread responses.

## Migrations And Rollout

1. Add DB migration `0004_thread_tags.sql`, schema definitions, ID helper, and
   data-access tests. Backfill is empty because no existing thread tags exist.
2. Add domain/server-contract tag schemas and response extensions. Update
   contract optional-field documentation for any new partial update request.
3. Add DB services and API routes. Ensure route handlers fill defaults at the
   boundary, validate colors/names, and reject cross-project assignments.
4. Attach tags to thread detail/list responses and add realtime change kinds.
5. Add CLI `bb tag` and `bb thread tag` commands, plus guide/template updates.
6. Add app query/mutation hooks, shared pill components, header/sidebar/archive
   rendering, and the three-dot menu tag editor.
7. Add list filtering by tag and app filter controls once assignment and
   rendering are stable.

## Tests

DB:

- In-memory SQLite migration includes both new tables and indexes.
- Normalized name uniqueness is enforced per project and ignores soft-deleted
  tags.
- Project tag list `threadCount` counts non-deleted project threads with the
  tag, including archived threads, and excludes deleted threads.
- Cross-project assignment is rejected in the service.
- `set/add/remove` preserve deterministic order and compact positions.
- `listTagsForThreadIds` returns only active tags and does not N+1 query.
- Tag-filtered thread list SQL returns correct `all` and `any` matches.

Server/API:

- Project tag create/list/update/delete routes validate names and colors.
- Project tag create returns `409 tag_name_conflict` for an existing active
  normalized name and never mutates an existing tag.
- Thread tag set/add/remove routes reject deleted/cross-project/missing tags.
- Thread tag set/add/remove and list-filter routes resolve names server-side and
  create missing names only when `mode: "names"` sets `createMissing: true`.
- Thread detail and list responses include required `tags`.
- Tag changes emit the expected thread/project notifications.
- Existing title/parent update behavior and manager ownership messages remain
  unchanged.

CLI:

- `bb tag list/create/rename/color/delete` text and JSON output.
- `bb thread tag list/add/remove/set` text and JSON output.
- `bb thread list --tag` and `bb thread show` include tag behavior.
- JSON-flag enforcement tests cover the new commands.

App:

- `ThreadTagPillList` renders neutral and custom-color tags accessibly.
- `ThreadRow`, `ThreadDetailHeader`, and archived list render tags without
  overlapping existing controls.
- `ThreadActionsMenu` opens the tag editor through `ThreadActionsProvider`.
- Tag dialog create/assign/remove/color flows call the expected API wrappers and
  update caches.
- Realtime `tags-changed` invalidates detail/list/tag queries.

Validation commands:

```text
pnpm exec turbo run typecheck --filter=@bb/db
pnpm exec turbo run test --filter=@bb/db
pnpm exec turbo run typecheck --filter=@bb/server-contract
pnpm exec turbo run test --filter=@bb/server-contract
pnpm exec turbo run typecheck --filter=@bb/server
pnpm exec turbo run test --filter=@bb/server
pnpm exec turbo run typecheck --filter=@bb/cli
pnpm exec turbo run test --filter=@bb/cli
pnpm exec turbo run typecheck --filter=@bb/app
pnpm exec turbo run test --filter=@bb/app
```

For app visual validation, run the dev app and verify:

1. Tags appear in the sidebar, thread detail header, and archived thread list.
2. The three-dot menu opens the tag editor and focus returns after close.
3. Long tag names, many tags, and custom colors do not overlap row actions or
   header buttons.
4. Tag filters do not fetch all rows and filter client-side.

## Exit Criteria

- Threads can have zero or more project-scoped tags with deterministic ordering.
- Tags can be created, renamed, color-updated, soft-deleted, assigned, removed,
  and replaced through explicit API contracts.
- CLI supports tag definition and thread assignment workflows, including JSON
  output and manager-friendly child-thread tagging.
- App sidebar, thread detail header, archived list, and three-dot tag editor use
  one canonical tag pill renderer.
- Thread list filtering by tags is SQL-backed with indexes.
- Realtime updates keep thread detail, thread lists, and project tag lists
  current.
- Migrations and tests pass via Turbo commands listed above.

## Chosen Defaults Pending Michael Override

- Tags are project-scoped in the first implementation.
- Custom tag colors use canonical `#RRGGBB` values, with app presets allowed as
  input shortcuts that resolve to hex at the server boundary.
- `bb thread tag add <name>` creates missing project tags with `color: null`;
  other name-based operations fail on missing names unless they explicitly send
  `createMissing: true`.

## Open Product Questions For Michael

- Should `bb thread spawn` grow `--tag <name>` as a convenience in the first
  implementation, or is post-spawn `bb thread tag add` sufficient?
- Should manager agents be encouraged to auto-tag every child thread, or should
  tags remain opt-in based on manager/user judgment?
- Should archived tag filters default to including archived threads only when
  `--archived`/`archived=true` is set, matching current list semantics?
