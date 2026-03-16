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

function collectProcessTree(rootPids: number[]): number[] {
  // Build a full process tree from tracked root PIDs so we also kill
  // grandchild processes (e.g. fake-codex spawned by env-agents).
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    const childrenByParent = new Map<number, number[]>();
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number.parseInt(match[1]!, 10);
      const ppid = Number.parseInt(match[2]!, 10);
      const siblings = childrenByParent.get(ppid) ?? [];
      siblings.push(pid);
      childrenByParent.set(ppid, siblings);
    }
    const all = new Set(rootPids);
    const queue = [...rootPids];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      for (const child of childrenByParent.get(pid) ?? []) {
        if (!all.has(child)) {
          all.add(child);
          queue.push(child);
        }
      }
    }
    return [...all];
  } catch {
    return rootPids;
  }
}

function killTrackedPids(): void {
  // Expand tracked PIDs to include their full process trees (children, grandchildren).
  const pids = collectProcessTree([...trackedPids]).reverse();

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
