import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export const workspaceTestAliases = {
  "@beanbag/agent-core": path.resolve(repoRoot, "packages/agent-core/src/index.ts"),
  "@beanbag/environment": path.resolve(repoRoot, "packages/environment/src/index.ts"),
  "@beanbag/environment-agent": path.resolve(
    repoRoot,
    "packages/environment-agent/src/index.ts",
  ),
  "@beanbag/agent-server": path.resolve(repoRoot, "packages/agent-server/src/index.ts"),
  "@beanbag/db": path.resolve(repoRoot, "packages/db/src/index.ts"),
  "@beanbag/daemon": path.resolve(repoRoot, "apps/daemon/src/index.ts"),
  "@beanbag/cli": path.resolve(repoRoot, "apps/cli/src/index.ts"),
  "@beanbag/ui-core": path.resolve(repoRoot, "packages/ui-core/src/index.ts"),
} as const;
