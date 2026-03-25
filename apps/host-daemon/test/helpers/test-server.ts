import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Hono } from "hono";
import {
  hostDaemonCommandBatchSchema,
  hostDaemonCommandResultReportSchema,
  hostDaemonCommandsQuerySchema,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonToolCallRequestSchema,
  type HostDaemonCommand,
  type HostDaemonCommandEnvelope,
  type HostDaemonCommandResultReport,
  type HostDaemonEventEnvelope,
  type HostDaemonServerWsMessage,
  type HostDaemonSessionOpenRequest,
} from "@bb/host-daemon-contract";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function serveHonoRequest(
  app: Hono,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readRequestBody(request);
  const honoRequest = new Request(
    new URL(request.url ?? "/", "http://127.0.0.1"),
    {
      method: request.method,
      headers: request.headers as HeadersInit,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : body.toString("utf8"),
    },
  );
  const honoResponse = await app.fetch(honoRequest);

  response.statusCode = honoResponse.status;
  honoResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  response.end(Buffer.from(await honoResponse.arrayBuffer()));
}

export interface CreateTestServerOptions {
  commandResultFailures?: number;
  commandResultFailureStatus?: number;
  heartbeatIntervalMs?: number;
  leaseTimeoutMs?: number;
  threadHighWaterMarks?: Record<string, number>;
}

export interface TestServer {
  baseUrl: string;
  commandFetches: Array<{ sessionId: string; afterCursor: number }>;
  commandResultReports: HostDaemonCommandResultReport[];
  commandResults: HostDaemonCommandResultReport[];
  events: HostDaemonEventEnvelope[];
  heartbeats: Array<{
    sessionId: string;
    message: { bufferDepth: number; lastCommandCursor?: number };
  }>;
  sessionOpenCalls: HostDaemonSessionOpenRequest[];
  toolCalls: Array<{ sessionId: string; tool: string }>;
  queueCommand(command: HostDaemonCommand): HostDaemonCommandEnvelope;
  sendWebSocketMessage(message: HostDaemonServerWsMessage): void;
  setWebSocketAvailable(available: boolean): void;
  closeWebSockets(): void;
  socketCount(): number;
  close(): Promise<void>;
  readonly commandResultAttemptCount: number;
}

