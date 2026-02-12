import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/daemon", "apps/cli", "apps/web", "packages/core"],
  },
});
