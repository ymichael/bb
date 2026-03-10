import { spawn } from "node:child_process";
import type { EnvironmentCheckoutSnapshot } from "@beanbag/environment";

const defaultBranchByRepoRoot = new Map<string, string | undefined>();

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

export function detectProjectDefaultBranch(repoRoot: string): string | undefined {
  return defaultBranchByRepoRoot.get(repoRoot);
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
    const branch = remoteHead.stdout.slice("refs/remotes/origin/".length);
    defaultBranchByRepoRoot.set(repoRoot, branch);
    return branch;
  }
  if ((await runGitAtPathAsync(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/main"])).ok) {
    defaultBranchByRepoRoot.set(repoRoot, "main");
    return "main";
  }
  if ((await runGitAtPathAsync(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/master"])).ok) {
    defaultBranchByRepoRoot.set(repoRoot, "master");
    return "master";
  }
  defaultBranchByRepoRoot.set(repoRoot, undefined);
  return undefined;
}

export async function resolveProjectCheckoutSnapshotAsync(
  repoRoot: string,
): Promise<EnvironmentCheckoutSnapshot> {
  const headResult = await runGitAtPathAsync(repoRoot, ["rev-parse", "HEAD"]);
  if (!headResult.ok || !headResult.stdout) {
    throw new Error("Failed to resolve HEAD");
  }

  const branchResult = await runGitAtPathAsync(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
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

export async function checkoutProjectSnapshotAsync(
  repoRoot: string,
  snapshot: EnvironmentCheckoutSnapshot,
): Promise<void> {
  const branch = snapshot.branch?.trim();
  if (
    branch &&
    (await runGitAtPathAsync(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok
  ) {
    const branchCheckout = await runGitAtPathAsync(repoRoot, [
      "checkout",
      "--ignore-other-worktrees",
      branch,
    ]);
    if (branchCheckout.ok) return;
  }

  const detachedCheckout = await runGitAtPathAsync(repoRoot, [
    "checkout",
    "--detach",
    snapshot.head,
  ]);
  if (!detachedCheckout.ok) {
    throw new Error(detachedCheckout.stderr || "Failed to checkout detached HEAD");
  }
}

export async function resolveProjectDefaultBranchCheckoutAsync(
  repoRoot: string,
): Promise<EnvironmentCheckoutSnapshot | undefined> {
  const defaultBranch =
    detectProjectDefaultBranch(repoRoot) ?? await detectProjectDefaultBranchAsync(repoRoot);
  if (!defaultBranch) return undefined;
  if (!(await runGitAtPathAsync(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${defaultBranch}`])).ok) {
    return undefined;
  }
  const headResult = await runGitAtPathAsync(repoRoot, ["rev-parse", defaultBranch]);
  if (!headResult.ok || !headResult.stdout) return undefined;
  return {
    branch: defaultBranch,
    head: headResult.stdout,
    detached: false,
  };
}

export async function discardProjectLocalChangesAsync(repoRoot: string): Promise<void> {
  const reset = await runGitAtPathAsync(repoRoot, ["reset", "--hard"]);
  if (!reset.ok) {
    throw new Error(reset.stderr || "Failed to reset primary checkout");
  }
  const clean = await runGitAtPathAsync(repoRoot, ["clean", "-fd"]);
  if (!clean.ok) {
    throw new Error(clean.stderr || "Failed to clean primary checkout");
  }
}
