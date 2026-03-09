import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceTestAliases,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**"],
  },
});
