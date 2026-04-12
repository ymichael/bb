# Generated Branch Names

## Goal

Improve server-generated branch names for managed environments by reusing the
thread metadata generation path, while preserving deterministic fallbacks and
the current uniqueness guarantee.

Managed worktree and clone branches should become operator-friendly, for
example:

- `bb/fix-login-flow-thr_abc123def456`
- `bb/update-thread-rename-thr_abc123def456`

If metadata generation is unavailable, invalid, or too slow, branch creation
must still proceed with the existing `bb/<threadId>` fallback.

## Current State

- [apps/server/src/services/threads/thread-create-helpers.ts](/Users/michael/.codex/worktrees/f65e/bb/apps/server/src/services/threads/thread-create-helpers.ts)
  owns `buildManagedBranchName(threadId)`, which currently returns
  `bb/${threadId}`.
- The branch name is injected into `environment.provision` before the daemon
  creates a managed worktree or clone.
- The direct managed create path uses `buildManagedBranchName(thread.id)` in
  [apps/server/src/services/threads/thread-create.ts](/Users/michael/.codex/worktrees/f65e/bb/apps/server/src/services/threads/thread-create.ts).
- The sandbox-host path also uses `buildManagedBranchName(thread.id)` after the
  thread record exists, but before provisioning is requested.
- Managed reprovisioning reuses `environment.branchName`; if the stored branch
  is missing, it falls back to `buildManagedBranchName(args.thread.id)` in
  [apps/server/src/services/environments/environment-provisioning.ts](/Users/michael/.codex/worktrees/f65e/bb/apps/server/src/services/environments/environment-provisioning.ts).
- [apps/server/src/services/threads/title-generation.ts](/Users/michael/.codex/worktrees/f65e/bb/apps/server/src/services/threads/title-generation.ts)
  derives a prompt fallback synchronously, then asynchronously calls
  `inferenceComplete` with the `generateThreadMetadata` template to produce a
  title.
- [packages/templates/src/templates/generate-thread-metadata.md](/Users/michael/.codex/worktrees/f65e/bb/packages/templates/src/templates/generate-thread-metadata.md)
  currently asks only for `title`.

## Key Constraint

The current title generator runs fire-and-forget after thread creation. Branch
names are needed before managed provisioning is queued, so branch names cannot
piggyback on the existing asynchronous update as-is.

Renaming the git branch after title generation would require a daemon command,
workspace git state changes, persisted environment updates, and reconnect
reconciliation. That is a larger lifecycle feature than this branch-name
improvement needs.

## Proposed Design

Refactor "title generation" into a small "thread metadata generation" service
that can produce both:

- `title`: display title, same behavior as today
- `branchSlug`: lowercase branch-safe slug used as a hint for managed branch
  names

The model output must be treated as advisory. The server should always sanitize
it before using it in a git ref. If inference fails, is unavailable, times out,
or returns an unusable slug, branch creation falls back to `bb/<threadId>`.

### Branch Name Format

Use:

```text
bb/<slug>-<threadId>
```

When no usable generated slug exists, keep the existing fallback:

```text
bb/<threadId>
```

Keeping the full thread ID in the branch name preserves the existing uniqueness
property and avoids needing a branch-name availability query before
provisioning.

### Slug Rules

Add a deterministic slug helper owned by the server thread-create/metadata
code:

- lowercase
- ASCII alphanumeric plus `-`
- collapse repeated separators
- trim separators
- cap the slug length before appending the thread ID
- reject empty slugs

Do not trust model output directly. Run generated slugs through the sanitizer
before branch-name construction. Do not synthesize a descriptive branch slug
from local prompt/title fallback when inference is unavailable; use
`bb/<threadId>` instead.

### Metadata Generation Flow

1. Extend the `generateThreadMetadata` template to ask for both `title` and
   `branchSlug`.
2. Extend the TypeBox schema in `title-generation.ts` to accept optional
   `title` and `branchSlug`.
3. Add named internal types for metadata generation inputs/results rather than
   inline function argument types.
4. Add a reusable helper that returns normalized metadata:
   - generated title, if eligible and available
   - sanitized generated branch slug, if available
5. Add a short timeout for the pre-provision metadata call so thread creation is
   not held hostage by inference latency. If it times out, proceed with
   `bb/<threadId>`.
