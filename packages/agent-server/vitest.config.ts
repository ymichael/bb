import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@beanbag/agent-server",
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
