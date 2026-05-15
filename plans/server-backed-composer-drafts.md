# Server-Backed Composer Drafts Plan

## Goal

Persist unsubmitted prompt-box contents on the server so a user can refresh the
page, switch browsers, or use another device and continue the same new-thread or
follow-up composer draft.

This is intentionally separate from queued messages. A composer draft is text
and attachments still sitting in a prompt box. A queued message is a submitted
follow-up waiting to be sent or steered.

## Current Findings

- Prompt-box drafts are stored only in browser `localStorage` by
  `apps/app/src/hooks/usePromptDraftStorage.ts`.
- The local storage key is project scoped for the new-thread composer and
  project+thread scoped for follow-up composers.
- Follow-up composer bootstrap already loads server state for execution options,
  prompt history, pending interactions, and queued messages through
  `GET /api/v1/threads/:id/composer-bootstrap`.
- Existing queued follow-ups are persisted in `queued_thread_messages`. Do not
  reuse that table for composer drafts. It has claim tokens and send lifecycle
  semantics that do not apply to unsent text.
- Sidebar rows can show a draft indicator only if thread list data includes a
  user-specific draft signal or the app fetches a targeted draft index. Do not
  load all threads and filter drafts in JS.

## Product Semantics

- Empty drafts are not stored. Clearing the composer deletes the server row.
- A draft belongs to one user, one project, and one composer scope:
  `new-thread` or `thread`.
- `new-thread` drafts are keyed by project and user.
- Follow-up drafts are keyed by project, thread, and user.
- Submitting a composer draft deletes the composer draft only after the send or
  queued-message creation succeeds. Failed submits restore the local composer
  state and leave or rewrite the server draft.
- Queued messages remain submitted work. They continue to appear in the queued
  message banner and prompt history as queued entries. Composer drafts do not.
- Draft attachment references use the existing uploaded prompt attachment shape.
  No new binary storage path is introduced in this plan.

## Data Model

Add a new `composer_drafts` table.

Fields:

- `id text primary key`, with a new `cmpdraft_` ID helper.
- `user_id text not null references user(id) on delete cascade`.
- `project_id text not null references projects(id) on delete cascade`.
- `thread_id text null references threads(id) on delete cascade`.
- `scope_kind text not null`, constrained to `new-thread` or `thread`.
- `state text not null`, JSON for the validated prompt draft state.
- `revision integer not null`.
- `client_id text not null`.
- `created_at integer not null`.
- `updated_at integer not null`.

Indexes:

- Unique partial index for new-thread drafts:
  `(user_id, project_id, scope_kind)` where `scope_kind = 'new-thread'` and
  `thread_id IS NULL`.
- Unique partial index for follow-up drafts:
  `(user_id, project_id, thread_id, scope_kind)` where
  `scope_kind = 'thread'` and `thread_id IS NOT NULL`.
- `composer_drafts_user_project_updated_idx` on
  `(user_id, project_id, updated_at)`.
- `composer_drafts_user_thread_idx` on `(user_id, thread_id)` for sidebar and
  thread bootstrap lookups.

The row stores `PromptDraftState` rather than `PromptInput[]` because the
editable textarea text and attachment list are the canonical composer state.
The server validates JSON at the boundary and never stores malformed draft
state.

## Server API

Add contract/domain schemas for composer drafts:

- `composerDraftScopeSchema`: discriminated union for new-thread and thread
  scopes.
- `composerDraftStateSchema`: the shared text + attachments shape currently in
  the app prompt draft module, moved to a shared package if needed.
- `composerDraftSchema`: `{ id, projectId, threadId, scopeKind, state,
revision, clientId, createdAt, updatedAt }`.
- Request schemas for upsert and delete. No accepted-but-ignored fields.

Routes:

- `GET /api/v1/projects/:id/composer-draft`
  - Returns the current user's new-thread draft for the project, or `null`.
- `PUT /api/v1/projects/:id/composer-draft`
  - Upserts the current user's new-thread draft.
  - Empty state deletes the row and returns `null`.
- `DELETE /api/v1/projects/:id/composer-draft`
  - Deletes the current user's new-thread draft.
- `GET /api/v1/threads/:id/composer-draft`
  - Returns the current user's follow-up draft for the thread, or `null`.
- `PUT /api/v1/threads/:id/composer-draft`
  - Upserts the current user's follow-up draft.
  - Empty state deletes the row and returns `null`.
- `DELETE /api/v1/threads/:id/composer-draft`
  - Deletes the current user's follow-up draft.

Also extend:

- `GET /api/v1/threads/:id/composer-bootstrap`
  - Add required `composerDraft: ComposerDraft | null`.
- Thread list rows
  - Add required `hasComposerDraft: boolean` for the current user so the sidebar
    can render a draft icon without a second per-row request.

Implementation notes:

- Resolve the current user at the server boundary. If local/self-host mode uses
  a system user today, route all draft ownership through the same user identity
  abstraction rather than storing unauthenticated global drafts.
- Use targeted SQL for thread list draft signals, ideally a left join or
  `exists` subquery scoped to the current user.
