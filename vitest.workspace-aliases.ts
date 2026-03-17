import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export const workspaceTestAliases = {
  "@bb/core/storage-paths": path.resolve(
    repoRoot,
    "packages/core/src/storage-paths.ts",
  ),
  "@bb/core": path.resolve(repoRoot, "packages/core/src/index.ts"),
  "@bb/environment": path.resolve(repoRoot, "packages/environment/src/index.ts"),
  "@bb/environment-daemon": path.resolve(
    repoRoot,
    "packages/environment-daemon/src/index.ts",
  ),
  "@bb/provider-adapters": path.resolve(
    repoRoot,
    "packages/provider-adapters/src/index.ts",
  ),
  "@bb/templates": path.resolve(repoRoot, "packages/templates/src/index.ts"),
  "@bb/db": path.resolve(repoRoot, "packages/db/src/index.ts"),
  "@bb/server": path.resolve(repoRoot, "apps/server/src/index.ts"),
  "@bb/cli": path.resolve(repoRoot, "apps/cli/src/index.ts"),
  "@bb/ui-core": path.resolve(repoRoot, "packages/ui-core/src/index.ts"),
} as const;
