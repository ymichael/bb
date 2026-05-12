import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: workspaceTestAliases,
  },
  benchmark: {
    include: ["test/**/*.bench.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
  test: {
    silent: "passed-only",
    name: "@bb/server",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
