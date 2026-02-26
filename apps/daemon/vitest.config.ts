import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@beanbag/agent-server",
    exclude: ["dist/**", "node_modules/**"],
  },
});
