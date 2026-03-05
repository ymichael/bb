import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    projects: [
      "apps/daemon",
      "apps/cli",
      "apps/app",
      "packages/agent-core",
      "packages/agent-server",
    ],
  },
});
