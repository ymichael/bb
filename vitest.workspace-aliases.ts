import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export const workspaceTestAliases = {
  "@bb/agent-runtime/test": path.resolve(
    repoRoot,
    "packages/agent-runtime/src/test/index.ts",
  ),
  "@bb/agent-runtime": path.resolve(
    repoRoot,
    "packages/agent-runtime/src/index.ts",
  ),
  "@bb/config/common": path.resolve(
    repoRoot,
    "packages/config/src/common.ts",
  ),
  "@bb/config/host-daemon": path.resolve(
    repoRoot,
    "packages/config/src/host-daemon.ts",
  ),
  "@bb/domain": path.resolve(repoRoot, "packages/domain/src/index.ts"),
  "@bb/templates": path.resolve(repoRoot, "packages/templates/src/index.ts"),
  "@bb/db": path.resolve(repoRoot, "packages/db/src/index.ts"),
  "@bb/host-daemon-contract": path.resolve(
    repoRoot,
    "packages/host-daemon-contract/src/index.ts",
  ),
  "@bb/host-daemon/test": path.resolve(
    repoRoot,
    "apps/host-daemon/src/test/index.ts",
  ),
  "@bb/server/test": path.resolve(
    repoRoot,
    "apps/server/src/test/index.ts",
  ),
  "@bb/server": path.resolve(repoRoot, "apps/server/src/index.ts"),
  "@bb/cli": path.resolve(repoRoot, "apps/cli/src/index.ts"),
  "@bb/logger": path.resolve(repoRoot, "packages/logger/src/index.ts"),
  "@bb/ui-core": path.resolve(repoRoot, "packages/ui-core/src/index.ts"),
  "@bb/workspace": path.resolve(repoRoot, "packages/workspace/src/index.ts"),
  "@bb/sandbox-host": path.resolve(
    repoRoot,
    "packages/sandbox-host/src/index.ts",
  ),
  "@bb/config/server": path.resolve(
    repoRoot,
    "packages/config/src/server.ts",
  ),
  "@bb/server-contract": path.resolve(
    repoRoot,
    "packages/server-contract/src/index.ts",
  ),
} as const;
