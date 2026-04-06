import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases.js";

const parsedTimeoutScale = Number(process.env.BB_TEST_TIMEOUT_SCALE ?? 1);
const timeoutScale =
  Number.isFinite(parsedTimeoutScale) && parsedTimeoutScale > 0
    ? parsedTimeoutScale
    : 1;

export default defineConfig({
  resolve: {
    alias: workspaceTestAliases,
  },
  test: {
    fileParallelism: false,
    globalSetup: ["./global-setup.ts"],
    hookTimeout: Math.ceil(120_000 * timeoutScale),
    include: ["real/**/*.test.ts"],
    name: "@bb/integration-tests:real",
    silent: "passed-only",
    testTimeout: Math.ceil(120_000 * timeoutScale),
  },
});
