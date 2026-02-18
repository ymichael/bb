# Thread Role Injection + Thread Role Metadata Plan

## Goal

Move agent role context out of user-visible chat messages and into the thread instruction channel, while persisting the resolved role on each thread record.

## Implementation Status

- Completed:
  - Added `agentRoleId` thread metadata across core types, DB schema/repository, and migrations.
  - Switched task primary-thread startup to pass assignment instructions via `developerInstructions` instead of synthetic user `input`.
  - Added role-aware thread spawn resolution via `roleId` on `/threads` and CLI `bb thread spawn --role`.
  - Standardized system text:
    - `[bb system] You have been assigned this task, please work on it as instructed`
    - `[bb system] Thread <id> is done.`
- Remaining:
  - Optional web UI thread-role rendering in task/thread detail surfaces.

## Why This Change

Current task chat startup prepends role/task instructions into `input` as a text user message. This has two problems:

- The role envelope appears in the conversational transcript as if the user sent it.
- The thread model does not explicitly store which agent role was applied.

## Current State (Relevant Code)

- Role preamble is built and injected into `input` in `apps/daemon/src/routes/tasks.ts` (`buildTaskRolePreamble`, `ensurePrimaryThread`).
- Provider thread start params currently set static `baseInstructions` only in `apps/daemon/src/codex-provider-adapter.ts`.
- Thread model persists linkage fields (`taskId`, `taskRole`, `parentThreadId`) but no agent role field:
  - `packages/core/src/types.ts`
  - `packages/db/src/schema.ts`
  - `packages/db/src/repositories.ts`

## Requirements

- Role/task instruction envelope for task-assigned threads must be sent via `thread/start` instructions, not user `input`.
- Task-assignment kickoff message text must be exactly: `[bb system] You have been assigned this task, please work on it as instructed`.
- The kickoff system message above must be startup `input` only and must not be copied into `developerInstructions`.
- Parent thread completion notification text must be exactly: `[bb system] Thread <id> is done.`
- Thread records must persist the resolved role id used to create the thread.
- Task/thread linkage behavior (`taskId`, `taskRole`, `parentThreadId`) must remain unchanged.
- `bb thread spawn` must support role-based instruction injection via `--role` only.
- If `--role` is not provided, no role instructions are injected (do not inject default role).
- For this scope, roles are code-defined in daemon role definitions. Role storage migration (for example DB-backed roles) is out of scope.

## Proposed Design

### 1) Thread Model Metadata

Add a nullable field on thread records:

- `agentRoleId?: string`

Semantics:

- This stores the resolved role id actually applied at thread creation time.
- For task-created primary threads, resolve via `getAgentRoleDefinition(task.assignee) ?? getDefaultAgentRole()` and persist that resolved id.
- For manual spawn without `--role`, this field remains undefined.

### 2) Instruction Injection Path

Replace task-role preamble injection into user input with thread-level instructions:

- Build a concise system assignment instruction message.
- Pass that envelope as `developerInstructions` in `thread/start` params.
- Do not prepend the role envelope to `input`.
- Keep `input` for actual user intent only (for example, the user message that started task chat).

### 3) Spawn Request Extensions

Add optional spawn fields to carry role metadata and instruction envelope through daemon internals:

- `agentRoleId?: string`
- `developerInstructions?: string`

The provider adapter will map final `developerInstructions` through to `thread/start` params when present.

### 4) Custom Roles In `bb thread spawn`

Expose role-driven instruction customization directly on thread spawn:

- `bb thread spawn --role <roleId>` resolves role instructions and injects them as `developerInstructions`.

Behavior:

1. If `--role` is provided, resolve role instructions and pass them through `developerInstructions`.
2. If `--role` is not provided, do not set role-derived `developerInstructions`.
3. Do not expose free-form developer instruction flags in this phase.

Validation:

- Unknown role id returns `400` with explicit error.
- Role resolution should use the same role source as task assignment to keep behavior consistent.

## Detailed Work Plan

### Phase 1: Data Model + Types

1. Add DB migration `packages/db/drizzle/0009_thread_agent_role_metadata.sql`:
   - `ALTER TABLE threads ADD COLUMN agent_role_id text;`
   - Add index for list/query ergonomics (recommended):
     - `threads_project_agent_role_updated_idx (project_id, agent_role_id, updated_at)`
