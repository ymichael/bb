import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentAckRequest,
  type EnvironmentAgentProviderSpec,
  type EnvironmentAgentReplayRequest,
} from "./protocol.js";
import type { EnvironmentAgentRuntime } from "./runtime.js";

export interface EnvironmentAgentHttpServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

interface StreamClient {
  response: ServerResponse<IncomingMessage>;
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
}): Promise<EnvironmentAgentHttpServer> {
  const clients = new Set<StreamClient>();

  const server = createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, args.bearerToken)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/stream") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const client = { response };
        clients.add(client);
        request.on("close", () => {
          clients.delete(client);
        });
        return;
      }

      if (method === "POST" && url.pathname === "/provider-line") {
        const body = (await readJsonBody(request)) as { line?: unknown };
        if (typeof body.line !== "string") {
          writeJson(response, 400, { error: "Expected string line" });
          return;
        }
        args.runtime.sendProviderLine(body.line);
        writeJson(response, 202, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/control/status") {
        writeJson(response, 200, args.runtime.getStatusSnapshot());
        return;
      }

      if (method === "POST" && url.pathname === "/control/provider/ensure") {
        const body = (await readJsonBody(request)) as EnvironmentAgentProviderSpec;
        writeJson(response, 200, args.runtime.ensureProviderStatus(body));
        return;
      }

      if (method === "POST" && url.pathname === "/control/delivery/retry") {
        args.runtime.triggerDaemonDelivery();
        writeJson(response, 200, args.runtime.getStatusSnapshot());
        return;
      }

      if (method === "POST" && url.pathname === "/control/replay") {
        const body = (await readJsonBody(request)) as EnvironmentAgentReplayRequest;
        writeJson(
          response,
          200,
          args.runtime.replay({
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            afterSequence: body.afterSequence ?? 0,
            ...(body.limit ? { limit: body.limit } : {}),
            ...(body.threadId ? { threadId: body.threadId } : {}),
          }),
        );
        return;
      }

      if (method === "POST" && url.pathname === "/control/ack") {
        const body = (await readJsonBody(request)) as EnvironmentAgentAckRequest;
        writeJson(
          response,
          200,
          args.runtime.acknowledge({
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: body.sequence ?? 0,
            ...(body.threadId ? { threadId: body.threadId } : {}),
          }),
        );
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const broadcastLine = (line: string) => {
    for (const client of clients) {
      client.response.write(`${line}\n`);
    }
  };

  const unsubscribeStdout = args.runtime.subscribeToProviderStdout((line) => {
    broadcastLine(line);
  });
  const unsubscribeEvents = args.runtime.subscribeToEvents((event) => {
    broadcastLine(
      JSON.stringify({
        environmentAgentMessage: true,
        type: "event.emitted",
        payload: event,
      }),
    );
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
      unsubscribeStdout();
      unsubscribeEvents();
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
