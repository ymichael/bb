# Split Large Runtime And Timeline Files

## Goal

Reduce the largest runtime, timeline, and integration files into focused modules
that can be reviewed and maintained independently, without changing behavior.

The work should land as a sequence of small commits. Each commit should have one
clear responsibility, keep tests green, and avoid mixing mechanical file moves
with behavior changes.

## Why This Matters

Several files now exceed the size where local reasoning stays reliable:

- `packages/agent-runtime/src/runtime.test.ts`
- `packages/agent-runtime/src/integration.test.ts`
- `packages/core-ui/test/to-view-messages.test.ts`
- `apps/server/test/public/public-threads.test.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/core-ui/src/to-view-messages.ts`
- `tests/integration/real/provider-smoke.test.ts`

The immediate risk is not line count alone. The risk is mixed responsibility:
one file often contains harness setup, unrelated behavior groups, regression
tests, diagnostics, and production logic in the same scroll.

## Constraints

- Split file by file, not as one broad commit.
- Prefer mechanical moves first; keep behavior-preserving commits separate from
  any cleanup commits.
- Keep provider loops where they enforce cross-provider parity.
- Do not split tests by provider unless provider-specific behavior is genuinely
  different.
- Avoid production extractions that create a giant mutable runtime context
  object. A smaller file is not an improvement if every helper now accepts half
  of runtime state.
- Each commit must have a local validation command.

## Commit Plan

### Commit 1: Extract `runtime.test.ts` shared harness

Create `packages/agent-runtime/src/test/runtime-test-harness.ts` for shared
runtime-test helpers:

- fake provider process setup
- JSON-RPC send helpers
- `waitForCondition`
- recorded-command lookup helpers
- repeated message/event builders

Keep all tests in `runtime.test.ts` in this commit. This commit should be a pure
helper extraction.

Validation:

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`

### Commit 2: Split synthetic ack runtime tests

Move synthetic user-message ack lifecycle coverage from `runtime.test.ts` into:

- `packages/agent-runtime/src/runtime.synthetic-user-message-acks.test.ts`

This file should cover:

- turn-start synthetic acks
- steer synthetic acks
- completion-before-start races
- stop-before-start cleanup
- duplicate concurrent steers
- provider rejection cleanup

Validation:

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`

### Commit 3: Split runtime command-contract tests

Move runtime contract and capability enforcement tests into:

- `packages/agent-runtime/src/runtime.command-contract.test.ts`

This file should cover:

- required adapter commands returning `null`
- unsupported rename behavior
- unsupported execution options
- active stop returning `null`
- explicit idle stop no-op behavior

Validation:

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`

### Commit 4: Split remaining runtime behavior families

Move the remaining major `runtime.test.ts` groups into focused files:

- `runtime.lifecycle.test.ts`
- `runtime.tool-calls.test.ts`
- `runtime.interactive-requests.test.ts`
- `runtime.process-lifecycle.test.ts`
- `runtime.multi-thread.test.ts`

Leave `runtime.test.ts` either deleted or reduced to truly general runtime
coverage that does not belong to a clearer category.

Validation:

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`

### Commit 5: Extract `integration.test.ts` harness

Create an integration helper module, for example:

- `packages/agent-runtime/src/test/runtime-integration-harness.ts`

Move shared integration-only helpers:

- `createTestRuntime`
- provider diagnostics
- wait helpers
- event/text helpers
- common approval helpers
- temporary file/token helpers

Keep test cases in `integration.test.ts` in this commit.

Validation:

- `pnpm exec turbo run test:integration --filter=@bb/agent-runtime --force`

### Commit 6: Split `integration.test.ts` by behavior

Split agent-runtime integration scenarios into focused files:

- `integration.provider-basic.test.ts`
- `integration.workspace-cwd.test.ts`
- `integration.interactive-requests.test.ts`
- `integration.resume.test.ts`
- `integration.multi-provider.test.ts`

Keep the per-provider loop in `integration.provider-basic.test.ts` so Codex,
Claude Code, and Pi continue to share the same command coverage floor.

Validation:

- `pnpm exec turbo run test:integration --filter=@bb/agent-runtime --force`

### Commit 7: Split `to-view-messages.test.ts` turn and client-input tests

Move the highest-churn timeline tests first:

- `to-view-messages.turn-lifecycle.test.ts`
- `to-view-messages.client-input.test.ts`

Use the existing `packages/core-ui/test/timeline-test-harness.ts` rather than
creating a parallel harness.

Validation:

- `pnpm exec turbo run test --filter=@bb/core-ui --force`

### Commit 8: Split remaining `to-view-messages.test.ts` behavior groups

Move the rest of the large projection groups into:

- `to-view-messages.assistant-streams.test.ts`
- `to-view-messages.tool-activity.test.ts`
- `to-view-messages.operations.test.ts`
- `to-view-messages.approvals.test.ts`
- `to-view-messages.debug.test.ts`

Leave `to-view-messages.test.ts` deleted or reduced to smoke coverage only.

Validation:

- `pnpm exec turbo run test --filter=@bb/core-ui --force`

### Commit 9: Split `public-threads.test.ts` helpers

Create server route test helpers under `apps/server/test/public/`, for example:

- `public-thread-test-harness.ts`
- `public-thread-git-fixtures.ts`
- `public-thread-assertions.ts`

Move helper types and functions only:

- git fixture creation
- wait helpers
- sandbox-host mock helpers
- clean workspace status fixtures

Keep test cases in `public-threads.test.ts` in this commit.

Validation:

- `pnpm exec turbo run test --filter=@bb/server --force`

### Commit 10: Split `public-threads.test.ts` route scenarios

Split public thread route tests by product behavior:

- `public-threads.creation.test.ts`
- `public-threads.defaults.test.ts`
- `public-threads.environments.test.ts`
- `public-threads.sandbox-host.test.ts`
- `public-threads.send-and-steer.test.ts`
- `public-threads.archive-delete-cleanup.test.ts`
- `public-threads.manager-and-ownership.test.ts`

Validation:

- `pnpm exec turbo run test --filter=@bb/server --force`

### Commit 11: Extract real-provider smoke harness

Move real-provider shared helpers from
`tests/integration/real/provider-smoke.test.ts` into:

- `tests/integration/real/provider-smoke-harness.ts`

This should include:

- provider ids and execution options
- prerequisite checks
- `createRealThread`
- send/wait helpers
- event diagnostics

Keep tests in `provider-smoke.test.ts` in this commit.

Validation:

- `pnpm exec turbo run typecheck --filter=@bb/integration-tests`
- `pnpm exec turbo run test:integration --filter=@bb/integration-tests --force`

### Commit 12: Split real-provider smoke scenarios

Split real-provider tests into:

- `provider-turns.test.ts`
- `provider-control.test.ts`
- `provider-workspace.test.ts`
- `provider-registry.test.ts`
- `provider-concurrency.test.ts`

Keep provider harnesses isolated so file-level concurrency does not share data
directories or mutable provider state.

Validation:

- `pnpm exec turbo run test:integration --filter=@bb/integration-tests --force`

### Commit 13: Extract small production helpers from `runtime.ts`

Extract low-risk pure helpers from `packages/agent-runtime/src/runtime.ts`:

- `execution-options.ts`
- `thread-shell-environment.ts`
- `thread-identity.ts`

Do not move the main runtime command methods yet. Keep this commit limited to
pure helpers and type definitions that do not need runtime closure state.

Validation:

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`
- `pnpm exec turbo run typecheck --filter=@bb/agent-runtime`

### Commit 14: Evaluate `runtime.ts` event translation extraction

Attempt to extract provider event translation only if it can move cleanly
without passing a large mutable context object. Candidate file:

- `runtime-event-translation.ts`

If the extraction requires passing most runtime maps and callbacks around, stop
and leave this as a documented follow-up instead of forcing a worse abstraction.

Validation:

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`
- `pnpm exec turbo run test:integration --filter=@bb/agent-runtime --force`

### Commit 15: Extract user-message projection helpers from `to-view-messages.ts`

Move user-message projection and dedup helpers from
`packages/core-ui/src/to-view-messages.ts` into focused modules:

- `user-message-dedup.ts`
- keep using `pending-client-requested-messages.ts`

The main `to-view-messages.ts` file should keep orchestration, while the helper
module owns signature counts and client/provider dedup decisions.

Validation:

- `pnpm exec turbo run test --filter=@bb/core-ui --force`
- `pnpm exec turbo run typecheck --filter=@bb/core-ui`

### Commit 16: Extract remaining projection subdomains

Split remaining projection helper clusters only where boundaries are clean:

- `tool-activity-projection.ts`
- `assistant-stream-projection.ts`
- `operation-projection.ts`

The final `to-view-messages.ts` should read as the event orchestration loop and
projection assembly, not as every projection implementation.

Validation:

- `pnpm exec turbo run test --filter=@bb/core-ui --force`
- `pnpm exec turbo run typecheck --filter=@bb/core-ui`

## Exit Criteria

This plan is complete when:

- each listed large file is either split or explicitly documented as not worth
  splitting further
- every commit has a single clear responsibility
- no commit mixes mechanical file movement with behavior changes
- tests remain green after each file-family split
- final line counts are meaningfully lower for the original files
- shared test helpers are reused instead of duplicated across the new files
- no production extraction introduces a broad mutable context object just to
  make files smaller

## Final Validation

Run these after the full sequence:

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`
- `pnpm exec turbo run test:integration --filter=@bb/agent-runtime --force`
- `pnpm exec turbo run test --filter=@bb/core-ui --force`
- `pnpm exec turbo run test --filter=@bb/server --force`
- `pnpm exec turbo run typecheck --filter=@bb/integration-tests`
- `pnpm exec turbo run test:integration --filter=@bb/integration-tests --force`
- `git diff --check`

## Review Notes

Reviewers should be able to review most commits as pure moves. For those
commits, useful review questions are:

- Did behavior stay identical?
- Did any helper become less local or less readable?
- Did the split create duplicate fixtures or divergent patterns?
- Does the new file name match the behavior it owns?

For production extraction commits, reviewers should additionally ask:

- Did the extraction remove real complexity?
- Are ownership boundaries clearer?
- Did the public/internal contract stay unchanged?
- Did the extraction avoid passing around broad runtime state?