2. Update Drizzle schema in `packages/db/src/schema.ts`.
3. Update repository mapping in `packages/db/src/repositories.ts`:
   - `create` accepts optional `agentRoleId`
   - `rowToThread` maps `agentRoleId`
   - optional `list` filter support for `agentRoleId` (recommended)
4. Update core types:
   - `packages/core/src/types.ts` (`Thread`)
   - `packages/core/src/api-types.ts` (`SpawnThreadRequest`)
   - `packages/core/src/schemas.ts` (`spawnThreadSchema`)
   - Include spawn-time fields needed for role-driven injection:
     - `agentRoleId?: string`
     - `developerInstructions?: string`

### Phase 2: Runtime Role Injection

1. Replace `buildTaskRolePreamble` usage in `apps/daemon/src/routes/tasks.ts`:
   - Build a `developerInstructions` envelope instead of injecting into `input`.
   - Pass `agentRoleId` and `developerInstructions` to `threadManager.spawn`.
   - Keep user-provided chat `input` intact.
2. Update provider adapter in `apps/daemon/src/codex-provider-adapter.ts`:
   - In `createThreadStartParams`, include `developerInstructions` when provided.
3. Ensure thread creation in `apps/daemon/src/thread-manager.ts` persists `agentRoleId` into `threadRepo.create(...)`.
4. Extend thread spawn route (`apps/daemon/src/routes/threads.ts`) to accept role selection:
   - Accept role selection (for example `roleId`) on spawn.
   - Validate role id when provided.
   - Resolve role instructions only when role id is provided.
   - Pass `agentRoleId` + resolved `developerInstructions` into `threadManager.spawn(...)`.

### Phase 3: API/CLI/Web Surface Alignment

1. Thread APIs return `agentRoleId` in thread payloads automatically via `Thread` type.
2. UI/CLI surfaces:
   - CLI: show role in `bb thread status` / `bb thread show` (`apps/cli/src/commands/thread.ts`).
   - Web: display thread role in the Task Detail metadata section where linked thread metadata is shown (`apps/web/src/views/TaskDetailView.tsx`).
3. Optional server list filter:
   - Add `agentRoleId` query filter to `GET /threads` route and client wrappers.
4. Add CLI spawn customization in `apps/cli/src/commands/thread.ts`:
   - `--role <roleId>`
   - No `--developer-instructions*` flags in this phase.

## Testing Plan

### Daemon Route Tests

- `apps/daemon/src/__tests__/routes/tasks.test.ts`
  - assert spawned request includes `agentRoleId` and `developerInstructions`
  - assert injected user `input` no longer contains synthetic role preamble text
- `apps/daemon/src/__tests__/routes/threads.test.ts`
  - assert `/threads` spawn accepts role selection and resolves developer instructions from that role
  - assert unknown role id returns `400`
  - assert when no role is provided, no role-derived developer instructions are set

### Provider Adapter Tests

- `apps/daemon/src/__tests__/codex-provider-adapter.test.ts`
  - assert `createThreadStartParams` forwards `developerInstructions`

### Thread Manager Tests

- `apps/daemon/src/__tests__/thread-manager.test.ts`
  - assert `threadRepo.create` receives/persists `agentRoleId`
  - assert outbound `client/thread/start` event contains resolved `developerInstructions`

### Repository Tests

- `packages/db/test/repositories.strict.test.ts`
  - create/get/list thread with `agentRoleId`
  - optional filter test if filter is added

### Web/CLI Tests (if surfacing role)

- Update existing snapshots/assertions to include optional role metadata rendering/output.
- Add CLI tests for `bb thread spawn --role` and no-role behavior.

## Rollout Sequence

1. Ship migration + type/repository changes.
2. Ship runtime instruction-path change.
3. Ship UI/CLI display and optional list filtering.

This sequence keeps behavior stable and makes validation easier.

## Exit Criteria

- Task-created primary thread startup no longer injects role envelope into user `input`.
- Provider `thread/start` includes role envelope via `developerInstructions`.
- Thread payloads persist and return `agentRoleId`.
- `bb thread spawn --role <roleId>` can create role-scoped threads without embedding role text in user messages.
- When spawn role is omitted, no role instructions are injected.
