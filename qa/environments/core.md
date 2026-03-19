# Environments Core QA

Use this pass for changes to environment provisioning, reuse, and resume behavior.

## Covers

- environment creation and attachment
- worktree flow sanity
- shared-environment reuse expectations
- resumed work attaching to the correct environment state

## Core scenarios

- spawn one worktree thread and verify the environment attachment is visible
- follow up on a worktree thread after it reaches `idle`
- archive a worktree thread and confirm new work is rejected while archived
- unarchive the thread and confirm follow-up works again
- promote and demote a worktree thread and confirm `promote-status` matches underlying git state
- attach a second thread to an existing environment and confirm sibling behavior remains coherent
- spawn two implicit local-environment threads and confirm both attach to the same environment cleanly

## Existing automation

- `apps/server/src/__tests__/e2e/thread-worktree-followup-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-worktree-primary-checkout-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-shared-environment-roundtrip.test.ts`

## Related docs

- [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
