import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceTestAliases,
  },
  test: {
    environment: "node",
    include: [
      "src/__tests__/worktree-environment.test.ts",
      "src/__tests__/docker-environment.integration.test.ts",
    ],
    exclude: ["dist/**"],
  },
});
