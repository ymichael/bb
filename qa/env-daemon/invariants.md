# Env-Daemon Invariants

These are the durable env-daemon runtime behaviors that QA should assert.

Use these invariants when writing new env-daemon scenarios or deciding whether a failure belongs to `env-daemon/` instead of `server/`.

## Principles

- assert eventual runtime convergence, not exact heartbeat timing
- treat one authoritative session per thread as a core correctness property
- use session inspection and SQLite as supporting evidence after the operator-visible behavior is understood

## Invariants

### 1. At most one live session controls a thread at a time

A thread may have historical session rows, but there must not be multiple competing live sessions for the same thread.

Implications:

- late old-agent traffic must not take over a recovered thread
- replacement after restart or worker loss must not create split-brain behavior

### 2. Active work converges after restart or reconnect

If active work is interrupted by server restart or runtime loss, the system must converge cleanly.

Examples:

- surviving daemon reconnect may allow the thread to continue and finish normally
- missing worker paths must converge to explicit `error`, not hang forever or silently appear healthy

### 3. Recovery from worker loss is explicit and actionable

When runtime recovery fails, the operator must see a clear failure and be able to recover with supported follow-up flows.

Examples:

- missing-worker restart converges to `error`
- the surfaced error indicates provider or worker unavailability
- a later follow-up can bring the thread back to a healthy state when recovery succeeds

### 4. Idle follow-up and session retirement remain clean

When a thread returns to `idle`, later follow-up work must start cleanly without leaving duplicate live session state behind.

Examples:

- immediate follow-up after idle does not fail with session-closed behavior
- restart-then-follow-up on an idle thread creates or attaches to the correct fresh session
- historical session rows are acceptable; duplicate active rows are not

### 5. Queued work is not silently lost and stale traffic is ignored

Queued work during failure must not be silently dropped, and stale traffic from replaced sessions must not mutate recovered thread state.

Examples:

- queued follow-up during worker loss is preserved, failed explicitly, or requires a clear recovery action
- old-agent noise may appear in logs, but only the current accepted session can move the thread forward