- Draft writes should notify only user-visible app cache surfaces. They must not
  trigger queued-message auto-send, thread lifecycle transitions, or prompt
  history changes.

## App Implementation

Replace `usePromptDraftStorage` with a server-backed hook that keeps the same
consumer API where possible:

- `useComposerDraftStorage({ projectId, threadId })`
  - Reads initial state from React Query.
  - Maintains a local in-memory draft for immediate typing responsiveness.
  - Debounces server upserts, for example 500-1000 ms after the last edit.
  - Flushes immediately on blur, route change, and before submit.
  - Deletes the server row when the draft becomes empty.
  - Keeps `getCurrent`, `clearIfCurrentMatches`, and `restoreIfEmpty` semantics
    so submit failure behavior stays predictable.

React Query keys:

- `projectComposerDraftQueryKey(projectId)`
- `threadComposerDraftQueryKey(threadId)`
- `allComposerDraftsQueryKeyPrefix()`

Bootstrap:

- New-thread composer fetches the project draft directly.
- Follow-up composer uses `threadComposerBootstrap.composerDraft` to seed the
  draft query, matching the existing bootstrap cache-seeding pattern for queued
  messages and prompt history.

Local storage cutover:

- Do not migrate existing `bb.promptbox.contents-*` localStorage values.
- The server-backed hook should not read old localStorage draft keys.
- New draft writes go only to the server.
- Once the server-backed hook is in place, `usePromptDraftStorage` and its
  localStorage cache/subscription helpers can be deleted or replaced by the new
  server-backed hook.

Conflict behavior:

- Use server-owned `revision` increments on every write.
- The hook sends the last observed revision with upserts.
- If the server revision has advanced from another device while this device has
  unsaved edits, keep the active local text and surface a non-blocking "remote
  draft updated" affordance later if product wants it.
- For the first implementation, last writer wins after explicit local editing.
  Background refetches must not overwrite focused local edits.

Sidebar draft icon:

- Add an icon-only draft indicator to thread rows when `hasComposerDraft` is
  true.
- Do not show this icon for queued messages; queued messages should keep their
  existing composer banner treatment.
- Tooltip text should say "Draft" or "Unsubmitted draft".
- The indicator is current-user scoped. A draft from another user must not show
  on the row.

## Tests

DB tests:

- Creates, reads, updates, and deletes project and thread composer drafts.
- Enforces one draft per user+project new-thread scope.
- Enforces one draft per user+thread follow-up scope.
- Cascades thread deletion to follow-up drafts.
- Cascades project deletion to all project drafts.
- Does not treat queued messages as composer drafts.

Server tests:

- Project draft routes upsert, delete, and return `null` for empty drafts.
- Thread draft routes upsert, delete, and reject cross-thread/project misuse.
- Composer bootstrap includes `composerDraft`.
- Thread list returns `hasComposerDraft` for only the current user's drafts.
- Submitting a follow-up clears the composer draft after successful send.
- Submitting while active creates a queued message and clears the composer draft
  after the queued-message create succeeds.
- Failed submit keeps or restores the composer draft.

App tests:

- New-thread composer hydrates from the server draft.
- Follow-up composer hydrates from composer bootstrap.
- Typing debounces a server upsert.
- Clearing the prompt deletes the server draft.
- Submit clears the server draft only after success.
- Sidebar row renders the draft icon from `hasComposerDraft` and does not render
  it for queued messages alone.

## Validation

Run typechecks:

```sh
pnpm exec turbo run typecheck --filter=@bb/db
pnpm exec turbo run typecheck --filter=@bb/server-contract
pnpm exec turbo run typecheck --filter=@bb/server
pnpm exec turbo run typecheck --filter=@bb/app
```

Run focused tests:

```sh
pnpm exec turbo run test --filter=@bb/db -- test/data/composer-drafts.test.ts test/schema.test.ts
pnpm exec turbo run test --filter=@bb/server-contract -- test/contract.test.ts
pnpm exec turbo run test --filter=@bb/server -- test/public/public-composer-drafts.test.ts test/public/public-thread-data.test.ts
pnpm exec turbo run test --filter=@bb/app -- src/hooks/useComposerDraftStorage.test.tsx src/hooks/queries/thread-queries.test.tsx src/views/thread-detail/ThreadDetailPromptArea.test.tsx
```

Manual verification:

- Type in the new-thread composer, refresh, and verify the draft returns.
- Type in a follow-up composer, refresh, and verify the draft returns.
- Open the same account in a second browser/device, load the project/thread, and
  verify the draft appears.
- Type a follow-up draft and verify the sidebar row shows the draft icon.
- Create a queued message on a thread with no composer draft and verify the
  draft icon does not appear.
- Submit a draft successfully and verify the icon disappears.

## Exit Criteria

- Composer drafts are persisted in `composer_drafts`, not `localStorage`.
- Prompt draft localStorage reads and writes are removed from the active
  composer path.
- New-thread and follow-up composers both survive refresh and are available
  across devices for the same user.
- Queued-message behavior, prompt history, and auto-send lifecycle are unchanged.
- Sidebar rows show a user-scoped draft icon for unsubmitted follow-up drafts.
- Typecheck and focused tests pass through Turbo.
