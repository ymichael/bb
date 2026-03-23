import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export const workspaceTestAliases = {
  "@bb/agent-runtime": path.resolve(
    repoRoot,
    "packages/agent-runtime/src/index.ts",
  ),
  "@bb/templates": path.resolve(repoRoot, "packages/templates/src/index.ts"),
  "@bb/db": path.resolve(repoRoot, "packages/db/src/index.ts"),
  "@bb/server": path.resolve(repoRoot, "apps/server/src/index.ts"),
  "@bb/cli": path.resolve(repoRoot, "apps/cli/src/index.ts"),
  "@bb/ui-core": path.resolve(repoRoot, "packages/ui-core/src/index.ts"),
} as const;
