import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@beanbag/core",
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
