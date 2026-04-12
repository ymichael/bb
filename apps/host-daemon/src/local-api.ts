import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import {
  healthResponseSchema,
  openWorkspaceRequestSchema,
  openRequestSchema,
  pathsExistRequestSchema,
  restartRequestSchema,
  typedRoutes,
  type HostDaemonActiveThread,
  type HostDaemonLocalSchema,
  type HostPlatform,
  type OpenWorkspaceRequest,
  type WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import open from "open";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";
import {
  listWorkspaceOpenTargets,
  openWorkspaceInTarget,
  WorkspaceOpenTargetError,
} from "./workspace-open-targets.js";

const execFileAsync = promisify(execFile);

export type OpenPathHandler = (path: string) => Promise<void>;
export type WorkspaceOpenTargetListHandler = () => Promise<WorkspaceOpenTarget[]>;
export type WorkspaceOpenHandler = (request: OpenWorkspaceRequest) => Promise<void>;

export interface StartLocalApiServerOptions {
  hostId: string;
  localApiConfig: HostDaemonLocalApiConfig;
  serverUrl: string;
  getConnected: () => boolean;
  listWorkspaceOpenTargets?: WorkspaceOpenTargetListHandler;
  openPath?: OpenPathHandler;
  openWorkspace?: WorkspaceOpenHandler;
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

export type FolderPickerHandler = () => Promise<string | null>;

export interface ResolveNativeFolderPickerOptions {
  pickFolder?: FolderPickerHandler;
  platform?: NodeJS.Platform;
}

export function resolveNativeFolderPicker(
  options: ResolveNativeFolderPickerOptions,
): FolderPickerHandler | null {
  if (options.pickFolder) {
    return options.pickFolder;
  }

  return (options.platform ?? process.platform) === "darwin"
    ? pickLocalFolder
    : null;
}

export function resolveHostPlatform(
  nodePlatform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): HostPlatform {
  if (nodePlatform === "darwin") return "darwin";
  if (nodePlatform === "linux") {
    const isWsl = env.WSL_DISTRO_NAME != null || env.WSL_INTEROP != null;
    return isWsl ? "wsl" : "linux";
  }
  return "unknown";
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
  const nativeFolderPicker = resolveNativeFolderPicker({
    pickFolder: options.pickFolder,
  });
  const platform = resolveHostPlatform();

  get("/status", (c) =>
    c.json({
      hostId: options.hostId,
      connected: options.getConnected(),
      serverUrl: options.serverUrl,
      supportsNativeFolderPicker: nativeFolderPicker !== null,
      platform,
    }),
  );

  post("/open-path", openRequestSchema, async (c, payload) => {
    const stat = await fs.stat(payload.path).catch(() => null);
    if (!stat) {
      throw new HTTPException(400, { message: "Path does not exist" });
    }
    await (options.openPath ?? openLocalPath)(payload.path);
    return c.json({});
  });

  post("/paths/exist", pathsExistRequestSchema, async (c, payload) => {
    const entries = await Promise.all(
      payload.paths.map(async (path) => [path, await pathExists(path)] as const),
    );
    return c.json({ existence: Object.fromEntries(entries) });
  });

  get("/workspace-open-targets", async (c) =>
    c.json({
      targets: await (options.listWorkspaceOpenTargets ?? listWorkspaceOpenTargets)(),
    }),
  );

  post("/open-workspace", openWorkspaceRequestSchema, async (c, payload) => {
    try {
      await (options.openWorkspace ?? openWorkspaceInTarget)(payload);
    } catch (error) {
      if (error instanceof WorkspaceOpenTargetError) {
        throw new HTTPException(400, { message: error.message });
      }
      throw error;
    }

    return c.json({});
  });

  post("/pick-folder", async (c) => {
    if (!nativeFolderPicker) {
      throw new HTTPException(501, {
        message: "Folder picker is only supported on macOS",
      });
    }
    const path = await nativeFolderPicker();
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    // Permission denied / loops / etc. — we can't tell, but the entry exists
    // enough to error on, so don't claim it's missing.
    return true;
  }
}

async function openLocalPath(path: string): Promise<void> {
  const child = await open(path, {
    background: true,
    wait: false,
  });
  child.unref();
}

async function pickLocalFolder(): Promise<string | null> {
  let stdout: string;
  try {
    const result = await execFileAsync("osascript", [
      "-e",
      'try\nPOSIX path of (choose folder with prompt "Choose a project folder")\non error number -128\nreturn ""\nend try',
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
