import { spawn, spawnSync } from "node:child_process";
import type { EnvironmentCheckoutSnapshot } from "@beanbag/environment";

function runGitAtPath(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? "",
  };
}

async function runGitAtPathAsync(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function hasLocalBranch(repoRoot: string, branch: string): boolean {
  return runGitAtPath(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

export function detectProjectDefaultBranch(repoRoot: string): string | undefined {
  const remoteHead = runGitAtPath(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }
  if (hasLocalBranch(repoRoot, "main")) return "main";
  if (hasLocalBranch(repoRoot, "master")) return "master";
  return undefined;
}

export async function detectProjectDefaultBranchAsync(
  repoRoot: string,
): Promise<string | undefined> {
  const remoteHead = await runGitAtPathAsync(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }
  if ((await runGitAtPathAsync(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/main"])).ok) {
    return "main";
  }
  if ((await runGitAtPathAsync(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/master"])).ok) {
    return "master";
  }
  return undefined;
}

export function resolveProjectCheckoutSnapshot(repoRoot: string): EnvironmentCheckoutSnapshot {
  const headResult = runGitAtPath(repoRoot, ["rev-parse", "HEAD"]);
  if (!headResult.ok || !headResult.stdout) {
    throw new Error("Failed to resolve HEAD");
  }

  const branchResult = runGitAtPath(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.ok && branchResult.stdout) {
    return {
      branch: branchResult.stdout,
      head: headResult.stdout,
      detached: false,
    };
  }

  return {
    head: headResult.stdout,
    detached: true,
  };
}

export function checkoutProjectSnapshot(
  repoRoot: string,
  snapshot: EnvironmentCheckoutSnapshot,
): void {
  const branch = snapshot.branch?.trim();
  if (branch && hasLocalBranch(repoRoot, branch)) {
    const branchCheckout = runGitAtPath(repoRoot, ["checkout", "--ignore-other-worktrees", branch]);
    if (branchCheckout.ok) return;
  }

  const detachedCheckout = runGitAtPath(repoRoot, ["checkout", "--detach", snapshot.head]);
  if (!detachedCheckout.ok) {
    throw new Error(detachedCheckout.stderr || "Failed to checkout detached HEAD");
  }
}

export function resolveProjectDefaultBranchCheckout(
  repoRoot: string,
): EnvironmentCheckoutSnapshot | undefined {
  const defaultBranch = detectProjectDefaultBranch(repoRoot);
  if (!defaultBranch) return undefined;
  if (!hasLocalBranch(repoRoot, defaultBranch)) return undefined;
  const headResult = runGitAtPath(repoRoot, ["rev-parse", defaultBranch]);
  if (!headResult.ok || !headResult.stdout) return undefined;
  return {
    branch: defaultBranch,
    head: headResult.stdout,
    detached: false,
  };
}

export function discardProjectLocalChanges(repoRoot: string): void {
  const reset = runGitAtPath(repoRoot, ["reset", "--hard"]);
  if (!reset.ok) {
    throw new Error(reset.stderr || "Failed to reset primary checkout");
  }
  const clean = runGitAtPath(repoRoot, ["clean", "-fd"]);
  if (!clean.ok) {
    throw new Error(clean.stderr || "Failed to clean primary checkout");
  }
}
