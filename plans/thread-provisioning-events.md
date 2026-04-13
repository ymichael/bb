# Thread Provisioning Events Plan

## Goal

Replace the current environment-shaped provisioning timeline event with a thread-owned provisioning lifecycle, and remove the hidden generated-title event.

The new model should make one thread timeline operation represent all pre-run work:

- metadata generation for title and branch slug
- environment/workspace provisioning
- setup script execution
- provider thread startup handoff

## Current State

- `system/thread-title/updated` is appended when generated metadata applies a title, but the UI hides it from the timeline.
- `updateThread(..., { title })` already emits `title-changed`, which refreshes thread/list UI state.
- `system/provisioning` is stored as a thread event, but its data model and UI copy are environment-oriented.
- Provisioning transcript entries are close to the right shape for incremental lifecycle steps, but step entries currently reuse keys and the UI merges them with "latest wins" semantics. The raw event stream is append-only, but the rendered transcript is not a true append-only log.
- Several lower-level steps record `durationMs`, but the UI only renders one operation-level duration and ignores per-step durations. Some `startedAt` values are emitted at completion time, so the entry timestamp is not a reliable step start time.
- Metadata generation, setup-script skip/no-op behavior, provider thread startup, and managed workspace reconnects are not clearly represented in the provisioning transcript.

## Target Contract

Use a single event type for thread preparation:

- Event type: `system/thread-provisioning`
- Operation type: `thread-provisioning`
- Data:
  - `status`: `started | in_progress | completed | failed`
  - `entries`: `ProvisioningTranscriptEntry[]`
  - `environmentId`: optional, present once an environment is known

Keep the transcript entry shape, but make the keys thread-lifecycle oriented:

- `metadata`: generating thread metadata
- `environment`: creating or reusing the thread environment
- `workspace`: provisioning worktree, clone, sandbox, or unmanaged path
- `setup`: running setup script
- `provider-thread`: starting/resuming the provider thread

Transcript semantics:

- The rendered log must be append-only. Do not mutate prior visible lines in place.
- State transitions may still be grouped by step internally, but the user-facing output should preserve each meaningful event in order.
- Show concise durations for steps where elapsed time helps explain waiting or failure, such as metadata generation, sandbox startup, git clone/worktree creation, checkout, setup script, and provider thread startup.
- Treat transcript copy as a user-facing surface. Every emitted `text` value should be reviewed as product copy, not as incidental debug output.

## User-Facing Audit

Audit every user-facing provisioning detail while making the contract change. The goal is that users understand "the thread is being provisioned" first, with workspace/environment work presented as lower-level detail.

Surfaces to audit and update:

- Timeline operation titles in `packages/core-ui/src/parse-operation-message.ts` and `packages/core-ui/src/provisioning-helpers.ts`.
- Timeline row rendering in `packages/ui-core/src/thread-timeline/rows/OperationRow.tsx`, including summary labels, detail text, elapsed-time copy, and transcript formatting.
- Transcript step text emitted by `apps/server/src/services/threads/thread-create.ts`, `apps/server/src/internal/command-result-handlers.ts`, `apps/host-daemon/src/command-handlers/environment.ts`, and host workspace provisioning helpers.
- Prompt disabled-state copy such as "Thread is provisioning..." in the app.
- CLI thread status labels, wait output, thread show/log rendering, and command-output snapshots.
- Error titles/details, especially "Thread provisioning failed" normalization and sandbox setup/configuration failures.
- Public API docs/comments that currently say "environment provisioning" when the user-facing operation is thread preparation.

Copy principles:

- Use "Provisioning thread" for the top-level operation.
- Use "Setting up workspace", "Creating worktree", "Cloning repository", "Preparing sandbox", or "Running setup" for concrete lower-level steps.
- Avoid "Provisioning environment" in UI unless the environment object itself is the user's immediate focus.
- Keep durable status names internal if changing them would create unnecessary churn, but map user-facing labels to "Preparing" where possible.
- Do not expose generated metadata values in transcript copy unless they are already visible elsewhere; prefer outcome metadata for debugging.

