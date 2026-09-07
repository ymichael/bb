import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { bundleStats } from "./vite-bundle-stats.js";
import { fontPreload } from "./vite-font-preload.js";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";

const appDir = dirname(fileURLToPath(import.meta.url));

export const sharedViteConfig = {
  plugins: [
    sharedUiEnvSeam(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    bundleStats(),
    fontPreload(),
  ],
  cacheDir: "node_modules/.vite/app",
  build: {
    reportCompressedSize: false,
    assetsInlineLimit: (filePath) =>
      filePath.includes("/workspace-open-target-icons/") ? false : undefined,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            {
              name: "boot-vendor",
              test: /node_modules/,
              tags: ["$initial"],
              priority: 2,
              minSize: 12 * 1024,
            },
            {
              name: "boot-app",
              tags: ["$initial"],
              priority: 1,
              minSize: 12 * 1024,
            },
          ],
        },
      },
    },
  },
  optimizeDeps: {
    include: ["@xterm/addon-fit", "@xterm/addon-web-links", "@xterm/xterm"],
  },
  resolve: {
    conditions: ["source"],
    alias: {
      "@": resolve(appDir, "./src"),
    },
  },
} satisfies UserConfig;

export default defineConfig(sharedViteConfig);
