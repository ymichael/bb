# Daemon / Env-Agent Lifecycle Invariants

This document defines the durable behaviors that daemon/env-agent QA should assert.

Use these invariants to judge correctness during manual QA, harness development, and regression triage.
Do not prefer fragile timing assumptions when one of these stronger checks can be used instead.

## Principles

- Assert **eventual state and allowed transitions**, not exact timing.
- Prefer **supported CLI/API surfaces** for common-path checks.
- Use SQLite or raw logs as a deeper debugging layer, not the first-line operator workflow.
- Treat low-level session data as helpful evidence, but keep the core quality bar centered on user-visible behavior and daemon correctness.

## Core invariants

### 1. Thread state and persisted state must converge

For a given thread, CLI/API-visible state and persisted daemon state must eventually agree.

Examples:
- `thread show` and `thread status` should not disagree on the settled terminal state.
- persisted thread status should converge to the same healthy or error terminal state reflected by the operator-facing surfaces.

### 2. A thread must not silently skip required lifecycle work

A thread must not jump to a healthy terminal state without the lifecycle evidence needed to justify it.

Examples:
- a newly spawned thread should not appear to complete without a real run/turn sequence
- a provisioning-boundary restart must not silently produce `idle` if no real turn actually ran

### 3. At most one live env-agent session may control a thread at a time

A thread may accumulate historical session rows, but there must not be multiple competing live sessions for the same thread.

Implications:
- late old-agent traffic must not take over a recovered thread
- replacement after restart or worker loss must not create split-brain behavior

### 4. Active work must converge after daemon restart

If the daemon restarts while a thread is active, the system must converge cleanly:

- if the original env-agent successfully reconnects within the allowed liveness window, the thread may continue and finish normally
- if it does not reconnect, the thread must converge to a visible error state rather than hanging forever or silently appearing healthy

### 5. Recovery from missing worker must be explicit and actionable

When the active worker is lost and recovery fails, the thread must surface a clear error and remain recoverable by follow-up work.

Examples:
- missing-worker restart should converge to `error`
- error details should indicate provider/worker unavailability rather than leaving the operator with an ambiguous idle state
- a follow-up after that failure should be accepted and bring the thread back to a healthy terminal state when recovery succeeds

### 6. Idle follow-up must start cleanly

A follow-up sent after a thread has already returned to `idle` must not fail because the previous idle session was retired.

Examples:
- immediate follow-up after idle must not fail with session-closed / `agent_shutdown`
- restart-then-follow-up on an idle thread should create or attach to the correct fresh session cleanly

### 7. Session retirement after idle must be clean

When BB intentionally retires the worker after a turn settles back to `idle`, it should do so without leaving duplicate active session state behind.

Implications:
- historical session rows are acceptable
- duplicate active rows are not
- by the time the thread settles to final idle, there may be zero active session rows; that is acceptable if it matches the intended lifecycle semantics

### 8. Stop, archive, unarchive, promote, and demote flows must preserve control-plane correctness

Administrative actions must not leave the thread in a contradictory state.

Examples:
- stop then follow-up should still work
- archive should block new work while archived
- unarchive should not resurrect stale sessions
- promote/demote should match the actual underlying worktree/git state

### 9. Queued or follow-up work must not be silently lost during failure

If work is queued while the active worker is lost, the system must not silently drop that work or execute it against a dead session.

It must instead:
- preserve the queue correctly,
- fail explicitly, or
- require a clear operator-visible recovery action.

### 10. Late stale traffic must be ignored

Once a new valid session is authoritative for a thread, stale traffic from an older session must not mutate thread state, logs, or output in a way that regresses the thread.

## Assertion guidance

Prefer these assertion styles in QA and harness code:

### Good
- “the thread eventually reaches `idle` or a defined `error` state”
- “only one live session is authoritative for the thread at a time”
- “follow-up after restart failure is accepted and converges back to a healthy terminal state”
- “archived threads reject new work with an explicit conflict response”

### Avoid when possible
- fixed sleeps
- exact heartbeat timing expectations
- assumptions that an idle thread must still have a live session at the end of the run
- assertions that depend on daemon log ordering more strictly than the product contract requires

## Recommended evidence order during QA

1. CLI/API-visible thread behavior
2. CLI/API-visible daemon health and status
3. daemon logs
4. session inspection surfaces
5. SQLite inspection for deeper debugging

## Relationship to QA tiers

- **Smoke** should cover the highest-value invariants with the fewest scenarios.
- **Stress** should exercise restart, recovery, and timing-sensitive edges against the same invariants.
- **Regression** should pin previously broken behaviors to stable repro steps and expected invariant outcomes.
