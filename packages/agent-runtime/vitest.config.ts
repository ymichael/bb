import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceTestAliases,
  },
  test: {
    silent: "passed-only",
    name: "@bb/agent-runtime",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "src/integration*.test.ts"],
  },
});
