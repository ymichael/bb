import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { ThreadEvent } from "@bb/domain";
import { readCommandCursor } from "./command-cursor.js";
import { startHostDaemon } from "./index.js";
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
  type HostDaemonSessionOpenRequest,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

type ProviderAdapter = ReturnType<NonNullable<AgentRuntimeOptions["adapterFactory"]>>;

const tempDirs: string[] = [];

const FAKE_PROVIDER_SCRIPT = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const threads = new Map();
let nextProviderThreadId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && !message.method) {
    return;
  }

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = message.params?.threadId ?? "unknown";
    const providerThreadId = "prov-" + nextProviderThreadId++;
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { providerThreadId },
    });
    send({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: { threadId, providerThreadId },
    });
    return;
  }

  if (message.method === "thread/resume") {
    const threadId = message.params?.threadId ?? "unknown";
    const providerThreadId =
      message.params?.providerThreadId ?? "prov-" + nextProviderThreadId++;
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { providerThreadId },
    });
    return;
  }

  if (message.method === "turn/start") {
    const threadId = message.params?.threadId ?? "unknown";
    const thread = threads.get(threadId);
    if (!thread) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Unknown thread: " + threadId },
      });
      return;
    }

    thread.turnCount += 1;
    const turnId = "turn-" + thread.turnCount;
    const inputText = (message.params?.input ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ");
    const delayMatch = /delay:(\\d+)/.exec(inputText);
    const delayMs = delayMatch ? Number(delayMatch[1]) : 0;

    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId,
        turnId,
        providerThreadId: thread.providerThreadId,
      },
    });

    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId,
          turnId,
          providerThreadId: thread.providerThreadId,
          status: "completed",
        },
      });
    }, delayMs);
    return;
  }

  if (message.method === "thread/name/set" || message.method === "thread/stop") {
    if (message.method === "thread/stop") {
      threads.delete(message.params?.threadId ?? "unknown");
    }
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    return;
  }
});
`;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createFakeAdapter(scriptPath: string): ProviderAdapter {
  return {
    id: "fake",
    displayName: "Fake Provider",
    capabilities: { supportsRename: true, supportsServiceTier: false },
    process: { command: "node", args: [scriptPath] },
    buildCommand(command) {
      switch (command.type) {
        case "initialize":
          return { jsonrpc: "2.0", method: "initialize", params: {} };
        case "thread/start":
          return {
            jsonrpc: "2.0",
            method: "thread/start",
            params: { threadId: command.threadId, input: command.input },
          };
        case "thread/resume":
          return {
            jsonrpc: "2.0",
            method: "thread/resume",
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
            },
          };
        case "turn/start":
          return {
            jsonrpc: "2.0",
            method: "turn/start",
            params: { threadId: command.threadId, input: command.input },
          };
        case "thread/name/set":
          return {
            jsonrpc: "2.0",
            method: "thread/name/set",
            params: { threadId: command.threadId, title: command.title },
          };
        case "thread/stop":
          return {
            jsonrpc: "2.0",
            method: "thread/stop",
            params: { threadId: command.threadId },
          };
        default:
          return null;
      }
    },
    translateEvent(event): ThreadEvent[] {
      const message = event as { method?: string; params?: Record<string, unknown> };
      if (!message.method || !message.params) {
        return [];
      }

      const threadId = String(message.params.threadId ?? "");
      const providerThreadId = String(message.params.providerThreadId ?? "");

      switch (message.method) {
        case "thread/identity":
          return [
            {
              type: "thread/identity",
              threadId,
              providerThreadId,
            } satisfies ThreadEvent,
          ];
        case "turn/started":
          return [
            {
              type: "turn/started",
              threadId,
              turnId: String(message.params.turnId ?? ""),
              providerThreadId,
            } satisfies ThreadEvent,
          ];
        case "turn/completed":
          return [
            {
              type: "turn/completed",
              threadId,
              turnId: String(message.params.turnId ?? ""),
              providerThreadId,
              status: "completed",
            } satisfies ThreadEvent,
          ];
        default:
          return [];
      }
    },
    decodeToolCallRequest() {
      return null;
    },
    async listModels() {
      return [
        {
          id: "fake-model",
          model: "fake-model",
          displayName: "Fake Model",
          description: "Fake model for daemon integration tests",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium" as const,
              description: "Medium",
            },
          ],
          defaultReasoningEffort: "medium" as const,
          isDefault: true,
        },
      ];
    },
  };
}

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
  const honoRequest = new Request(new URL(request.url ?? "/", "http://127.0.0.1"), {
    method: request.method,
    headers: request.headers as HeadersInit,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : body.toString("utf8"),
  });
  const honoResponse = await app.fetch(honoRequest);

  response.statusCode = honoResponse.status;
  honoResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  response.end(Buffer.from(await honoResponse.arrayBuffer()));
}

async function createFixtureServer() {
  const sessionOpenCalls: HostDaemonSessionOpenRequest[] = [];
  const heartbeats: Array<{
    sessionId: string;
    message: { bufferDepth: number; lastCommandCursor?: number };
  }> = [];
  const commandFetches: Array<{ sessionId: string; afterCursor: number }> = [];
  const commandResults: HostDaemonCommandResultReport[] = [];
  const events: HostDaemonEventEnvelope[] = [];
  const threadHighWaterMarks: Record<string, number> = {};
  const commands = new Map<number, HostDaemonCommandEnvelope>();
  const completedCommandCursors = new Set<number>();
  const activeSockets = new Set<WebSocket>();
  let nextSessionId = 1;
  let nextCursor = 1;

  const app = new Hono();
  app.post("/internal/session/open", async (context) => {
    const payload = hostDaemonSessionOpenRequestSchema.parse(await context.req.json());
    sessionOpenCalls.push(payload);
    return context.json(
      {
        sessionId: `session-${nextSessionId++}`,
        heartbeatIntervalMs: 25,
        leaseTimeoutMs: 1_000,
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
    const payload = hostDaemonCommandResultReportSchema.parse(await context.req.json());
    commandResults.push(payload);
    completedCommandCursors.add(payload.cursor);
    return context.json({ ok: true });
  });
  app.post("/internal/session/events", async (context) => {
    const payload = hostDaemonEventBatchRequestSchema.parse(await context.req.json());
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
    hostDaemonToolCallRequestSchema.parse(await context.req.json());
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
    if (url.pathname !== "/internal/ws") {
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
    throw new Error("Failed to bind fixture server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessionOpenCalls,
    heartbeats,
    commandFetches,
    commandResults,
    events,
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
    closeSockets(): void {
      for (const socket of activeSockets) {
        socket.close();
      }
    },
    socketCount(): number {
      return activeSockets.size;
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

async function setupDaemonHarness() {
  const dataDir = await makeTempDir("bb-host-daemon-data-");
  const workspaceRoot = await makeTempDir("bb-host-daemon-workspaces-");
  const scriptPath = path.join(workspaceRoot, "fake-provider.cjs");
  await fs.writeFile(scriptPath, FAKE_PROVIDER_SCRIPT, "utf8");

  const envAPath = path.join(workspaceRoot, "env-a");
  const envBPath = path.join(workspaceRoot, "env-b");
  await fs.mkdir(envAPath, { recursive: true });
  await fs.mkdir(envBPath, { recursive: true });

  const server = await createFixtureServer();
  const daemon = await startHostDaemon({
    dataDir,
    serverUrl: server.baseUrl,
    authToken: "secret",
    enableLocalApi: false,
    createInstanceId: () => "instance-1",
    adapterFactory: () => createFakeAdapter(scriptPath),
  });

  await waitFor(() => server.sessionOpenCalls.length === 1);

  return {
    dataDir,
    server,
    daemon,
    envAPath,
    envBPath,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("host daemon integration", () => {
  it("opens a session, sends heartbeats, and advances the command cursor after command results", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        type: "thread.start",
        environmentId: "env-a",
        threadId: "thread-a",
        workspacePath: harness.envAPath,
        projectId: "project-1",
        providerId: "fake",
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(() => harness.server.commandResults.length === 1);
      await waitFor(() => harness.server.heartbeats.length > 0);

      expect(harness.server.commandResults[0]).toMatchObject({
        cursor: 1,
        type: "thread.start",
        ok: true,
      });
      expect(harness.server.heartbeats[0]?.sessionId).toBe("session-1");
      expect(await readCommandCursor(harness.dataDir)).toBe(1);
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("posts provider events to the server and prunes the buffer after acknowledgment", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        type: "thread.start",
        environmentId: "env-a",
        threadId: "thread-a",
        workspacePath: harness.envAPath,
        projectId: "project-1",
        providerId: "fake",
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 1);

      harness.server.queueCommand({
        type: "turn.run",
        environmentId: "env-a",
        threadId: "thread-a",
        input: [{ type: "text", text: "hello" }],
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(() =>
        harness.server.events.some(
          (event) =>
            event.threadId === "thread-a" &&
            event.event.type === "turn/completed",
        ),
      );
      await waitFor(() =>
        harness.server.heartbeats.some(
          (heartbeat) => heartbeat.message.bufferDepth === 0,
        ),
      );

      expect(
        harness.server.events
          .filter((event) => event.threadId === "thread-a")
          .map((event) => event.event.type),
      ).toContain("turn/completed");
      expect(await readCommandCursor(harness.dataDir)).toBe(2);
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("reopens the session after websocket disconnects and resumes fetching from the persisted cursor", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        type: "thread.start",
        environmentId: "env-a",
        threadId: "thread-a",
        workspacePath: harness.envAPath,
        projectId: "project-1",
        providerId: "fake",
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 1);
      expect(await readCommandCursor(harness.dataDir)).toBe(1);

      harness.server.closeSockets();
      await waitFor(() => harness.server.sessionOpenCalls.length === 2);
      await waitFor(() => harness.server.socketCount() === 1);

      harness.server.queueCommand({
        type: "thread.rename",
        environmentId: "env-a",
        threadId: "thread-a",
        title: "Renamed after reconnect",
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(() => harness.server.commandResults.length === 2);

      expect(
        harness.server.commandFetches.some(
          (fetch) => fetch.sessionId === "session-2" && fetch.afterCursor === 1,
        ),
      ).toBe(true);
      expect(await readCommandCursor(harness.dataDir)).toBe(2);
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("routes events to the correct environment across multiple runtimes", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        type: "thread.start",
        environmentId: "env-a",
        threadId: "thread-a",
        workspacePath: harness.envAPath,
        projectId: "project-1",
        providerId: "fake",
      });
      harness.server.queueCommand({
        type: "thread.start",
        environmentId: "env-b",
        threadId: "thread-b",
        workspacePath: harness.envBPath,
        projectId: "project-1",
        providerId: "fake",
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 2);

      harness.server.queueCommand({
        type: "turn.run",
        environmentId: "env-a",
        threadId: "thread-a",
        input: [{ type: "text", text: "delay:200 slow" }],
      });
      harness.server.queueCommand({
        type: "turn.run",
        environmentId: "env-b",
        threadId: "thread-b",
        input: [{ type: "text", text: "fast" }],
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(() =>
        harness.server.events.some(
          (event) =>
            event.threadId === "thread-a" &&
            event.event.type === "turn/completed",
        ) &&
        harness.server.events.some(
          (event) =>
            event.threadId === "thread-b" &&
            event.event.type === "turn/completed",
        ),
      );

      const completedEvents = harness.server.events.filter(
        (event) => event.event.type === "turn/completed",
      );
      expect(completedEvents.find((event) => event.threadId === "thread-a")?.environmentId).toBe(
        "env-a",
      );
      expect(completedEvents.find((event) => event.threadId === "thread-b")?.environmentId).toBe(
        "env-b",
      );
      expect(completedEvents[0]?.threadId).toBe("thread-b");
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });
});
