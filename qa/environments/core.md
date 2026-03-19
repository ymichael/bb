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
- promote and demote a worktree environment and confirm `promote-status` matches underlying git state
- attach a second thread to an existing environment and confirm sibling behavior remains coherent
- spawn two implicit local-environment threads and confirm both attach to the same environment cleanly

## Existing automation

- `apps/server/src/__tests__/e2e/thread-worktree-followup-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-worktree-primary-checkout-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-shared-environment-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-multi-thread-stress.test.ts`

## Current automation

```bash
pnpm qa:environments:core
pnpm qa:environments:attachments
```

`qa:environments:attachments` is the explicit scripted check for implicit local-environment attachment and sibling reuse. It verifies that:

- two implicit local threads attach to the same environment
- those local threads share one active env-daemon session
- sibling follow-ups continue to work after the shared attachment is established

## Manual verification tips

For local attachment and reuse:

```bash
node apps/cli/dist/index.js thread show <thread-id>
```

Compare the `Environment Direct` ID across two implicit local threads. Matching IDs mean both threads attached to the same local environment.

For worktree promotion state:

```bash
node apps/cli/dist/index.js environment promote-status --project <project-id>
node apps/cli/dist/index.js environment promote <environment-id> --thread <thread-id>
node apps/cli/dist/index.js environment demote --thread <thread-id>
```

## Related docs

- [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
