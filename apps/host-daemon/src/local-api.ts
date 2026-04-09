import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import {
  healthResponseSchema,
  openRequestSchema,
  restartRequestSchema,
  typedRoutes,
  type HostDaemonActiveThread,
  type HostDaemonLocalSchema,
} from "@bb/host-daemon-contract";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import open from "open";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";

const execFileAsync = promisify(execFile);

export interface StartLocalApiServerOptions {
  hostId: string;
  localApiConfig: HostDaemonLocalApiConfig;
  serverUrl: string;
  getConnected: () => boolean;
  openPath?: (path: string) => Promise<void>;
  pickFolder?: () => Promise<string | null>;
  listActiveThreads: () => HostDaemonActiveThread[];
  restart: () => Promise<void> | void;
  scheduleRestart?: (restart: () => void) => void;
}

export interface LocalApiServer {
  bindHost: string;
  port: number;
  close(): Promise<void>;
}

export async function startLocalApiServer(
  options: StartLocalApiServerOptions,
): Promise<LocalApiServer> {
  const app = new Hono();
  app.use("*", cors());

  app.get(options.localApiConfig.healthPath, (c) =>
    c.text(healthResponseSchema.parse(options.localApiConfig.healthValue)),
  );
  app.use("*", async (c, next) => {
    if (options.localApiConfig.mode === "health-only") {
      return c.notFound();
    }
    await next();
  });

  const { get, post } = typedRoutes<HostDaemonLocalSchema>(app);

  get("/status", (c) =>
    c.json({
      hostId: options.hostId,
      connected: options.getConnected(),
      serverUrl: options.serverUrl,
      supportsNativeFolderPicker:
        options.pickFolder != null || process.platform === "darwin",
    }),
  );

  post("/open-path", openRequestSchema, async (c, payload) => {
    const stat = await fs.stat(payload.path).catch(() => null);
    if (!stat) {
      throw new HTTPException(400, { message: `Path does not exist: ${payload.path}` });
    }
    await (options.openPath ?? openLocalPath)(payload.path);
    return c.json({});
  });

  post("/pick-folder", async (c) => {
    const path = await (options.pickFolder ?? pickLocalFolder)();
    return c.json({ path });
  });

  post("/restart", restartRequestSchema, (c, payload) => {
    if (!payload.force && options.listActiveThreads().length > 0) {
      return c.json({ message: "Cannot restart: threads are currently active. Use force to override." }, 409);
    }
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
      {
        fetch: app.fetch,
        port: options.localApiConfig.port,
        hostname: options.localApiConfig.bindHost,
      },
      (info) => resolve({ server: s, port: info.port }),
    );
    s.on("error", reject);
  });

  return {
    bindHost: options.localApiConfig.bindHost,
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
  const child = await open(path, {
    background: true,
    wait: false,
  });
  child.unref();
}

async function pickLocalFolder(): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new HTTPException(501, {
      message: "Folder picker is only supported on macOS",
    });
  }

  let stdout: string;
  try {
    const result = await execFileAsync("osascript", [
      "-e",
      'try\nPOSIX path of (choose folder with prompt "Choose a folder for bb")\non error number -128\nreturn ""\nend try',
    ]);
    stdout = result.stdout;
  } catch (error) {
    throw new HTTPException(500, {
      message: `Folder picker failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const selectedPath = stdout.trim();
  if (selectedPath === "") {
    return null;
  }
  return selectedPath.replace(/\/$/, "");
}
