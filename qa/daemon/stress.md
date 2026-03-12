# Daemon / Env-Agent Stress QA

Use this pass for restart, recovery, and timing-sensitive lifecycle coverage.

## Goal

Exercise the parts of daemon/env-agent behavior most likely to regress under restart, worker loss, queued work, and lifecycle boundary conditions.

## When to run

- nightly or pre-release manual validation
- after major lifecycle rewrite or recovery-path changes
- when debugging flaky or timing-sensitive daemon behavior

## Suggested runtime

- target: 30-60+ minutes depending on depth

## Required setup

Use the full setup instructions in:
- [`./standalone-daemon-qa.md`](./standalone-daemon-qa.md)

## Automation entrypoint

For the checked-in deterministic harness:

```bash
pnpm qa:daemon:stress
```

This tier is intentionally small and high-value; keep real-provider restart/liveness confirmation in the manual pass when timing sensitivity matters.

## Required scenarios

### Restart and liveness
- local restart while active -> surviving env-agent reconnect
- local restart while active -> missing env-agent becomes error
- worktree restart while active -> surviving env-agent reconnect
- worktree restart while active -> missing env-agent becomes error
- restart during provisioning boundary / before first real `turn/started`

### Idle/session behavior
- local idle restart -> follow-up starts fresh session cleanly
- worktree idle restart -> follow-up starts fresh session cleanly
- local two immediate follow-ups in a row
- worktree two immediate follow-ups in a row

### Recovery-heavy flows
- queued follow-up present while worker is lost
- archive / unarchive after worker-loss recovery
- late old env-agent traffic after replacement does not change thread state

## Primary invariants covered

- at most one authoritative live session per thread
- restart convergence is explicit and recoverable
- queued work is not silently lost
- late stale traffic is ignored
- idle-session retirement and replacement behave cleanly

## Pass criteria

- recovery-heavy scenarios converge to a clear healthy or error outcome
- no split-brain session behavior appears
- no scenario depends on manual DB surgery to continue
- follow-up recovery remains possible after worker-loss error states
