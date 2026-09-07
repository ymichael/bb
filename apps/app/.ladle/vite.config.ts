import path from "path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolveCurrentDevInstanceConfig } from "@bb/config/runtime";
import { sharedUiEnvSeam } from "../vite-shared-ui-seam.js";

const repoRoot = path.resolve(__dirname, "../../..");
const devInstance = resolveCurrentDevInstanceConfig(repoRoot);
const trustedDevAppHeaders = {
  origin: `http://localhost:${devInstance.ports.appPort}`,
};

export default defineConfig({
  plugins: [sharedUiEnvSeam(), tailwindcss()],
  cacheDir: "node_modules/.vite/ladle",
  worker: {
    format: "es",
  },
  resolve: {
    conditions: ["source"],
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "../src"),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        "process.env.NODE_ENV": '"development"',
      },
    },
  },
  server: {
    allowedHosts: [".getbb.app"],
    proxy: {
      "/api": {
        target: devInstance.serverUrl,
        changeOrigin: true,
        headers: trustedDevAppHeaders,
      },
      "/ws": {
        target: devInstance.serverUrl,
        changeOrigin: true,
        ws: true,
        headers: trustedDevAppHeaders,
      },
    },
  },
});
