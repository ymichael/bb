import path from "path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { workspaceTestAliases } from "../../vitest.workspace-aliases"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      ...workspaceTestAliases,
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    silent: "passed-only",
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
  },
})
