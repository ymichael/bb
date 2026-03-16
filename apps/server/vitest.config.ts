import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceTestAliases,
  },
  test: {
    silent: "passed-only",
    name: "@bb/server",
    exclude: ["dist/**", "node_modules/**", "src/__tests__/e2e/**"],
  },
});
