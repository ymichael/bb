# Env-Daemon Regression QA

Use this doc to capture stable repros for previously discovered env-daemon runtime and recovery bugs.

## Goal

Make sure once an env-daemon recovery, session, or routing bug is fixed, it stays fixed.

## Add regressions here when the bug is primarily about

- worker loss or reconnect behavior
- duplicate or split-brain live sessions
- queued work being lost during recovery
- stale traffic mutating recovered thread state
- multi-provider routing or session-backed tool-call runtime behavior

## Automation today

Current regression-oriented automation is still partly transitional:

```bash
pnpm qa:server:regression
pnpm qa:env-daemon:recovery:fake
```

Use `qa:server:regression` for the current real-provider regression seed suite, and `qa:env-daemon:recovery:fake` when the repro needs deterministic worker-loss control or restart injection.

## Seed areas

- immediate follow-up after idle failing with session-closed behavior
- missing-worker restart incorrectly landing in `idle`
- duplicate live session acceptance after replacement
- queued follow-up being dropped during worker-loss recovery
- archive or unarchive resurrecting stale session state after recovery
- late old-agent traffic mutating recovered thread state
- multi-provider runtime misrouting events or RPC traffic

## Template

### `<regression name>`

- **Source:** `<issue / PR / incident>`
- **Setup:** `<minimal environment assumptions>`
- **Steps:**
  1. ...
  2. ...
  3. ...
- **Expected:**
  - ...
  - ...
- **Protected invariants:**
  - ...
  - ...
