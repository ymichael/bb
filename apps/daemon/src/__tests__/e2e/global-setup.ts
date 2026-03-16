import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import dotenv from "dotenv";

function latestModifiedAtMs(rootPath: string): number {
  const stat = statSync(rootPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of readdirSync(rootPath)) {
    latest = Math.max(latest, latestModifiedAtMs(join(rootPath, entry)));
  }
  return latest;
}

export default function globalSetup(): () => void {
  // Load .env from the workspace root so auth tokens are available for real-provider E2E runs.
  const workspaceRoot = resolve(process.cwd(), "../..");
  dotenv.config({ path: resolve(workspaceRoot, ".env") });

  const environmentAgentRoot = resolve(process.cwd(), "../../packages/environment-agent");
  const bundlePath = resolve(environmentAgentRoot, "dist/environment-agent.bundle.mjs");
  const sourceLatestMs = Math.max(
    latestModifiedAtMs(resolve(environmentAgentRoot, "src")),
    latestModifiedAtMs(resolve(environmentAgentRoot, "package.json")),
    latestModifiedAtMs(resolve(environmentAgentRoot, "tsconfig.json")),
  );
  const bundleIsCurrent =
    existsSync(bundlePath) && statSync(bundlePath).mtimeMs >= sourceLatestMs;
  if (!bundleIsCurrent) {
    execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@beanbag/environment-agent"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
  }

  // Return a teardown function that runs the cleanup script as a safety net.
  // This catches orphaned processes left behind by tests that were killed by
  // vitest timeout or crashed before their own cleanup ran.
  return function globalTeardown(): void {
    const cleanupScript = resolve(workspaceRoot, "scripts", "qa", "cleanup-beanbag-test-processes.mjs");
    if (!existsSync(cleanupScript)) {
      return;
    }

    const tmpRoot = process.env.BEANBAG_TEST_TMP_ROOT?.trim();
    const args = [
      cleanupScript,
      ...(tmpRoot ? ["--tmp-root", tmpRoot] : []),
      "--quiet",
    ];

    try {
      spawnSync(process.execPath, args, {
        cwd: workspaceRoot,
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      // Best-effort cleanup; do not fail the test suite.
    }
  };
}
