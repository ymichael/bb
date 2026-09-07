import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    server: {
      deps: {
        external: [/\.builtin-host-test-[^/]+\/dist\/host\.js/u],
      },
    },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/plugin-build",
      include: ["src/**/*.test.ts"],
    }),
  },
});
