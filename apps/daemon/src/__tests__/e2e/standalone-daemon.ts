import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "../../../../..");

export interface StandaloneDaemonHandle {
  pid: number | undefined;
  /** Snapshot child PIDs before the daemon exits (they get reparented to PID 1 after). */
  snapshotChildPids(): number[];
  waitForExit: () => Promise<number | null>;
  /** Graceful SIGTERM — does NOT kill child processes (env-agents survive for restart tests). */
  stop: () => Promise<void>;
  /** SIGTERM + force-kill entire process tree. Use in finally blocks for test cleanup. */
  stopAndCleanup: () => Promise<void>;
}

function resolveDaemonLaunchTarget(): { command: string; args: string[] } {
  const distEntry = resolve(WORKSPACE_ROOT, "apps/daemon/dist/index.js");
  if (!existsSync(distEntry)) {
    throw new Error(
      `Daemon dist entry not found at ${distEntry}. Run "pnpm exec turbo run build --filter=@beanbag/daemon" first.`,
    );
  }
  return { command: process.execPath, args: [distEntry] };
}

export function collectChildPids(rootPid: number): number[] {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
    });
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
    const all = new Set<number>();
    const queue = [rootPid];
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
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startStandaloneDaemon(args: {
  port: number;
  env: NodeJS.ProcessEnv;
}): StandaloneDaemonHandle {
  const launchTarget = resolveDaemonLaunchTarget();
  const child = spawn(
    launchTarget.command,
    [...launchTarget.args, "--port", String(args.port)],
    {
      cwd: WORKSPACE_ROOT,
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();

  return {
    pid: child.pid,
    snapshotChildPids(): number[] {
      return child.pid ? collectChildPids(child.pid) : [];
    },
    waitForExit: async () => {
      if (child.exitCode !== null) {
        return child.exitCode;
      }
      return new Promise((resolveClose) => {
        child.once("close", (exitCode) => resolveClose(exitCode));
      });
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((r) => { child.once("close", () => r()); }),
        new Promise<void>((r) => setTimeout(r, 3_000)),
      ]);
    },
    stopAndCleanup: async () => {
      // Snapshot child PIDs BEFORE killing — once the daemon exits,
      // children get reparented to PID 1 and we can't find them.
      const childPids = child.pid ? collectChildPids(child.pid) : [];

      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((r) => { child.once("close", () => r()); }),
          new Promise<void>((r) => setTimeout(r, 3_000)),
        ]);
      }

      // Kill any orphaned children (env-agents, codex processes)
      for (const pid of childPids.reverse()) {
        if (isAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
        }
      }
    },
  };
}
