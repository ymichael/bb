import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export const workspaceTestAliases = {
  "@bb/agent-providers": path.resolve(
    repoRoot,
    "packages/agent-providers/src/index.ts",
  ),
  "@bb/agent-provider-auth": path.resolve(
    repoRoot,
    "packages/agent-provider-auth/src/index.ts",
  ),
  "@bb/secret-storage": path.resolve(
    repoRoot,
    "packages/secret-storage/src/index.ts",
  ),
  "@bb/agent-runtime/test": path.resolve(
    repoRoot,
    "packages/agent-runtime/src/test/index.ts",
  ),
  "@bb/agent-runtime/capture": path.resolve(
    repoRoot,
    "packages/agent-runtime/src/capture.ts",
  ),
  "@bb/agent-runtime/shared/json-rpc-envelope": path.resolve(
    repoRoot,
    "packages/agent-runtime/src/shared/json-rpc-envelope.ts",
  ),
  "@bb/agent-runtime": path.resolve(
    repoRoot,
    "packages/agent-runtime/src/index.ts",
  ),
  "@bb/replay-capture/schema": path.resolve(
    repoRoot,
    "packages/replay-capture/src/schema.ts",
  ),
  "@bb/config/common": path.resolve(repoRoot, "packages/config/src/common.ts"),
  "@bb/config/host-daemon": path.resolve(
    repoRoot,
    "packages/config/src/host-daemon.ts",
  ),
  "@bb/domain": path.resolve(repoRoot, "packages/domain/src/index.ts"),
  "@bb/templates": path.resolve(repoRoot, "packages/templates/src/index.ts"),
  "@bb/test-helpers": path.resolve(
    repoRoot,
    "packages/test-helpers/src/index.ts",
  ),
  "@bb/db/internal-lifecycle": path.resolve(
    repoRoot,
    "packages/db/src/internal-lifecycle.ts",
  ),
  "@bb/db": path.resolve(repoRoot, "packages/db/src/index.ts"),
  "@bb/host-daemon-contract": path.resolve(
    repoRoot,
    "packages/host-daemon-contract/src/index.ts",
  ),
  "@bb/host-runtime-material": path.resolve(
    repoRoot,
    "packages/host-runtime-material/src/index.ts",
  ),
  "@bb/host-workspace": path.resolve(
    repoRoot,
    "packages/host-workspace/src/index.ts",
  ),
  "@bb/host-watcher": path.resolve(
    repoRoot,
    "packages/host-watcher/src/index.ts",
  ),
  "@bb/host-daemon/test": path.resolve(
    repoRoot,
    "apps/host-daemon/src/test/index.ts",
  ),
  "@bb/server": path.resolve(repoRoot, "apps/server/src/index.ts"),
  "@bb/cli": path.resolve(repoRoot, "apps/cli/src/index.ts"),
  "@bb/logger": path.resolve(repoRoot, "packages/logger/src/index.ts"),
  "@bb/agent-fixtures": path.resolve(
    repoRoot,
    "packages/agent-fixtures/src/index.ts",
  ),
  "@bb/agent-fixtures/load-browser": path.resolve(
    repoRoot,
    "packages/agent-fixtures/src/load-browser.ts",
  ),
  "@bb/ui-core": path.resolve(repoRoot, "packages/ui-core/src/index.ts"),
  "@bb/sandbox-host": path.resolve(
    repoRoot,
    "packages/sandbox-host/src/index.ts",
  ),
  "@bb/config/server": path.resolve(repoRoot, "packages/config/src/server.ts"),
  "@bb/server-contract": path.resolve(
    repoRoot,
    "packages/server-contract/src/index.ts",
  ),
} as const;
