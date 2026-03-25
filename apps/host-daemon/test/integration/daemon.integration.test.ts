import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { ThreadEvent } from "@bb/domain";
import { readCommandCursor } from "../../src/command-cursor.js";
import { startHostDaemon } from "../../src/index.js";
import {
  createTestServer,
} from "../helpers/test-server.js";

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

async function waitForCursor(
  dataDir: string,
  expectedCursor: number,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while ((await readCommandCursor(dataDir)) !== expectedCursor) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for command cursor");
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

async function setupDaemonHarness() {
  const dataDir = await makeTempDir("bb-host-daemon-data-");
  const workspaceRoot = await makeTempDir("bb-host-daemon-workspaces-");
  const scriptPath = path.join(workspaceRoot, "fake-provider.cjs");
  await fs.writeFile(scriptPath, FAKE_PROVIDER_SCRIPT, "utf8");

  const envAPath = path.join(workspaceRoot, "env-a");
  const envBPath = path.join(workspaceRoot, "env-b");
  await fs.mkdir(envAPath, { recursive: true });
  await fs.mkdir(envBPath, { recursive: true });

  const server = await createTestServer({
    threadHighWaterMarks: {},
  });
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
      await waitForCursor(harness.dataDir, 1);
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

      harness.server.closeWebSockets();
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
