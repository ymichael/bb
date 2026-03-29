import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import {
  openRequestSchema,
  typedRoutes,
  type HostDaemonLocalSchema,
} from "@bb/host-daemon-contract";
import { Hono } from "hono";
import { cors } from "hono/cors";

const execFileAsync = promisify(execFile);

export interface StartLocalApiServerOptions {
  hostId: string;
  port: number;
  serverUrl: string;
  getConnected: () => boolean;
  openPath?: (path: string) => Promise<void>;
  pickFolder?: () => Promise<string | null>;
  restart: () => Promise<void> | void;
  scheduleRestart?: (restart: () => void) => void;
}

export interface LocalApiServer {
  port: number;
  close(): Promise<void>;
}

export async function startLocalApiServer(
  options: StartLocalApiServerOptions,
): Promise<LocalApiServer> {
  const app = new Hono();
  app.use("*", cors());

  const { get, post } = typedRoutes<HostDaemonLocalSchema>(app);

  get("/status", (c) =>
    c.json({
      hostId: options.hostId,
      connected: options.getConnected(),
      serverUrl: options.serverUrl,
    }),
  );

  post("/open", openRequestSchema, async (c, payload) => {
    await (options.openPath ?? openLocalPath)(payload.path);
    return c.json({});
  });

  post("/pick-folder", async (c) => {
    const path = await (options.pickFolder ?? pickLocalFolder)();
    return c.json({ path });
  });

  post("/restart", (c) => {
    (options.scheduleRestart ?? defaultScheduleRestart)(() => {
      void options.restart();
    });
    return c.json({});
  });

  const { server, port: boundPort } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve, reject) => {
    const s = serve(
      { fetch: app.fetch, port: options.port, hostname: "localhost" },
      (info) => resolve({ server: s, port: info.port }),
    );
    s.on("error", reject);
  });

  return {
    port: boundPort,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function defaultScheduleRestart(restart: () => void): void {
  setTimeout(restart, 0);
}

async function openLocalPath(path: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [path] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", path] }
        : { file: "xdg-open", args: [path] };

  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function pickLocalFolder(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const { stdout } = await execFileAsync("osascript", [
    "-e",
    'try\nPOSIX path of (choose folder with prompt "Choose a folder for bb")\non error number -128\nreturn ""\nend try',
  ]);
  const selectedPath = stdout.trim();
  if (selectedPath === "") {
    return null;
  }
  return selectedPath.replace(/\/$/, "");
}
