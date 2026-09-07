import { defineWorkspaceTestConfig } from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  test: {
    name: "bb-plugin-browser-automation",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
