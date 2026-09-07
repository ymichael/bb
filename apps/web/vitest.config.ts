import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  define: { __SITE_ORIGIN__: JSON.stringify("https://web.test") },
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/web",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    }),
  },
});
