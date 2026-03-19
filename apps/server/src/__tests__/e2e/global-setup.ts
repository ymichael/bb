import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

  const configuredTmpRoot = process.env.BB_TEST_TMP_ROOT?.trim();
  const tmpRoot =
    configuredTmpRoot && configuredTmpRoot.length > 0
      ? resolve(configuredTmpRoot)
      : mkdtempSync(join(tmpdir(), "bb-test-runs-"));
  mkdirSync(tmpRoot, { recursive: true });
  process.env.BB_TEST_TMP_ROOT = tmpRoot;

  const environmentDaemonRoot = resolve(process.cwd(), "../../packages/environment-daemon");
  const bundlePath = resolve(environmentDaemonRoot, "dist/environment-daemon.bundle.mjs");
  const sourceLatestMs = Math.max(
    latestModifiedAtMs(resolve(environmentDaemonRoot, "src")),
    latestModifiedAtMs(resolve(environmentDaemonRoot, "package.json")),
    latestModifiedAtMs(resolve(environmentDaemonRoot, "tsconfig.json")),
  );
  const bundleIsCurrent =
    existsSync(bundlePath) && statSync(bundlePath).mtimeMs >= sourceLatestMs;
  if (!bundleIsCurrent) {
    execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@bb/environment-daemon"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
  }

  // Return a teardown function that runs the cleanup script as a safety net.
  // This catches orphaned processes left behind by tests that were killed by
  // vitest timeout or crashed before their own cleanup ran.
  return function globalTeardown(): void {
    const cleanupScript = resolve(workspaceRoot, "scripts", "qa", "cleanup-bb-test-processes.mjs");
    if (!existsSync(cleanupScript)) {
      return;
    }

    const args = [
      cleanupScript,
      "--tmp-root",
      tmpRoot,
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
