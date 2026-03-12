import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EnvironmentAgentRuntime } from "./runtime.js";

export interface EnvironmentAgentHttpServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf-8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse<IncomingMessage>, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function isAuthorized(
  request: IncomingMessage,
  expectedBearerToken?: string,
): boolean {
  if (!expectedBearerToken) return true;
  const authorizationHeader = request.headers.authorization?.trim();
  if (!authorizationHeader) return false;
  return authorizationHeader === `Bearer ${expectedBearerToken}`;
}

export async function createEnvironmentAgentHttpServer(args: {
  runtime: EnvironmentAgentRuntime;
  host?: string;
  port?: number;
  bearerToken?: string;
  onSessionSyncRequested?: () => void;
  onShutdownRequested?: () => void | Promise<void>;
}): Promise<EnvironmentAgentHttpServer> {
  const server = createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, args.bearerToken)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "POST" && url.pathname === "/control/status") {
        writeJson(response, 200, args.runtime.getStatusSnapshot());
        return;
      }

      if (method === "POST" && url.pathname === "/control/session-sync") {
        args.onSessionSyncRequested?.();
        writeJson(response, 202, {
          ok: true,
          status: args.runtime.getStatusSnapshot(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/control/shutdown") {
        writeJson(response, 202, {
          ok: true,
        });
        queueMicrotask(() => {
          void args.onShutdownRequested?.();
        });
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port ?? 0, args.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve environment-agent HTTP server address");
  }

  return {
    baseUrl: `http://${address.address}:${address.port}`,
    close: async () => {
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
