import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceTestAliases,
  },
  test: {
    silent: "passed-only",
    name: "@beanbag/daemon:e2e:fast",
    globalSetup: ["./src/__tests__/e2e/global-setup.ts"],
    include: [
      "src/__tests__/e2e/environment-agent-restart-roundtrip.test.ts",
      "src/__tests__/e2e/thread-provisioning-responsiveness.test.ts",
      "src/__tests__/e2e/thread-spawn-roundtrip.test.ts",
      "src/__tests__/e2e/thread-worktree-followup-roundtrip.test.ts",
    ],
  },
});
