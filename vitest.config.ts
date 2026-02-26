import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/daemon",
      "apps/cli",
      "apps/app",
      "packages/agent-core",
      "packages/agent-server",
    ],
  },
});
