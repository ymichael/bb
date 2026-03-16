/**
 * Global process-exit safety net for E2E test harnesses.
 *
 * Tracks child-process PIDs spawned during test runs and ensures they are
 * killed when the Node process exits — even if the test's own `cleanup()`
 * never runs (e.g., vitest timeout or crash).
 *
 * Usage:
 *   import { trackPid, untrackPid, installProcessExitSafetyNet } from "./process-tracker.js";
 *
 *   installProcessExitSafetyNet();    // once, early
 *   trackPid(child.pid);              // each spawned child
 *   untrackPid(child.pid);            // after successful cleanup
 */

const trackedPids = new Set<number>();
let installed = false;

/** Register a PID for cleanup on process exit. */
export function trackPid(pid: number | undefined): void {
  if (typeof pid === "number" && Number.isFinite(pid)) {
    trackedPids.add(pid);
  }
}

/** Remove a PID from the tracked set (call after successful cleanup). */
export function untrackPid(pid: number | undefined): void {
  if (typeof pid === "number") {
    trackedPids.delete(pid);
  }
}

/** Return a snapshot of all currently tracked PIDs. */
export function getTrackedPids(): number[] {
  return [...trackedPids];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTrackedPids(): void {
  // Kill in reverse order (children before parents).
  const pids = [...trackedPids].reverse();
  for (const pid of pids) {
    try {
      if (isAlive(pid)) {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Process already exited.
    }
  }

  // Give a brief window for SIGTERM, then SIGKILL any survivors.
  // We are in a synchronous exit handler so we cannot await; use a
  // spin-wait with a tiny budget.
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && pids.some(isAlive)) {
    // busy-wait (acceptable in exit path, bounded to 500ms)
  }

  for (const pid of pids) {
    try {
      if (isAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Process already exited.
    }
  }

  trackedPids.clear();
}

/**
 * Install process-exit handlers that kill any tracked PIDs.
 *
 * Safe to call multiple times — only installs once.
 */
export function installProcessExitSafetyNet(): void {
  if (installed) return;
  installed = true;

  // 'exit' fires on normal exit and after SIGTERM/SIGINT default handlers.
  // We cannot do async work here, so best-effort synchronous kill.
  process.on("exit", () => {
    killTrackedPids();
  });

  // Ensure SIGTERM (sent by vitest on timeout) triggers cleanup then exits.
  process.on("SIGTERM", () => {
    killTrackedPids();
    // Re-raise so the default handler terminates the process.
    process.exit(143);
  });

  // Ensure SIGINT (Ctrl-C) triggers cleanup.
  process.on("SIGINT", () => {
    killTrackedPids();
    process.exit(130);
  });
}
