import { defineConfig } from "vite";
import { loadViteDevConfig } from "@bb/config/vite-dev";
import { sharedViteConfig } from "./vite.config.js";

const viteDevConfig = loadViteDevConfig();
const devWebSocketBrowserHostPortDefine = JSON.stringify(
  viteDevConfig.serverPort,
);

export default defineConfig({
  ...sharedViteConfig,
  css: {
    transformer: "lightningcss",
  },
  define: {
    __BB_DEV_WS_BROWSER_HOST_PORT__: devWebSocketBrowserHostPortDefine,
    __BB_DEV_APP_BROWSER_HOST_PORT__: JSON.stringify(viteDevConfig.appPort),
  },
  server: {
    allowedHosts: [".ts.net"],
    host: viteDevConfig.appHost,
    port: viteDevConfig.appPort,
    proxy: {
      "/api": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        xfwd: true,
      },
      "/ws": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        ws: true,
        xfwd: true,
      },
    },
  },
});
