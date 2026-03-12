import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

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

export default function globalSetup(): void {
  const environmentAgentRoot = resolve(process.cwd(), "../../packages/environment-agent");
  const bundlePath = resolve(environmentAgentRoot, "dist/environment-agent.bundle.mjs");
  const sourceLatestMs = Math.max(
    latestModifiedAtMs(resolve(environmentAgentRoot, "src")),
    latestModifiedAtMs(resolve(environmentAgentRoot, "package.json")),
    latestModifiedAtMs(resolve(environmentAgentRoot, "tsconfig.json")),
  );
  const bundleIsCurrent =
    existsSync(bundlePath) && statSync(bundlePath).mtimeMs >= sourceLatestMs;
  if (bundleIsCurrent) {
    return;
  }

  execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@beanbag/environment-agent"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}
