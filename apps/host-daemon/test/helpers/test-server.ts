import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Hono } from "hono";
import {
  HOST_DAEMON_WEBSOCKET_PROTOCOL,
  buildHostDaemonWebSocketAuthorizationHeader,
  hostDaemonEnrollRequestSchema,
  hostDaemonCommandResultReportSchema,
  hostDaemonCommandsQuerySchema,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonEnvironmentChangeRequestSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonInteractiveRequestSchema,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonToolCallRequestSchema,
  type HostDaemonCommand,
  type HostDaemonCommandEnvelope,
  type HostDaemonCommandResultReport,
  type HostDaemonDaemonWsMessage,
  type HostDaemonEnvironmentChangeRequest,
  type HostDaemonEventEnvelope,
  type HostDaemonInteractiveRequest,
  type HostDaemonServerWsMessage,
  type HostDaemonSessionOpenRequest,
  type HostDaemonTrackedThreadTarget,
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

function readHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function getRawCommandId(rawCommand: unknown): string | null {
  if (
    rawCommand != null &&
    typeof rawCommand === "object" &&
    "id" in rawCommand &&
    typeof rawCommand.id === "string"
  ) {
    return rawCommand.id;
  }

  return null;
}

export interface CreateTestServerOptions {
  commandResultFailures?: number;
  commandResultFailureStatus?: number;
  enforceActiveSessions?: boolean;
  heartbeatIntervalMs?: number;
  leaseTimeoutMs?: number;
  trackedThreadTargets?: HostDaemonTrackedThreadTarget[];
}

export interface TestServer {
  baseUrl: string;
  commandFetches: Array<{ sessionId: string }>;
  commandResultReports: HostDaemonCommandResultReport[];
  commandResults: HostDaemonCommandResultReport[];
  eventBatchRequests: Array<{
    events: HostDaemonEventEnvelope[];
    sessionId: string;
  }>;
  environmentChanges: HostDaemonEnvironmentChangeRequest[];
  events: HostDaemonEventEnvelope[];
  heartbeats: Array<{
    sessionId: string;
    message: HostDaemonDaemonWsMessage;
  }>;
  interactiveRequests: HostDaemonInteractiveRequest[];
  rejectedSessionRequests: Array<{
    path: string;
    sessionId: string;
  }>;
  sessionOpenCalls: HostDaemonSessionOpenRequest[];
  toolCalls: Array<{ sessionId: string; tool: string }>;
  queueCommand(command: HostDaemonCommand): HostDaemonCommandEnvelope;
  queueRawCommand(raw: unknown): number;
  sendWebSocketMessage(message: HostDaemonServerWsMessage): void;
  setWebSocketAvailable(available: boolean): void;
  closeWebSockets(): void;
  socketCount(): number;
  close(): Promise<void>;
  readonly commandResultAttemptCount: number;
  readonly enrollKey: string;
  readonly hostKey: string;
}

export async function createTestServer(
  options: CreateTestServerOptions = {},
): Promise<TestServer> {
  const sessionOpenCalls: HostDaemonSessionOpenRequest[] = [];
  const heartbeats: Array<{
    sessionId: string;
    message: HostDaemonDaemonWsMessage;
  }> = [];
  const commandFetches: Array<{ sessionId: string }> = [];
  const commandResultReports: HostDaemonCommandResultReport[] = [];
  const eventBatchRequests: TestServer["eventBatchRequests"] = [];
  const environmentChanges: TestServer["environmentChanges"] = [];
  const toolCalls: Array<{ sessionId: string; tool: string }> = [];
  const interactiveRequests: HostDaemonInteractiveRequest[] = [];
  const rejectedSessionRequests: TestServer["rejectedSessionRequests"] = [];
  const events: HostDaemonEventEnvelope[] = [];
  const activeSockets = new Set<WebSocket>();
  const activeSessionIds = new Set<string>();
  const commands = new Map<number, HostDaemonCommandEnvelope>();
  // Raw commands bypass Zod validation — used to test unknown command types
  const rawCommands = new Map<number, unknown>();
  const fetchedCommandIds = new Set<string>();
  const fetchedRawCommandCursors = new Set<number>();
  const completedCommandIds = new Set<string>();
  let commandResultAttemptCount = 0;
  let nextCursor = 1;
  let nextEventSequence = 1;
  let nextSessionId = 1;
  let webSocketAvailable = true;
  const enrollKey = "enroll-secret";
  const hostKey = "host-secret";

  const app = new Hono();

  function rejectInactiveSession(
    path: string,
    sessionId: string,
  ): Response | null {
    if (!options.enforceActiveSessions || activeSessionIds.has(sessionId)) {
      return null;
    }

    rejectedSessionRequests.push({ path, sessionId });
    return new Response(
      JSON.stringify({
        code: "invalid_session",
        message: "Session is not open",
        retryable: false,
      }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }

  // This fixture intentionally omits session lease expiry and true long-poll
  // semantics. Tests use enforceActiveSessions when they need closed-session
  // behavior to match the real server.
  app.post("/internal/hosts/enroll", async (context) => {
    const authorization = context.req.header("authorization");
    if (authorization !== `Bearer ${enrollKey}`) {
      return new Response(null, { status: 401 });
    }
    const payload = hostDaemonEnrollRequestSchema.parse(
      await context.req.json(),
    );
    return context.json(
      {
        hostId: payload.hostId,
        hostKey,
      },
      201,
    );
  });
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
        trackedThreadTargets: options.trackedThreadTargets ?? [],
      },
      201,
    );
  });
  app.get("/internal/session/commands", (context) => {
    const query = hostDaemonCommandsQuerySchema.parse(context.req.query());
    const rejectedResponse = rejectInactiveSession(
      "/internal/session/commands",
      query.sessionId,
    );
    if (rejectedResponse) {
      return rejectedResponse;
    }
    commandFetches.push({
      sessionId: query.sessionId,
    });

    const available = [...commands.values()].filter(
      (command) =>
        !fetchedCommandIds.has(command.id) &&
        !completedCommandIds.has(command.id),
    );

    const availableRawEntries = [...rawCommands.entries()].filter(
      ([cursor, rawCommand]) =>
        !fetchedRawCommandCursors.has(cursor) &&
        !completedCommandIds.has(getRawCommandId(rawCommand) ?? ""),
    );

    const allCommands = [
      ...available.sort((left, right) => left.cursor - right.cursor),
      ...availableRawEntries.map(([, value]) => value),
    ];

    if (allCommands.length === 0) {
      return new Response(null, { status: 204 });
    }

    for (const command of available) {
      fetchedCommandIds.add(command.id);
    }
    for (const [cursor] of availableRawEntries) {
      fetchedRawCommandCursors.add(cursor);
    }

    // Return raw JSON to avoid schema validation on the server side
    return context.json({ commands: allCommands });
  });
  app.post("/internal/session/command-result", async (context) => {
    const json = await context.req.json();
    // Accept both known (schema-validated) and unknown command type results.
    // Unknown command error reports have a type not in the discriminated union,
    // so we store the raw JSON and skip Zod validation when parsing fails.
    let payload: HostDaemonCommandResultReport;
    const schemaResult = hostDaemonCommandResultReportSchema.safeParse(json);
    if (schemaResult.success) {
      payload = schemaResult.data;
    } else {
      // Store as-is for unknown command error reports
      payload = json as HostDaemonCommandResultReport;
    }
    const rejectedResponse = rejectInactiveSession(
      "/internal/session/command-result",
      payload.sessionId,
    );
    if (rejectedResponse) {
      return rejectedResponse;
    }
    commandResultReports.push(payload);
    commandResultAttemptCount += 1;
    if (commandResultAttemptCount <= (options.commandResultFailures ?? 0)) {
      return new Response(JSON.stringify({ ok: false }), {
        status: options.commandResultFailureStatus ?? 500,
        headers: { "content-type": "application/json" },
      });
    }

    completedCommandIds.add(payload.commandId);
    return context.json({
      ok: true,
    });
  });
  app.post("/internal/session/events", async (context) => {
    const payload = hostDaemonEventBatchRequestSchema.parse(
      await context.req.json(),
    );
    eventBatchRequests.push({
      events: payload.events,
      sessionId: payload.sessionId,
    });
    const rejectedResponse = rejectInactiveSession(
      "/internal/session/events",
      payload.sessionId,
    );
    if (rejectedResponse) {
      return rejectedResponse;
    }
    events.push(...payload.events);
    const acceptedEvents = payload.events.map((event) => ({
      producerEventId: event.producerEventId,
      threadId: event.threadId,
      sequence: nextEventSequence++,
    }));
    return context.json({ acceptedEvents, rejectedEvents: [] });
  });
  app.post("/internal/session/environment-change", async (context) => {
    const payload = hostDaemonEnvironmentChangeRequestSchema.parse(
      await context.req.json(),
    );
    const rejectedResponse = rejectInactiveSession(
      "/internal/session/environment-change",
      payload.sessionId,
    );
    if (rejectedResponse) {
      return rejectedResponse;
    }
    environmentChanges.push(payload);
    return context.json({ ok: true });
  });
  app.post("/internal/session/tool-call", async (context) => {
    const payload = hostDaemonToolCallRequestSchema.parse(
      await context.req.json(),
    );
    const rejectedResponse = rejectInactiveSession(
      "/internal/session/tool-call",
      payload.sessionId,
    );
    if (rejectedResponse) {
      return rejectedResponse;
    }
    toolCalls.push({
      sessionId: payload.sessionId,
      tool: payload.tool,
    });
    return context.json({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
  });
  app.post("/internal/session/interactive-request", async (context) => {
    const payload = hostDaemonInteractiveRequestSchema.parse(
      await context.req.json(),
    );
    const rejectedResponse = rejectInactiveSession(
      "/internal/session/interactive-request",
      payload.sessionId,
    );
    if (rejectedResponse) {
      return rejectedResponse;
    }
    interactiveRequests.push(payload);
    return context.json({
      outcome: "created",
      interactionId: `interaction-${interactiveRequests.length}`,
      status: "pending",
    });
  });

  const server = createServer(async (request, response) => {
    await serveHonoRequest(app, request, response);
  });
  const websocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      url.pathname !== "/internal/ws" ||
      !webSocketAvailable ||
      readHeaderValue(request.headers.authorization) !==
        buildHostDaemonWebSocketAuthorizationHeader(hostKey) ||
      readHeaderValue(request.headers["sec-websocket-protocol"]) !==
        HOST_DAEMON_WEBSOCKET_PROTOCOL
    ) {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(
      request,
      socket,
      head,
      (websocket: WebSocket) => {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        activeSockets.add(websocket);
        activeSessionIds.add(sessionId);
        websocket.on("message", (data: RawData) => {
          const message = hostDaemonDaemonWsMessageSchema.parse(
            JSON.parse(data.toString("utf8")),
          );
          heartbeats.push({
            sessionId,
            message,
          });
        });
        websocket.on("close", () => {
          activeSockets.delete(websocket);
          activeSessionIds.delete(sessionId);
        });
        websocketServer.emit("connection", websocket, request);
      },
    );
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
    eventBatchRequests,
    environmentChanges,
    events,
    heartbeats,
    interactiveRequests,
    rejectedSessionRequests,
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
    queueRawCommand(raw: unknown): number {
      const cursor = nextCursor;
      rawCommands.set(cursor, raw);
      nextCursor += 1;
      return cursor;
    },
    sendWebSocketMessage(message: HostDaemonServerWsMessage): void {
      const encoded = JSON.stringify(
        hostDaemonServerWsMessageSchema.parse(message),
      );
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
    enrollKey,
    hostKey,
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
