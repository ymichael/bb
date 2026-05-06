import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createAgentRuntimeWithAdapters,
  createFakeAdapter,
  type ProviderAdapter,
} from "@bb/agent-runtime/test";
import {
  jsonValueSchema,
  threadEventSchema,
  type JsonValue,
  type ThreadEvent,
} from "@bb/domain";
import { HOST_AUTH_FILE_NAME } from "@bb/host-daemon-contract";
import { startHostDaemon } from "../../src/index.js";
import {
  createTestServer,
  type CreateTestServerOptions,
} from "../helpers/test-server.js";

const tempDirs: string[] = [];
const INTERACTIVE_PROVIDER_TEST_TIMEOUT_MS = 15_000;

interface InteractiveRequestParams {
  command: string;
  cwd: string | null;
  itemId: string;
  reason: string | null;
  threadId: string;
  turnId: string;
}

interface JsonValueObject {
  [key: string]: JsonValue;
}

interface EventSpoolPayloadRow {
  payloadJson: string;
}

interface EventSpoolHasEventArgs {
  dataDir: string;
  eventType: ThreadEvent["type"];
  threadId: string;
}

type EventSpoolLookupParams = [threadId: string, eventType: string];

function parseInteractiveRequestParams(
  value: JsonValue,
): InteractiveRequestParams | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const params: JsonValueObject = value;
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    typeof params.command !== "string"
  ) {
    return null;
  }

  return {
    command: params.command,
    cwd: typeof params.cwd === "string" ? params.cwd : null,
    itemId: params.itemId,
    reason: typeof params.reason === "string" ? params.reason : null,
    threadId: params.threadId,
    turnId: params.turnId,
  };
}

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

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await fs.access(pathToCheck);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function eventSpoolHasEvent(args: EventSpoolHasEventArgs): boolean {
  const spoolPath = path.join(args.dataDir, "event-spool.sqlite");
  if (!existsSync(spoolPath)) {
    return false;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(spoolPath, {
      fileMustExist: true,
      readonly: true,
    });
    const rows = db
      .prepare<EventSpoolLookupParams, EventSpoolPayloadRow>(
        `
          SELECT payloadJson
          FROM outbound_events
          WHERE threadId = ? AND eventType = ?
        `,
      )
      .all(args.threadId, args.eventType);
    return rows.some((row) => {
      const parsed = threadEventSchema.safeParse(JSON.parse(row.payloadJson));
      return (
        parsed.success &&
        parsed.data.threadId === args.threadId &&
        parsed.data.type === args.eventType
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) {
      return false;
    }
    throw error;
  } finally {
    db?.close();
  }
}

async function writeInteractiveProviderScript(
  scriptPath: string,
): Promise<void> {
  await fs.writeFile(
    scriptPath,
    `
const readline = require("node:readline");
const threads = new Map();
const pendingInteractive = new Map();
let nextThreadId = 1;
let nextRequestId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function completeTurn(providerThreadId, turnId, text) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      providerThreadId,
      item: {
        type: "agentMessage",
        id: "msg-" + turnId,
        text,
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: providerThreadId,
      turnId,
      status: "completed",
      providerThreadId,
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id !== undefined && !message.method) {
    const pending = pendingInteractive.get(message.id);
    if (!pending) {
      return;
    }
    pendingInteractive.delete(message.id);
    const decision =
      message.result && message.result.resolution
        ? message.result.resolution.decision
        : "unknown";
    completeTurn(pending.providerThreadId, pending.turnId, "interactive:" + decision);
    return;
  }

  if (message.method === "initialize" || message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "model/list" ? [] : {} });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = message.params.threadId;
    const providerThreadId = "prov-" + String(nextThreadId++);
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId } });
    send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId, providerThreadId } });
    return;
  }

  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const providerThreadId = message.params.providerThreadId || threadId;
    const thread = threads.get(threadId);
    thread.turnCount += 1;
    const turnId = "turn-" + String(thread.turnCount);
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: providerThreadId, turnId, providerThreadId },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    const requestId = nextRequestId++;
    pendingInteractive.set(requestId, { providerThreadId, turnId });
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "request_interaction",
      params: {
        threadId: providerThreadId,
        turnId,
        itemId: "item-host-daemon",
        kind: "command_approval",
        command: "git push",
        cwd: "/tmp/project",
        reason: "Needs approval",
      },
    });
  }
});
`,
    "utf8",
  );
}

async function writeWorkspaceEchoProviderScript(
  scriptPath: string,
): Promise<void> {
  await fs.writeFile(
    scriptPath,
    `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const threads = new Map();
let nextThreadId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function getParams(message) {
  return message && typeof message.params === "object" && message.params !== null
    ? message.params
    : {};
}

function inputText(input) {
  if (!Array.isArray(input)) {
    return "";
  }
  return input
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join(" ");
}

function delayMsForInput(input) {
  const match = /(?:^|\\s)delay:(\\d+)(?:\\s|$)/.exec(inputText(input));
  return match ? Number(match[1]) : 0;
}

function completionGatePathForInput(input) {
  const match = /(?:^|\\s)completionGate:(\\S+)(?:\\s|$)/.exec(inputText(input));
  return match ? match[1] : null;
}

function completeTurn(threadId, turnId, providerThreadId, input) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId,
      turnId,
      providerThreadId,
      item: {
        type: "agentMessage",
        id: "msg-" + turnId,
        text: "workspace:" + path.basename(process.cwd()) + " input:" + inputText(input),
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId,
      turnId,
      providerThreadId,
      status: "completed",
    },
  });
}

function completeTurnWhenReady(threadId, turnId, providerThreadId, input) {
  const gatePath = completionGatePathForInput(input);
  if (gatePath && !fs.existsSync(gatePath)) {
    setTimeout(
      () => completeTurnWhenReady(threadId, turnId, providerThreadId, input),
      10,
    );
    return;
  }

  setTimeout(
    () => completeTurn(threadId, turnId, providerThreadId, input),
    delayMsForInput(input),
  );
}

function beginTurn(threadId, input) {
  const thread = threads.get(threadId);
  if (!thread) {
    return;
  }
  thread.turnCount += 1;
  const turnId = "turn-" + String(thread.turnCount);
  send({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId, turnId, providerThreadId: thread.providerThreadId },
  });
  completeTurnWhenReady(threadId, turnId, thread.providerThreadId, input);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  const params = getParams(message);

  if (message.method === "initialize" || message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: message.method === "model/list" ? [] : {} });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = params.threadId || "unknown";
    const providerThreadId = "prov-" + String(nextThreadId++);
    threads.set(threadId, { providerThreadId, turnCount: 0 });
    send({ jsonrpc: "2.0", id: message.id, result: { providerThreadId } });
    send({ jsonrpc: "2.0", method: "thread/identity", params: { threadId, providerThreadId } });
    if (Array.isArray(params.input) && params.input.length > 0) {
      beginTurn(threadId, params.input);
    }
    return;
  }

  if (message.method === "turn/start") {
    const threadId = params.threadId || "unknown";
    if (!threads.has(threadId)) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Unknown thread: " + threadId } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    beginTurn(threadId, params.input);
  }
});
`,
    "utf8",
  );
}

function createInteractiveRequestAdapter(scriptPath: string): ProviderAdapter {
  const adapter = createFakeAdapter({ scriptPath });
  return {
    ...adapter,
    decodeInteractiveRequest(request) {
      if (request.method !== "request_interaction") {
        return null;
      }
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      const parsedJson = jsonValueSchema.safeParse(request.params);
      if (!parsedJson.success) {
        return null;
      }
      const params = parseInteractiveRequestParams(parsedJson.data);
      if (params === null) {
        return null;
      }

      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: params.threadId,
        turnId: params.turnId,
        payload: {
          subject: {
            kind: "command",
            itemId: params.itemId,
            command: params.command,
            cwd: params.cwd ?? null,
            actions: [],
            sessionGrant: null,
          },
          reason: params.reason ?? null,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
      };
    },
    buildInteractiveResponse({ resolution }) {
      return { resolution };
    },
  };
}

function createStandardThreadStartCommand(args: {
  environmentId: string;
  input: Array<{ text: string; type: "text" }>;
  projectId: string;
  providerId: string;
  requestId: string;
  threadId: string;
  workspacePath: string;
}) {
  return {
    type: "thread.start" as const,
    environmentId: args.environmentId,
    threadId: args.threadId,
    workspaceContext: {
      workspacePath: args.workspacePath,
      workspaceProvisionType: "unmanaged" as const,
    },
    projectId: args.projectId,
    providerId: args.providerId,
    requestId: args.requestId,
    input: args.input,
    options: {
      model: "gpt-5",
      serviceTier: "default" as const,
      reasoningLevel: "medium" as const,
      permissionMode: "full" as const,
      permissionEscalation: null,
    },
    instructions: "Be a helpful coding agent.",
    dynamicTools: [],
    instructionMode: "append" as const,
  };
}

function createTurnSubmitCommand(args: {
  environmentId: string;
  input: Array<{ text: string; type: "text" }>;
  projectId: string;
  providerId: string;
  providerThreadId: string;
  requestId: string;
  threadId: string;
  workspacePath: string;
}) {
  return {
    type: "turn.submit" as const,
    environmentId: args.environmentId,
    threadId: args.threadId,
    requestId: args.requestId,
    input: args.input,
    options: {
      model: "gpt-5",
      serviceTier: "default" as const,
      reasoningLevel: "medium" as const,
      permissionMode: "full" as const,
      permissionEscalation: null,
    },
    resumeContext: {
      workspaceContext: {
        workspacePath: args.workspacePath,
        workspaceProvisionType: "unmanaged" as const,
      },
      projectId: args.projectId,
      providerId: args.providerId,
      providerThreadId: args.providerThreadId,
      instructions: "Be a helpful coding agent.",
      dynamicTools: [],
      instructionMode: "append" as const,
    },
    target: { mode: "start" as const },
  };
}

async function setupDaemonHarness(
  args: {
    adapterFactory?: () => ProviderAdapter;
    serverOptions?: CreateTestServerOptions;
  } = {},
) {
  const dataDir = await makeTempDir("bb-host-daemon-data-");
  const workspaceRoot = await makeTempDir("bb-host-daemon-workspaces-");

  const envAPath = path.join(workspaceRoot, "env-a");
  const envBPath = path.join(workspaceRoot, "env-b");
  await fs.mkdir(envAPath, { recursive: true });
  await fs.mkdir(envBPath, { recursive: true });

  const server = await createTestServer(args.serverOptions);
  const daemon = await startHostDaemon({
    dataDir,
    enrollKey: server.enrollKey,
    serverUrl: server.baseUrl,
    enableLocalApi: false,
    createInstanceId: () => "instance-1",
    createRuntime: (options) =>
      createAgentRuntimeWithAdapters({
        ...options,
        adapterFactory: args.adapterFactory ?? (() => createFakeAdapter()),
      }),
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
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("host daemon integration", () => {
  it("opens a session, sends heartbeats, reports command results, and does not persist a cursor file", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(() => harness.server.commandResults.length === 1);
      await waitFor(() => harness.server.heartbeats.length > 0);

      expect(harness.server.commandResults[0]).toMatchObject({
        type: "thread.start",
        ok: true,
      });
      expect(harness.server.heartbeats[0]?.sessionId).toBe("session-1");
      expect(harness.server.heartbeats[0]?.message).toEqual({
        type: "heartbeat",
      });
      expect(
        await pathExists(path.join(harness.dataDir, "command-cursor")),
      ).toBe(false);
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("posts provider events to the server and prunes the buffer after acknowledgment", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 1);

      harness.server.queueCommand({
        ...createTurnSubmitCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-thread-a",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "hello" }],
        }),
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
          (heartbeat) => heartbeat.message.type === "heartbeat",
        ),
      );

      expect(
        harness.server.events
          .filter((event) => event.threadId === "thread-a")
          .map((event) => event.event.type),
      ).toContain("turn/completed");
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("continues posting provider events across commands without daemon-side sequence state", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 1);
      const startResult = harness.server.commandResults.find(
        (result): result is typeof result & { type: "thread.start" } =>
          result.type === "thread.start",
      );
      if (!startResult || !startResult.ok) {
        throw new Error("Expected thread.start to succeed");
      }
      await waitFor(() =>
        harness.server.events.some((event) => event.threadId === "thread-a"),
      );
      const startEvents = harness.server.events.filter(
        (event) => event.threadId === "thread-a",
      );
      expect(startEvents.length).toBeGreaterThan(0);
      expect(
        startEvents.every((event) =>
          event.producerEventId.startsWith("hdevt_"),
        ),
      ).toBe(true);

      const eventCountBeforeFollowUp = harness.server.events.length;
      harness.server.queueCommand({
        ...createTurnSubmitCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: startResult.result.providerThreadId,
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "follow up" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(() =>
        harness.server.events
          .slice(eventCountBeforeFollowUp)
          .some(
            (event) =>
              event.threadId === "thread-a" &&
              event.event.type === "turn/completed",
          ),
      );
      const followUpEvents = harness.server.events
        .slice(eventCountBeforeFollowUp)
        .filter((event) => event.threadId === "thread-a");
      expect(followUpEvents.length).toBeGreaterThan(0);
      expect(
        new Set([
          ...startEvents.map((event) => event.producerEventId),
          ...followUpEvents.map((event) => event.producerEventId),
        ]).size,
      ).toBe(startEvents.length + followUpEvents.length);
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it(
    "persists provider approvals on the server and resolves them through queued commands",
    async () => {
      const dataDir = await makeTempDir("bb-host-daemon-interactive-provider-");
      const scriptPath = path.join(dataDir, "interactive-provider.cjs");
      await writeInteractiveProviderScript(scriptPath);
      const harness = await setupDaemonHarness({
        adapterFactory: () => createInteractiveRequestAdapter(scriptPath),
      });

      try {
        harness.server.queueCommand({
          ...createStandardThreadStartCommand({
            environmentId: "env-a",
            threadId: "thread-a",
            workspacePath: harness.envAPath,
            projectId: "project-1",
            providerId: "fake",
            requestId: "creq_23456789ab",
            input: [{ type: "text", text: "start" }],
          }),
        });
        harness.server.sendWebSocketMessage({ type: "commands-available" });
        await waitFor(() => harness.server.commandResults.length === 1);

        harness.server.queueCommand({
          ...createTurnSubmitCommand({
            environmentId: "env-a",
            threadId: "thread-a",
            workspacePath: harness.envAPath,
            projectId: "project-1",
            providerId: "fake",
            providerThreadId: "prov-1",
            requestId: "creq_23456789ab",
            input: [{ type: "text", text: "trigger approval" }],
          }),
        });
        harness.server.sendWebSocketMessage({ type: "commands-available" });

        await waitFor(() => harness.server.interactiveRequests.length === 1);
        const interactiveRequest = harness.server.interactiveRequests[0];
        if (!interactiveRequest) {
          throw new Error("Expected an interactive request");
        }
        expect(interactiveRequest.sessionId).toBe("session-1");
        expect(interactiveRequest.interaction).toMatchObject({
          threadId: "thread-a",
          turnId: "turn-1",
          providerId: "fake",
          providerThreadId: "prov-1",
          payload: {
            subject: {
              kind: "command",
              itemId: "item-host-daemon",
              command: "git push",
              cwd: "/tmp/project",
            },
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          },
        });

        harness.server.queueCommand({
          type: "interactive.resolve",
          environmentId: "env-a",
          threadId: "thread-a",
          interactionId: "interaction-1",
          providerId: "fake",
          providerThreadId: interactiveRequest.interaction.providerThreadId,
          providerRequestId: interactiveRequest.interaction.providerRequestId,
          resolution: {
            decision: "allow_for_session",
            grantedPermissions: null,
          },
        });
        harness.server.sendWebSocketMessage({ type: "commands-available" });

        await waitFor(
          () =>
            harness.server.commandResults.some(
              (result) => result.type === "interactive.resolve" && result.ok,
            ) &&
            harness.server.events.some(
              (event) =>
                event.threadId === "thread-a" &&
                event.event.type === "item/completed" &&
                event.event.item.type === "agentMessage" &&
                event.event.item.text === "interactive:allow_for_session",
            ),
        );

        await waitFor(() =>
          harness.server.commandResults.some(
            (result) => result.type === "turn.submit" && result.ok,
          ),
        );
      } finally {
        await harness.daemon.shutdown("test");
        await harness.server.close();
      }
    },
    INTERACTIVE_PROVIDER_TEST_TIMEOUT_MS,
  );

  it("reopens the session after websocket disconnects and resumes fetching pending commands", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 1);

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
          (fetch) => fetch.sessionId === "session-2",
        ),
      ).toBe(true);
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("does not post buffered events with a closed session while reconnecting", async () => {
    const scriptDir = await makeTempDir("bb-host-daemon-reconnect-events-");
    const scriptPath = path.join(scriptDir, "workspace-echo-provider.cjs");
    const completionGatePath = path.join(scriptDir, "complete-turn");
    await writeWorkspaceEchoProviderScript(scriptPath);
    const harness = await setupDaemonHarness({
      adapterFactory: () => createFakeAdapter({ scriptPath }),
      serverOptions: { enforceActiveSessions: true },
    });

    try {
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          requestId: "creq_23456789ab",
          input: [
            {
              type: "text",
              text: `completionGate:${completionGatePath} reconnect event`,
            },
          ],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(() =>
        harness.server.events.some(
          (event) =>
            event.threadId === "thread-a" &&
            event.event.type === "turn/started",
        ),
      );

      const acceptedEventsBeforeDisconnect = harness.server.events.length;
      const eventBatchRequestsBeforeDisconnect =
        harness.server.eventBatchRequests.length;
      harness.server.setWebSocketAvailable(false);
      harness.server.closeWebSockets();
      await waitFor(() => harness.server.socketCount() === 0);

      await fs.writeFile(completionGatePath, "ready", "utf8");
      await waitFor(() =>
        eventSpoolHasEvent({
          dataDir: harness.dataDir,
          eventType: "turn/completed",
          threadId: "thread-a",
        }),
      );

      expect(harness.server.rejectedSessionRequests).toEqual([]);
      expect(harness.server.events).toHaveLength(
        acceptedEventsBeforeDisconnect,
      );
      expect(harness.server.eventBatchRequests).toHaveLength(
        eventBatchRequestsBeforeDisconnect,
      );

      harness.server.setWebSocketAvailable(true);
      await waitFor(() => harness.server.socketCount() === 1);
      await waitFor(() =>
        harness.server.events.some(
          (event) =>
            event.threadId === "thread-a" &&
            event.event.type === "turn/completed",
        ),
      );

      expect(harness.server.rejectedSessionRequests).toEqual([]);
      expect(
        harness.server.eventBatchRequests
          .slice(eventBatchRequestsBeforeDisconnect)
          .map((request) => request.sessionId),
      ).not.toContain("session-1");
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("routes events to the correct environment across multiple runtimes", async () => {
    const scriptDir = await makeTempDir("bb-host-daemon-workspace-provider-");
    const scriptPath = path.join(scriptDir, "workspace-echo-provider.cjs");
    await writeWorkspaceEchoProviderScript(scriptPath);
    const harness = await setupDaemonHarness({
      adapterFactory: () => createFakeAdapter({ scriptPath }),
    });

    try {
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-b",
          threadId: "thread-b",
          workspacePath: harness.envBPath,
          projectId: "project-1",
          providerId: "fake",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 2);

      harness.server.queueCommand({
        ...createTurnSubmitCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-thread-a",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "delay:200 slow" }],
        }),
      });
      harness.server.queueCommand({
        ...createTurnSubmitCommand({
          environmentId: "env-b",
          threadId: "thread-b",
          workspacePath: harness.envBPath,
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-thread-b",
          requestId: "creq_23456789ab",
          input: [{ type: "text", text: "fast" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });

      await waitFor(
        () =>
          harness.server.events.some(
            (event) =>
              event.threadId === "thread-a" &&
              event.event.type === "item/completed" &&
              event.event.item.type === "agentMessage" &&
              event.event.item.text === "workspace:env-a input:delay:200 slow",
          ) &&
          harness.server.events.some(
            (event) =>
              event.threadId === "thread-b" &&
              event.event.type === "item/completed" &&
              event.event.item.type === "agentMessage" &&
              event.event.item.text === "workspace:env-b input:fast",
          ),
      );

      const completedEvents = harness.server.events.filter(
        (event) => event.event.type === "turn/completed",
      );
      expect(new Set(completedEvents.map((event) => event.threadId))).toEqual(
        new Set(["thread-a", "thread-b"]),
      );
      expect(
        harness.server.events.some(
          (event) =>
            event.threadId === "thread-a" &&
            event.event.type === "item/completed" &&
            event.event.item.type === "agentMessage" &&
            event.event.item.text === "workspace:env-a input:delay:200 slow",
        ),
      ).toBe(true);
      expect(
        harness.server.events.some(
          (event) =>
            event.threadId === "thread-b" &&
            event.event.type === "item/completed" &&
            event.event.item.type === "agentMessage" &&
            event.event.item.text === "workspace:env-b input:fast",
        ),
      ).toBe(true);
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });

  it("persists auth state on first run when started with explicit join material", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-first-run-");
    const workspaceRoot = await makeTempDir("bb-host-daemon-workspaces-");
    const envPath = path.join(workspaceRoot, "env-bootstrap");
    await fs.mkdir(envPath, { recursive: true });

    const server = await createTestServer();
    const hostId = "host-local-bootstrap";

    const daemon = await startHostDaemon({
      dataDir,
      enableLocalApi: false,
      createInstanceId: () => "instance-local-bootstrap",
      createRuntime: (options) =>
        createAgentRuntimeWithAdapters({
          ...options,
          adapterFactory: () => createFakeAdapter(),
        }),
      enrollKey: server.enrollKey,
      loadIdentity: async () => ({
        hostId,
        hostName: "Local Bootstrap Host",
      }),
      serverUrl: server.baseUrl,
    });

    try {
      await waitFor(() => server.sessionOpenCalls.length === 1);
      expect(server.sessionOpenCalls[0]?.hostId).toBe(hostId);
      expect(await pathExists(path.join(dataDir, HOST_AUTH_FILE_NAME))).toBe(
        true,
      );
    } finally {
      await daemon.shutdown("test");
      await server.close();
    }
  });
});