6. Keep the existing asynchronous `generateThreadTitle` wrapper for code paths
   that do not need a branch name before provisioning.

## Implementation Plan

### Phase 1: Extract Metadata Helpers

- Rename the local `titleSchema` concept to metadata output.
- Add named types such as `ThreadMetadataGenerationArgs`,
  `GeneratedThreadMetadata`, and `ManagedBranchNameArgs`.
- Add pure helpers for:
  - prompt text cleanup
  - title fallback derivation
  - branch slug sanitization
  - branch name construction
- Update `buildManagedBranchName` to accept a single object argument with
  `threadId` and optional `branchSlug`.
- Keep compatibility at call sites by updating them in the same change.

### Phase 2: Update The Prompt Template

- Change `generate-thread-metadata.md` so the `result` tool returns:
  - `title`: short, clear, 3-7 words, Title Case
  - `branchSlug`: lowercase kebab-case, concise, git-branch-safe
- Regenerate template artifacts through the existing `@bb/templates` build/test
  path rather than hand-editing generated output.

### Phase 3: Integrate Managed Creation

- In direct managed worktree/clone creation, after the thread record exists and
  before `buildEnvironmentProvisionCommand`, resolve branch metadata.
- Use the resolved branch slug in `buildManagedBranchName`.
- If no explicit title was provided and the same metadata call produced a title,
  update the thread title and append the title-updated event, then skip the
  later fire-and-forget title generation for that thread.
- Apply the same pre-provision metadata resolution in the sandbox-host path.
- For unmanaged environments and reused ready environments, keep today’s
  asynchronous title generation behavior because no branch name is being created.

### Phase 4: Reprovision Fallback

- Continue to prefer `environment.branchName` during managed reprovisioning.
- Only when an old/incomplete environment lacks `branchName`, use the new branch
  name builder. Do not recompute descriptive slugs during reprovision; missing
  persisted branch names fall back to `bb/<threadId>`.

### Phase 5: Tests

- Update `apps/server/test/threads/thread-create-helpers.test.ts` for:
  - branch names with a slug plus full thread ID
  - fallback branch names without a slug
  - slug sanitization of spaces, punctuation, repeated separators, and empty
    input
  - uniqueness for equal slugs with different thread IDs
- Update the managed worktree regression in
  `apps/server/test/public/public-thread-lifecycle-regressions.test.ts` so it
  asserts descriptive branch names while still checking uniqueness.
- Add or extend server tests for:
  - no inference configured falls back to `bb/<threadId>`
  - inference timeout or invalid slug falls back to `bb/<threadId>`
  - sandbox-host provisioning uses the same branch-name path
  - managed reprovision preserves an existing stored branch name
  - managed reprovision fallback uses `bb/<threadId>` when the stored branch is
    absent
- Keep inference tests focused on pure behavior and boundary outcomes. Do not
  depend on a live model for ordinary unit tests.

## Exit Criteria

- New managed worktree and managed clone environments receive branch names that
  include a descriptive slug and the full thread ID.
- Existing uniqueness guarantees are preserved for same-title or same-prompt
  threads.
- Invalid or unavailable metadata generation cannot create an invalid git ref
  and cannot block provisioning indefinitely; it falls back to `bb/<threadId>`.
- Existing persisted environment branch names remain authoritative during
  reprovision.
- Unmanaged and reused environments are not renamed or otherwise changed.
- The thread title generation path still updates titles for thread creation
  flows that do not need pre-provision branch metadata.

## Validation

Automated:

- `pnpm exec turbo run test --filter=@bb/templates --filter=@bb/server --force`
- `pnpm exec turbo run typecheck --filter=@bb/templates --filter=@bb/server`

Targeted manual/API validation:

- Start the dev server and host daemon.
- Create a managed worktree thread with an explicit title and verify the queued
  `environment.provision` command uses `bb/<title-slug>-<threadId>`.
- Create a managed worktree thread without a title and verify the branch name is
  derived from generated metadata when inference succeeds.
- Disable or misconfigure inference and verify managed provisioning uses
  `bb/<threadId>`.
- Create two managed worktree threads with the same title and verify both branch
  names are readable and distinct.
- Reprovision an existing managed environment and verify it reuses the persisted
  branch name instead of generating a new one.
