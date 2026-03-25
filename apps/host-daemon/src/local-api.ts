import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import {
  hostIdResponseSchema,
  openRequestSchema,
  pickFolderResponseSchema,
  statusResponseSchema,
} from "@bb/host-daemon-contract";

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
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(options, request, response);
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind local API server");
  }

  return {
    port: address.port,
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

async function handleRequest(
  options: StartLocalApiServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/host-id") {
    writeJson(response, 200, hostIdResponseSchema.parse({ hostId: options.hostId }));
    return;
  }

  if (method === "GET" && url.pathname === "/status") {
    writeJson(
      response,
      200,
      statusResponseSchema.parse({
        connected: options.getConnected(),
        serverUrl: options.serverUrl,
      }),
    );
    return;
  }

  if (method === "POST" && url.pathname === "/open") {
    const payload = openRequestSchema.parse(await readJsonBody(request));
    await (options.openPath ?? openLocalPath)(payload.path);
    writeJson(response, 200, {});
    return;
  }

  if (method === "POST" && url.pathname === "/pick-folder") {
    const path = await (options.pickFolder ?? pickLocalFolder)();
    writeJson(response, 200, pickFolderResponseSchema.parse({ path }));
    return;
  }

  if (method === "POST" && url.pathname === "/restart") {
    (options.scheduleRestart ?? defaultScheduleRestart)(() => {
      void options.restart();
    });
    writeJson(response, 200, {});
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body === "" ? {} : JSON.parse(body);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
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
