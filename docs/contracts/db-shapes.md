# DB Shapes and Repository Invariants

Source of truth: `packages/db/src/schema.ts`, `packages/db/src/repositories.ts`, and `packages/db/src/environment-agent-repositories.ts`.

## Tables

## `projects`

- `id` (PK)
- `name` (not null)
- `root_path` (not null)
- `project_instructions` (nullable)
- `primary_checkout_thread_id` (nullable)
- `created_at` (not null)
- `updated_at` (not null)

Index:

- `projects_primary_checkout_thread_idx (primary_checkout_thread_id)`

Ownership: `ProjectRepository`.

## `threads`

- `id` (PK)
- `project_id` (FK -> `projects.id`)
- `title` (nullable)
- `status` (not null, default `created`; `created | provisioning | provisioned | provisioning_failed | error | idle | active`)
- `environment_id` (nullable)
- `environment_record` (nullable JSON string)
- `parent_thread_id` (nullable)
- `archived_at` (nullable)
- `last_read_at` (not null, default `0`)
- `created_at` (not null)
- `updated_at` (not null)

Indexes:

- `threads_project_updated_idx (project_id, updated_at)`
- `threads_environment_idx (environment_id)`
- `threads_parent_thread_idx (parent_thread_id)`
- `threads_archived_status_idx (archived_at, status)`

Ownership: `ThreadRepository`.

Status invariant (`closed_internal`):

- Valid values: `created`, `provisioning`, `provisioned`, `provisioning_failed`, `error`, `idle`, `active`.
- Invalid persisted values throw on read.

## `queued_thread_messages`

- `seq` (PK, auto increment)
- `id` (unique)
- `thread_id` (FK -> `threads.id`, cascade delete)
- `input` (JSON string, not null)
- `model` (nullable)
- `service_tier` (nullable)
- `reasoning_level` (not null)
- `sandbox_mode` (not null)
- `created_at` (not null)

Indexes:

- `queued_thread_messages_thread_seq_idx (thread_id, seq)`
- `queued_thread_messages_thread_created_idx (thread_id, created_at)`

Ownership: `ThreadRepository`.

Invariants:

- persisted `input` must decode through `promptInputSchema[]`
- invalid persisted reasoning/sandbox values throw on read

## `events`

- `id` (PK)
- `thread_id` (FK -> `threads.id`)
- `seq` (not null, monotonic per thread)
- `type` (raw persisted event type string)
- `norm_type` (normalized type: lower-case, `.` -> `/`)
- `turn_id` (nullable lookup extract)
- `provider_thread_id` (nullable lookup extract)
- `is_turn_lifecycle` (bool)
- `is_thread_identity` (bool)
- `data` (JSON string)
- `created_at` (not null)

Index:

- `events_thread_seq_idx (thread_id, seq)`

Ownership: `EventRepository`.

## `environment_agent_sessions`

- `id` (PK)
- `thread_id` (FK -> `threads.id`, cascade delete)
- `agent_id` (not null)
- `agent_instance_id` (not null)
- `protocol_version` (not null)
- `control_base_url` (nullable)
- `control_auth_token` (nullable)
- `status` (not null)
- `lease_expires_at` (not null)
- `last_heartbeat_at` (nullable)
- `closed_at` (nullable)
- `close_reason` (nullable)
- `created_at` (not null)
- `updated_at` (not null)

Indexes:

- `environment_agent_sessions_thread_status_idx (thread_id, status)`
- `environment_agent_sessions_agent_status_idx (agent_id, status)`
- `environment_agent_sessions_lease_expires_idx (lease_expires_at)`

Ownership: `EnvironmentAgentSessionRepository`.

Closed-internal invariants:

- `control_base_url` and `control_auth_token` are persisted restart hints for daemon nudges, not thread truth
- valid `status`: `active`, `expired`, `closed`, `replaced`
- valid `close_reason` when present:
  - `agent_shutdown`
  - `daemon_shutdown`
  - `lease_expired`
  - `newer_session`
  - `migration`
  - `internal_error`
- invalid persisted union values throw on read

## `environment_agent_cursors`

- `thread_id` (PK, FK -> `threads.id`, cascade delete)
- `generation` (not null)
- `sequence` (not null)
- `updated_at` (not null)

Ownership: `EnvironmentAgentCursorRepository`.

Invariants:

- cursor state is one row per thread
- `advanceIfNext()` only advances contiguously within a generation
- generation changes must be explicit; a new generation may advance only from the immediately previous generation
- failed `advanceIfNext()` returns the current stored cursor when one exists

## `environment_agent_commands`

- `id` (PK)
- `thread_id` (FK -> `threads.id`, cascade delete)
- `session_id` (nullable FK -> `environment_agent_sessions.id`, set null on delete)
- `command_cursor` (not null, monotonic per thread)
- `command_type` (not null)
- `payload` (JSON string, not null)
- `state` (not null)
- `result` (nullable JSON string)
- `error_code` (nullable)
- `error_message` (nullable)
- `created_at` (not null)
- `updated_at` (not null)

Indexes:

- unique `environment_agent_commands_thread_cursor_idx (thread_id, command_cursor)`
- `environment_agent_commands_thread_state_updated_idx (thread_id, state, updated_at)`
- `environment_agent_commands_session_state_idx (session_id, state)`

Ownership: `EnvironmentAgentCommandRepository`.

Closed-internal invariants:

- valid `state`:
  - `queued`
  - `sent`
  - `received`
  - `started`
  - `completed`
  - `failed`
  - `cancelled`
- invalid persisted states throw on read
- `payload` and `result` (when present) must contain valid JSON
- transition helpers are strict:
  - duplicate/replayed pre-terminal transitions are tolerated as no-ops
  - conflicting terminal transitions throw

## Event Repository Invariants

- `seq` is monotonic per thread (`getLatestSeq + 1`).
- `norm_type` is always derived with `normalizeThreadEventType`.
- `turn_id` and `provider_thread_id` are extracted from normalized envelope payload first, then legacy raw shapes.
- `is_turn_lifecycle` is true for `turn/start`, `turn/started`, `turn/end`, `turn/completed`.
- `is_thread_identity` is true when `provider_thread_id` is present.

## Execution Option Snapshot Reads

`getLatestExecutionOptions(threadId)` scans latest `client/thread/start` or `client/turn/start` events and decodes:

- `model`
- `reasoningLevel`
- `sandboxMode`
- `approvalPolicy`

Invalid persisted reasoning/sandbox/source values throw.

## Migration Policy

Task-domain data migration is intentionally dropped (locked decision).
