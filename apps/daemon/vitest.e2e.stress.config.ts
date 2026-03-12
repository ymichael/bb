import { defineConfig } from "vitest/config";
import { workspaceTestAliases } from "../../vitest.workspace-aliases";

export default defineConfig({
  resolve: {
    alias: workspaceTestAliases,
  },
  test: {
    silent: "passed-only",
    name: "@beanbag/daemon:e2e:stress",
    globalSetup: ["./src/__tests__/e2e/global-setup.ts"],
    include: [
      "src/__tests__/e2e/thread-recovery-heavy-runbook.test.ts",
      "src/__tests__/e2e/thread-restart-recovery-matrix.test.ts",
      "src/__tests__/e2e/standalone-daemon-cli-roundtrip.test.ts",
    ],
  },
});
