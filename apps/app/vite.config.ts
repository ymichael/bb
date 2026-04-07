import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DEFAULTS } from "../../packages/config/src/defaults.js";

const appPort = Number.parseInt(process.env.BB_APP_PORT ?? String(DEFAULTS.appPort.dev), 10);
const serverPort = Number.parseInt(process.env.BB_SERVER_PORT ?? String(DEFAULTS.serverPort.dev), 10);
const serverHttpOrigin = `http://localhost:${serverPort}`;
const serverWsOrigin = `ws://localhost:${serverPort}`;

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: command === "serve"
    ? {
        // In dev mode, connect the WebSocket directly to the server instead of
        // going through Vite's proxy. Vite's WS proxy (node-http-proxy) does not
        // handle reconnection when the upstream server restarts — it's a known
        // limitation (vitejs/vite#8117, chimurai/http-proxy-middleware#44).
        // In production the server serves the app directly so this isn't needed.
        "__BB_DEV_WS_URL__": JSON.stringify(`${serverWsOrigin}/ws`),
      }
    : undefined,
  server: {
    port: appPort,
    proxy: {
      "/api": {
        target: serverHttpOrigin,
        changeOrigin: true,
      },
    },
  },
}));
