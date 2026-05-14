import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    silent: "passed-only",
    name: "@bb/logger",
    testTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
