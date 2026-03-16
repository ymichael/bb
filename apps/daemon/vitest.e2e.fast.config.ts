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
      "src/__tests__/e2e/standalone-daemon-cli-roundtrip.test.ts",
      "src/__tests__/e2e/thread-archive-unarchive-roundtrip.test.ts",
      "src/__tests__/e2e/environment-agent-restart-roundtrip.test.ts",
      "src/__tests__/e2e/thread-provisioning-responsiveness.test.ts",
      "src/__tests__/e2e/thread-spawn-roundtrip.test.ts",
      "src/__tests__/e2e/thread-immediate-followups-roundtrip.test.ts",
      "src/__tests__/e2e/thread-shared-environment-roundtrip.test.ts",
      "src/__tests__/e2e/thread-restart-recovery-matrix.test.ts",
      "src/__tests__/e2e/thread-recovery-heavy-runbook.test.ts",
      "src/__tests__/e2e/thread-worktree-followup-roundtrip.test.ts",
      "src/__tests__/e2e/thread-worktree-primary-checkout-roundtrip.test.ts",
      "src/__tests__/e2e/standalone-daemon-blocked-restart.test.ts",
      "src/__tests__/e2e/dynamic-tools-daemon-roundtrip.test.ts",
    ],
  },
});
