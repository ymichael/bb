import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/agent-runtime",
      include: ["src/**/*.test.ts"],
      exclude: ["dist/**", "node_modules/**", "src/integration*.test.ts"],
    }),
  },
});
