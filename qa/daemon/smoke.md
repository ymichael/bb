# Daemon / Env-Agent Smoke QA

Use this pass for the fastest high-signal manual validation.

## Goal

Confirm the most important daemon/env-agent flows still work end-to-end against the real provider.

## When to run

- before or after changes to daemon lifecycle logic
- before merging high-risk CLI / daemon changes when a fast manual pass is needed
- as the first pass before deeper stress or regression coverage

## Suggested runtime

- target: 10-20 minutes once the flow is well-practiced

## Required setup

Use the full setup instructions in:
- [`./standalone-daemon-qa.md`](./standalone-daemon-qa.md)

## Automation entrypoint

For the checked-in deterministic harness:

```bash
pnpm qa:daemon:smoke
```

This is the fake-provider automation tier. Use the standalone manual guide for real-provider confirmation.

## Required scenarios

### Local flow
- start thread
- follow-up
- immediate follow-up after idle
- stop then follow-up

### Worktree flow
- start thread
- follow-up
- immediate follow-up after idle
- stop then follow-up
- promote / demote sanity check

### Restart flow
- blocked restart while active work exists
- forced restart while active work exists
- one surviving-worker recovery path
- one missing-worker error path
- follow-up after restart failure

## Primary invariants covered

- thread state converges cleanly
- idle follow-up starts cleanly
- active restart converges to resumed work or explicit error
- missing-worker failure is visible and recoverable
- control-plane actions keep thread/worktree state coherent

## Pass criteria

- all required scenarios complete without ambiguous hangs
- successful cases return to the expected healthy terminal state
- failure cases surface explicit operator-visible errors
- follow-up after failure or stop still works where expected

## If anything fails

Record:
- scenario name
- thread id
- daemon log path
- relevant CLI outputs
- whether the failure looks like product bug, flake, or stale QA expectation

Preferred bundle capture:

```bash
node scripts/qa/capture-thread-failure-bundle.mjs <thread-id> --scenario smoke
```

Then continue the remaining smoke scenarios if the daemon is still usable.
