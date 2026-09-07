import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

const parsedTimeoutScale = Number(process.env.BB_TEST_TIMEOUT_SCALE ?? 1);
const timeoutScale =
  Number.isFinite(parsedTimeoutScale) && parsedTimeoutScale > 0
    ? parsedTimeoutScale
    : 1;

export default defineWorkspaceTestConfig({
  test: {
    fileParallelism: true,
    globalSetup: ["./global-setup.ts"],
    hookTimeout: Math.ceil(120_000 * timeoutScale),
    include: ["real/**/*.test.ts"],
    maxConcurrency: 20,
    name: "@bb/integration-tests:real",
    silent: "passed-only",
    testTimeout: Math.ceil(120_000 * timeoutScale),
  },
});