## Proposed User-Facing Outcomes

Top-level timeline summary:

- Pending: `Provisioning thread`
- Completed: `Provisioned thread`
- Failed: `Provisioning thread failed`
- Interrupted/stopped: `Provisioning thread interrupted`

Transcript guidelines:

- Append a new visible line for every meaningful lifecycle event. Do not rewrite `started` lines into `completed` lines.
- Use short present-tense/progress copy for started lines and past-tense outcome copy for completion lines.
- Include compact durations on completed/failed lines when useful.
- Keep paths, branch names, command output, and errors visible where they explain the workspace state.
- Use concrete user-facing labels:
  - Metadata generation: `Generating title and branch name`, or `Generating branch name` when the user supplied a title.
  - Setup script execution: `Running .bb-env-setup.sh`.
  - Provider runtime startup: `Starting agent session`.

Expected transcript examples:

- New unmanaged workspace:
  - `Preparing workspace`
  - `Using workspace: {path}`
  - `Using branch: {branch} ({sha})`
  - `Starting agent session`
  - `Agent session ready ({duration})`
  - `Provisioned thread ({duration})`
- Reused ready workspace:
  - `Using existing workspace`
  - `Using workspace: {path}`
  - `Using branch: {branch} ({sha})`
  - `Starting agent session`
  - `Agent session ready ({duration})`
  - `Provisioned thread ({duration})`
- Attach to workspace already being provisioned:
  - `Waiting for workspace`
  - Future shared progress lines from the active preparation.
  - `Starting agent session`
  - `Agent session ready ({duration})`
  - `Provisioned thread ({duration})`
- Managed worktree:
  - `Generating title and branch name`
  - `Generated title and branch name ({duration})`
  - `Creating worktree`
  - Git output lines, when present.
  - `Created worktree ({duration})`
  - `Using workspace: {path}`
  - `Using branch: {branch} ({sha})`
  - `Running .bb-env-setup.sh`
  - `.bb-env-setup.sh finished ({duration})`
  - `Starting agent session`
  - `Agent session ready ({duration})`
  - `Provisioned thread ({duration})`
- Managed clone or sandbox clone:
  - `Generating title and branch name`
  - `Generated title and branch name ({duration})`
  - `Cloning repository`
  - Git output lines, when present.
  - `Cloned repository ({duration})`
  - `Checking out branch`
  - `Checked out branch ({duration})`
  - `Running .bb-env-setup.sh`
  - `.bb-env-setup.sh finished ({duration})`
  - `Starting agent session`
  - `Agent session ready ({duration})`
  - `Provisioned thread ({duration})`
- Sandbox:
  - `Preparing sandbox`
  - `Sandbox host connected ({duration})`
  - `Starting sandbox daemon`
  - `Sandbox daemon ready ({duration})`
  - Then the managed clone transcript.
- Reprovision or restore:
  - `Restoring workspace`
  - Workspace-specific lines for worktree/clone reconnect or recreation.
  - `Workspace ready ({duration})`

## Code Changes

1. Delete generated title events.
   - Remove `system/thread-title/updated` from `systemEventTypeValues`.
   - Delete `systemThreadTitleUpdatedEventDataSchema` and related exported types.
   - Delete `appendThreadTitleUpdatedEvent`.
   - Remove the call from `applyGeneratedThreadTitle`.
   - Remove UI parsing branches/tests that specifically hide title-update events.
   - Remove provider-event schema support for `system/thread-title/updated`.

2. Rename provisioning event contract.
   - Rename `systemProvisioningEventDataSchema` to `systemThreadProvisioningEventDataSchema`.
   - Change the event literal from `system/provisioning` to `system/thread-provisioning`.
   - Rename server helpers from `appendProvisioningEvent` toward `appendThreadProvisioningEvent`.
   - Rename core-ui parser handling and operation metadata from provisioning/environment wording to thread provisioning.
   - Update host-daemon contract comments and emitted progress event type.

