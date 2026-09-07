import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
