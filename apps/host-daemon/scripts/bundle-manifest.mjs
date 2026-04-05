import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

export const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("");

export const bundleTargets = [
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(packageRoot, "src", "index.ts"),
    label: "daemon",
    outfile: resolve(packageRoot, "dist", "daemon-bundle.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      workspaceRoot,
      "packages",
      "agent-runtime",
      "src",
      "claude-code",
      "bridge",
      "bridge.ts",
    ),
    label: "claude-code bridge",
    outfile: resolve(packageRoot, "dist", "bb-claude-code-bridge.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(
      workspaceRoot,
      "packages",
      "agent-runtime",
      "src",
      "pi",
      "bridge",
      "bridge.ts",
    ),
    label: "pi bridge",
    outfile: resolve(packageRoot, "dist", "bb-pi-bridge.mjs"),
  },
  {
    banner: NODE_ESM_REQUIRE_BANNER,
    entryPoint: resolve(workspaceRoot, "apps", "cli", "src", "index.ts"),
    executable: true,
    label: "bb cli",
    outfile: resolve(packageRoot, "dist", "bb"),
  },
];
