import path from "path";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";

export default defineWorkspaceTestConfig({
  plugins: [sharedUiEnvSeam(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    silent: "passed-only",
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 15_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      aliases: { "@": path.resolve(__dirname, "./src") },
      name: "@bb/app",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    }),
  },
});