export async function createTestServer(
  options: CreateTestServerOptions = {},
): Promise<TestServer> {
  const sessionOpenCalls: HostDaemonSessionOpenRequest[] = [];
  const heartbeats: Array<{
    sessionId: string;
    message: { bufferDepth: number; lastCommandCursor?: number };
  }> = [];
  const commandFetches: Array<{ sessionId: string; afterCursor: number }> = [];
  const commandResultReports: HostDaemonCommandResultReport[] = [];
  const toolCalls: Array<{ sessionId: string; tool: string }> = [];
  const events: HostDaemonEventEnvelope[] = [];
  const activeSockets = new Set<WebSocket>();
  const commands = new Map<number, HostDaemonCommandEnvelope>();
  const completedCommandCursors = new Set<number>();
  const threadHighWaterMarks = {
    ...(options.threadHighWaterMarks ?? { threadA: 4 }),
  };

  let commandResultAttemptCount = 0;
  let nextCursor = 1;
  let nextSessionId = 1;
  let webSocketAvailable = true;

  const app = new Hono();

  // This fixture intentionally omits auth validation, session lease expiry,
  // and true long-poll semantics. Tests use it only for protocol flow.
  app.post("/internal/session/open", async (context) => {
    const payload = hostDaemonSessionOpenRequestSchema.parse(
      await context.req.json(),
    );
    sessionOpenCalls.push(payload);
    return context.json(
      {
        sessionId: `session-${nextSessionId++}`,
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? 25,
        leaseTimeoutMs: options.leaseTimeoutMs ?? 1_000,
        threadHighWaterMarks,
      },
      201,
    );
  });
  app.get("/internal/session/commands", (context) => {
    const query = hostDaemonCommandsQuerySchema.parse(context.req.query());
    const afterCursor = Number.parseInt(query.afterCursor ?? "0", 10);
    commandFetches.push({
      sessionId: query.sessionId,
      afterCursor,
    });

    const available = [...commands.values()].filter(
      (command) =>
        command.cursor > afterCursor &&
        !completedCommandCursors.has(command.cursor),
    );

    if (available.length === 0) {
      return new Response(null, { status: 204 });
    }

    return context.json(
      hostDaemonCommandBatchSchema.parse({
        commands: available.sort((left, right) => left.cursor - right.cursor),
      }),
    );
  });
  app.post("/internal/session/command-result", async (context) => {
    const payload = hostDaemonCommandResultReportSchema.parse(
      await context.req.json(),
    );
    commandResultReports.push(payload);
    commandResultAttemptCount += 1;
    if (commandResultAttemptCount <= (options.commandResultFailures ?? 0)) {
      return new Response(JSON.stringify({ ok: false }), {
        status: options.commandResultFailureStatus ?? 500,
        headers: { "content-type": "application/json" },
      });
    }

    completedCommandCursors.add(payload.cursor);
    return context.json({ ok: true });
  });
  app.post("/internal/session/events", async (context) => {
    const payload = hostDaemonEventBatchRequestSchema.parse(
      await context.req.json(),
    );
    events.push(...payload.events);
    for (const event of payload.events) {
      threadHighWaterMarks[event.threadId] = Math.max(
        threadHighWaterMarks[event.threadId] ?? 0,
        event.sequence,
      );
    }
    return context.json({ threadHighWaterMarks });
  });
  app.post("/internal/session/tool-call", async (context) => {
    const payload = hostDaemonToolCallRequestSchema.parse(
      await context.req.json(),
    );
    toolCalls.push({
      sessionId: payload.sessionId,
      tool: payload.tool,
    });
    return context.json({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
  });

  const server = createServer(async (request, response) => {
    await serveHonoRequest(app, request, response);
  });
  const websocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/internal/ws" || !webSocketAvailable) {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      activeSockets.add(websocket);
      websocket.on("message", (data: RawData) => {
        const message = hostDaemonDaemonWsMessageSchema.parse(
          JSON.parse(data.toString("utf8")),
        );
        heartbeats.push({
          sessionId: url.searchParams.get("sessionId") ?? "",
          message: {
            bufferDepth: message.bufferDepth,
            lastCommandCursor: message.lastCommandCursor,
          },
        });
      });
      websocket.on("close", () => {
        activeSockets.delete(websocket);
      });
      websocketServer.emit("connection", websocket, request);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    commandFetches,
    commandResultReports,
    get commandResults() {
      return commandResultReports;
    },
    events,
    heartbeats,
    sessionOpenCalls,
    toolCalls,
    queueCommand(command: HostDaemonCommand): HostDaemonCommandEnvelope {
      const envelope = {
        id: `command-${nextCursor}`,
        cursor: nextCursor,
        command,
      };
      commands.set(nextCursor, envelope);
      nextCursor += 1;
      return envelope;
    },
    sendWebSocketMessage(message: HostDaemonServerWsMessage): void {
      const encoded = JSON.stringify(hostDaemonServerWsMessageSchema.parse(message));
      for (const socket of activeSockets) {
        socket.send(encoded);
      }
    },
    setWebSocketAvailable(available: boolean): void {
      webSocketAvailable = available;
    },
    closeWebSockets(): void {
      for (const socket of activeSockets) {
        socket.close();
      }
    },
    socketCount(): number {
      return activeSockets.size;
    },
    get commandResultAttemptCount() {
      return commandResultAttemptCount;
    },
    async close(): Promise<void> {
      for (const socket of activeSockets) {
        socket.close();
      }
      await new Promise<void>((resolve, reject) => {
        websocketServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
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
