import path from "node:path";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    silent: "passed-only",
    environment: "node",
    passWithNoTests: true,
    testTimeout: 15_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      aliases: { "@": path.resolve(__dirname, "./src") },
      name: "@bb/mobile",
      include: ["src/**/*.test.ts"],
    }),
  },
});
