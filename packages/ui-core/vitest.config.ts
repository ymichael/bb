import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "@beanbag/ui-core",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
