import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { promoteRuntimeEntries } from "./promote-runtime-entries.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// A node program bundled from CommonJS dependencies (the bootstrap pulls
// cross-spawn through @bb/process-utils) needs `require` in ESM scope; the
// daemon's bundles carry the same banner (apps/host-daemon/scripts/bundle-manifest.mjs).
const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("\n");

const entries = [
  { source: "src/index.ts", output: "dist/index.js", external: [] },
  { source: "src/app.ts", output: "dist/app.js", external: [] },
  // Real code, not a stub: the provider-bridge surface is schemas and pure
  // helpers, so the published bundle carries them. zod stays external (peer
  // dependency).
  {
    source: "src/provider-bridge.ts",
    output: "dist/provider-bridge.js",
    external: ["zod", "zod/*"],
  },
  // The AI-services contract: zod schemas shared by a serving plugin's host
  // entry and the server's caller.
  {
    source: "src/ai-services.ts",
    output: "dist/ai-services.js",
    external: ["zod", "zod/*"],
  },
  // The testing kit: conformance scenarios, the real delta assembler, the
  // JSON-RPC harness, the calibration normalizer and the recorded-replay
  // harness. Framework-agnostic, so only zod stays external.
  {
    source: "src/provider-bridge-testing.ts",
    output: "dist/provider-bridge-testing.js",
    external: ["zod", "zod/*"],
  },
  // The replay harness spawns two programs beside its own bundle: the
  // provider-bridge bootstrap that runs a bridge module the way the runtime
  // does, and the replay child a bridge spawns in place of its provider.
  // Both are resolved relative to `import.meta.url` of the testing bundle
  // (`packages/provider-bridge-protocol/src/testing/parity.ts`), so they must
  // land next to it under the names it expects.
  {
    source: "../provider-bridge-protocol/src/bridge-worker-entry.ts",
    output: "dist/provider-bridge-worker-entry.mjs",
    external: [],
    banner: NODE_ESM_REQUIRE_BANNER,
  },
  {
    copy: "../provider-bridge-protocol/src/testing/replay-provider-child.mjs",
    output: "dist/replay-provider-child.mjs",
  },
  // The ACP kit: the generic Agent Client Protocol bridge a provider plugin
  // re-exports from its host artifact, plus the dialect hooks. Real code, so
  // only zod stays external.
  {
    source: "src/provider-bridge-acp.ts",
    output: "dist/provider-bridge-acp.js",
    external: ["zod", "zod/*"],
  },
  { source: "src/host.ts", output: "dist/host.js", external: [] },
  {
    source: "src/environment-provider.ts",
    output: "dist/environment-provider.js",
    external: ["zod", "zod/*"],
  },
  {
    source: "src/machine-provider.ts",
    output: "dist/machine-provider.js",
    external: ["zod", "zod/*"],
  },
  {
    source: "src/internal/composer-customization-validation.ts",
    output: "dist/internal/composer-customization-validation.js",
    external: [],
  },
  {
    source: "src/internal/composer-view.ts",
    output: "dist/internal/composer-view.js",
    external: [],
  },
  {
    source: "src/internal/file-navigation-validation.ts",
    output: "dist/internal/file-navigation-validation.js",
    external: [],
  },
  {
    source: "src/internal/host-policy.ts",
    output: "dist/internal/host-policy.js",
    external: ["zod", "zod/*"],
  },
  {
    source: "src/internal/plugin-app-collector.ts",
    output: "dist/internal/plugin-app-collector.js",
    external: [],
  },
  {
    source: "src/testing/index.ts",
    output: "dist/testing/index.js",
    external: [
      "better-sqlite3",
      "cron-parser",
      "hono",
      "hono/*",
      "zod",
      "zod/*",
    ],
  },
  {
    source: "src/testing/app.tsx",
    output: "dist/testing/app.js",
    external: [
      "@testing-library/react",
      "@testing-library/react/*",
      "react",
      "react/*",
      "react-dom",
      "react-dom/*",
    ],
  },
  {
    source: "src/testing/host.ts",
    output: "dist/testing/host.js",
    external: [],
  },
];

const stagingDir = await mkdtemp(path.join(packageRoot, ".runtime-build-"));
try {
  for (const entry of entries) {
    if (entry.copy !== undefined) {
      const destination = path.join(
        stagingDir,
        path.relative("dist", entry.output),
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(packageRoot, entry.copy), destination);
      continue;
    }
    await build({
      ...(entry.banner === undefined ? {} : { banner: { js: entry.banner } }),
      bundle: true,
      conditions: ["source"],
      entryPoints: [path.join(packageRoot, entry.source)],
      external: entry.external,
      format: "esm",
      legalComments: "none",
      outfile: path.join(stagingDir, path.relative("dist", entry.output)),
      platform: "node",
      target: "node20",
    });
  }
  await promoteRuntimeEntries({
    distDir: path.join(packageRoot, "dist"),
    stagingDir,
    relativeOutputs: entries.map((entry) =>
      path.relative("dist", entry.output),
    ),
  });
} finally {
  await rm(stagingDir, { force: true, recursive: true });
}

process.stdout.write(
  `Built ${entries.length} @get-bb/plugin-sdk runtime entries.\n`,
);
