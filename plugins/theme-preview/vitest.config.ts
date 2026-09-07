import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    // The DOM suite renders the whole panel (mock frame, style sheet, overlays)
    // per test; vitest's 5s default flakes on the heavier cases. Matches the
    // precedent in plugins/tasks.
    testTimeout: 20_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-plugin-theme-preview",
      include: ["**/*.test.{ts,tsx}"],
      exclude: ["node_modules/**"],
    }),
  },
});
