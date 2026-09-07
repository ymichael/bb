import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { z } from "zod";
import { createDesktopBrowserViewManager } from "../../src/desktop-browser-view.js";
import { createDesktopBrowserBroker } from "../../src/desktop-browser-broker.js";
import { createDesktopBrowserBrokerClient } from "../../src/desktop-browser-broker-client.js";

async function main() {
  const config = z
    .object({
      artifacts: z.string(),
      dataDir: z.string(),
      serverUrl: z.string(),
    })
    .parse(
      JSON.parse(readFileSync(z.string().parse(process.argv.at(-1)), "utf8")),
    );
  app.setPath("userData", join(config.artifacts, "electron-profile"));
  app.disableHardwareAcceleration();
  const keepAlive = setInterval(() => {
    if (existsSync(join(config.artifacts, "stop-electron"))) stop();
  }, 100);
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 800, show: true });
  await window.loadURL(
    "data:text/html,<title>Broker smoke host</title>Trusted host sentinel",
  );
  const manager = createDesktopBrowserViewManager({
    partition: "broker-smoke-personal",
    dispatchAppCommand: () => {},
    focusHostWebContents: () => {},
    resolveAppCommand: () => null,
  });
  const broker = createDesktopBrowserBroker({ manager, product: "BB smoke" });
  broker.registerWindow(window);
  const client = createDesktopBrowserBrokerClient({
    broker,
    dataDir: config.dataDir,
    getServerUrl: () => config.serverUrl,
  });
  writeFileSync(
    join(config.artifacts, "electron-ready.json"),
    JSON.stringify({ ready: true }),
    { mode: 0o600 },
  );
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    client.stop();
    broker.dispose();
    manager.destroyAll();
    if (!window.isDestroyed()) window.destroy();
    clearInterval(keepAlive);
    app.quit();
  }
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