3. Make metadata generation part of the transcript.
   - Before managed metadata inference starts, append a `metadata` step with `status: "started"`.
   - On success, append `metadata` completed with `durationMs`, `titleGenerated`, and `branchSlugGenerated`.
   - On timeout or unavailable inference, append `metadata` completed with `reason`.
   - On unexpected metadata generation failure, append `metadata` failed and continue fallback behavior where appropriate.

4. Keep source-of-truth boundaries clean.
   - Thread title remains stored on the `threads` row.
   - Branch name remains stored on the environment/provision command result.
   - Transcript metadata should describe generation outcome, not duplicate durable state unless needed for debugging.

5. Clean up naming in UI copy.
   - Replace "Provisioning environment" with "Provisioning thread" for the operation title.
   - Keep lower-level transcript text specific: worktree, clone, setup, branch, sandbox host.
   - Ensure timeline grouping still collapses all thread-provisioning updates into one stable operation row.

6. Audit and normalize all user-facing provisioning copy.
   - Run `rg -n 'Provisioning|provisioning|Preparing|Thread provisioning|environment provisioning' apps packages`.
   - Classify each hit as internal state, developer/admin error, or user-facing copy.
   - Update user-facing copy to the new language.
   - Keep true environment-specific admin/config errors explicit, such as sandbox backend requirements.
   - Update tests and snapshots so the new language is locked in.

## Tests

Update or add tests for:

- Managed worktree creation records a thread-provisioning row with a metadata step before workspace steps.
- Metadata timeout records a completed metadata step with timeout/fallback metadata and still provisions with `bb/<threadId>`.
- Generated title updates the thread row and emits `title-changed`, without appending `system/thread-title/updated`.
- Failed workspace provisioning still produces one failed thread-provisioning operation and the existing thread error behavior.
- Core UI projects `system/thread-provisioning` into a single collapsed operation row with ordered transcript entries.
- CLI output snapshots render the renamed operation cleanly.
- App prompt-area copy says the thread is being provisioned, not that an environment is being provisioned.
- Error rows use consistent thread-preparation failure language while preserving useful lower-level details.

## Validation

Run targeted checks through Turbo:

```sh
pnpm exec turbo run test --filter=@bb/server -- --run test/threads/generated-branch-names.test.ts
pnpm exec turbo run test --filter=@bb/server -- --run test/public/public-threads.test.ts
pnpm exec turbo run test --filter=@bb/server -- --run test/internal/internal-session.test.ts
pnpm exec turbo run test --filter=@bb/core-ui -- --run test/to-view-messages.test.ts test/thread-detail-rows.test.ts
pnpm exec turbo run test --filter=@bb/app -- --run src/hooks/useWebSocket.test.ts
pnpm exec turbo run test --filter=@bb/ui-core -- --run test/thread-detail-activity.test.ts
pnpm exec turbo run test --filter=@bb/host-daemon -- --run test/command/environment-dispatch.test.ts
pnpm exec turbo run test --filter=@bb/cli -- --run src/__tests__/command-output.test.ts
```

Then run package typechecks:

```sh
pnpm exec turbo run typecheck --filter=@bb/server --filter=@bb/core-ui --filter=@bb/app --filter=@bb/host-daemon --filter=@bb/cli
```

## Exit Criteria

- No code references remain to `system/thread-title/updated`.
- No code references remain to `system/provisioning`.
- All provisioning timeline rendering uses thread-provisioning naming.
- Managed thread creation includes metadata generation in the thread-provisioning transcript.
- Title changes caused by generated metadata still update thread list/detail UI via `title-changed`.
- User-facing copy consistently describes the top-level lifecycle as provisioning a thread and lower-level work as workspace/sandbox/setup details.
- A final `rg` audit has no unreviewed user-facing "provisioning environment" strings.
- The validation commands above pass.
