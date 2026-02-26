# Daemon Caffeinate Plan for Active Workers

## Goal

Prevent the machine from entering idle sleep while daemon worker processes are active, then release sleep inhibition as soon as no workers are running.

## Scope

- Implement in daemon process lifecycle only (`apps/daemon`).
- Target macOS via `caffeinate`.
- Keep behavior unchanged on non-macOS platforms.
- Do not fail worker startup if `caffeinate` is unavailable.

## Implementation Steps

1. Add a sleep inhibitor utility in `apps/daemon/src` (for example, `sleep-inhibitor.ts`) with:
   - `acquire(threadId: string): void`
   - `release(threadId: string): void`
   - `releaseAll(): void`
   - Internal tracking for active thread IDs and a single `caffeinate` child process.
2. Start `caffeinate` only on active-thread transition `0 -> 1`:
   - Guard on `process.platform === "darwin"`.
   - Spawn `caffeinate -i -w <daemonPid>` with ignored stdio so inhibitor exits automatically if daemon dies.
   - Log a single warning if the command is missing or spawn fails.
3. Stop `caffeinate` on transition `1 -> 0`:
   - Kill the `caffeinate` child with `SIGTERM`.
   - Wait up to 2 seconds; escalate to `SIGKILL` if still alive.
   - Clear process handle defensively on exit/error.
4. Wire the inhibitor into `ThreadManager` lifecycle in `apps/daemon/src/thread-manager.ts`:
   - Acquire after a worker process is successfully registered in `this.processes`.
   - Release in `_handleProcessExit`.
   - Release all during `stopAll()` and any broad cleanup path.
5. Keep lifecycle robust:
   - Ignore duplicate `acquire`/`release` calls for the same thread ID.
   - Ensure cleanup is idempotent so shutdown and exit handlers can call it safely.
6. Add timeout and reconciliation guards for lock-release failures:
   - Maintain lock metadata (`acquiredAt`, `lastObservedActiveAt`) per thread ID.
   - Run a watchdog every 30 seconds to reconcile lock state against active thread processes.
   - If a lock has no matching active process, keep it in grace for up to 5 minutes, then force-release.
   - If `locks.size > 0` while `activeProcessCount === 0` for over 60 seconds, run `releaseAll()` and stop `caffeinate`.
   - Verify process liveness before retaining locks; if PID is gone, treat lock as stale and release.
7. Add structured logs for observability:
   - Emit lock lifecycle events: `acquire`, `release`, `force_release`, `watchdog_reconcile`.
   - Emit inhibitor lifecycle events: `caffeinate_started`, `caffeinate_stopped`, `caffeinate_stop_timeout`.

## Validation

1. Add unit tests for transition behavior:
   - `0->1` starts one `caffeinate` process.
   - `1->2` does not start another process.
   - `2->1` keeps inhibitor active.
   - `1->0` stops inhibitor.
2. Add/extend `ThreadManager` tests to verify acquire/release calls on:
   - Spawn success
   - Process exit
   - `stopAll()`
3. Add timeout/failure-path tests:
   - Stale lock (no active process) is force-released after the 5-minute grace window.
   - Global mismatch (`locks > 0`, no active processes) triggers `releaseAll()` after 60 seconds.
   - `caffeinate` stop path escalates `SIGTERM -> SIGKILL` after 2 seconds.
   - Duplicate releases remain no-op and do not underflow lock state.
4. Manual validation on macOS:
   - Start daemon, spawn one thread, verify `caffeinate` appears in process list.
   - Spawn/stop multiple threads, verify only one inhibitor process exists.
   - Simulate failed release path and verify watchdog eventually clears lock and exits inhibitor.
   - Stop all threads, verify inhibitor process exits.

## Open Questions/Risks

- Confirm whether `-i` (idle sleep prevention) is sufficient, or if policy later requires display sleep prevention as well.
- Confirm final timeout constants (`30s` watchdog, `5m` stale lock grace, `60s` global mismatch reset, `2s` stop grace) before implementation.
