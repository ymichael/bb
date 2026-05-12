import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases.js";

const parsedTimeoutScale = Number(process.env.BB_TEST_TIMEOUT_SCALE ?? 1);
const timeoutScale =
  Number.isFinite(parsedTimeoutScale) && parsedTimeoutScale > 0
    ? parsedTimeoutScale
    : 1;

export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: workspaceTestAliases,
  },
  test: {
    // Fake integration suites isolate temp roots, ports, and in-memory state,
    // so we can safely parallelize across files for a large runtime win.
    fileParallelism: true,
    globalSetup: ["./global-setup.ts"],
    hookTimeout: Math.ceil(60_000 * timeoutScale),
    include: ["fake/**/*.test.ts"],
    name: "@bb/integration-tests",
    silent: "passed-only",
    testTimeout: Math.ceil(60_000 * timeoutScale),
  },
});
