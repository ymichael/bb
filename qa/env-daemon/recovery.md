# Env-Daemon Recovery QA

Use this pass for worker-loss, reconnect, replacement, liveness, and timing-sensitive runtime failures.

## Covers

- surviving env-daemon reconnect after server restart
- missing-worker paths converging to explicit error
- queued work not being silently lost during recovery
- late stale traffic being ignored after replacement
- no split-brain control of one thread

## Recovery scenarios

- local restart while active -> surviving env-daemon reconnect
- local restart while active -> missing env-daemon becomes explicit error
- worktree restart while active -> surviving env-daemon reconnect
- worktree restart while active -> missing env-daemon becomes explicit error
- restart during provisioning boundary or before first real `turn/started`
- queued follow-up present while worker is lost
- late old env-daemon traffic after replacement does not mutate recovered thread state
- archive or unarchive after worker-loss recovery does not resurrect stale session state
- after relaunch, startup logs should show the surviving session being poked or the missing session awaiting timeout handling

## Automation today

Current relevant automation still uses the old naming:

```bash
pnpm qa:env-daemon:recovery
pnpm qa:env-daemon:recovery:fake
```

`qa:env-daemon:recovery` currently points at the deterministic fake-provider recovery suite, because the exact worker-loss and reconnect paths still rely on fake-provider control hooks. Pair it with `pnpm qa:env-daemon:core` when you also want real-provider runtime signal.

The broader transitional script below still exists, but it is not the default recovery entrypoint because several recovery scenarios are still fake-only:

```bash
pnpm qa:server:stress
```

Existing automated slices:

- `apps/server/src/__tests__/e2e/environment-daemon-restart-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-restart-recovery-matrix.test.ts`
- `apps/server/src/__tests__/e2e/thread-recovery-heavy-runbook.test.ts`
- `apps/server/src/__tests__/e2e/thread-provisioning-responsiveness.test.ts`

## Related docs

- [`../shared/standalone-workflow.md`](../shared/standalone-workflow.md)
- [`./invariants.md`](./invariants.md)
- [`./regressions.md`](./regressions.md)
