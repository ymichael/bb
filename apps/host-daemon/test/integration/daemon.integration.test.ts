import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAdapter } from "@bb/agent-runtime/test";
import { startHostDaemon } from "../../src/index.js";
import {
  createTestServer,
} from "../helpers/test-server.js";

const tempDirs: string[] = [];

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

function createStandardThreadStartCommand(args: {
  environmentId: string;
  eventSequence: number;
  input: Array<{ text: string; type: "text" }>;
  projectId: string;
  providerId: string;
  threadId: string;
  workspacePath: string;
}) {
  return {
    type: "thread.start" as const,
    environmentId: args.environmentId,
    threadId: args.threadId,
    workspaceContext: { workspacePath: args.workspacePath, workspaceProvisionType: "unmanaged" as const },
    projectId: args.projectId,
    providerId: args.providerId,
    eventSequence: args.eventSequence,
    input: args.input,
    options: {
      model: "gpt-5",
      serviceTier: "flex" as const,
      reasoningLevel: "medium" as const,
      sandboxMode: "danger-full-access" as const,
    },
    instructions: "Be a helpful coding agent.",
    dynamicTools: [],
  };
}

function createTurnRunCommand(args: {
  environmentId: string;
  eventSequence: number;
  input: Array<{ text: string; type: "text" }>;
  projectId: string;
  providerId: string;
  providerThreadId: string;
  threadId: string;
  workspacePath: string;
}) {
  return {
    type: "turn.run" as const,
    environmentId: args.environmentId,
    threadId: args.threadId,
    eventSequence: args.eventSequence,
    input: args.input,
    options: {
      model: "gpt-5",
      serviceTier: "flex" as const,
      reasoningLevel: "medium" as const,
      sandboxMode: "danger-full-access" as const,
    },
    resumeContext: {
      workspaceContext: { workspacePath: args.workspacePath, workspaceProvisionType: "unmanaged" as const },
      projectId: args.projectId,
      providerId: args.providerId,
      providerThreadId: args.providerThreadId,
      instructions: "Be a helpful coding agent.",
      dynamicTools: [],
    },
  };
}

async function setupDaemonHarness() {
  const dataDir = await makeTempDir("bb-host-daemon-data-");
  const workspaceRoot = await makeTempDir("bb-host-daemon-workspaces-");

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
    adapterFactory: () => createFakeAdapter(),
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
          eventSequence: 1,
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
          eventSequence: 1,
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 1);

      harness.server.queueCommand({
        ...createTurnRunCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-thread-a",
          eventSequence: 1,
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
          eventSequence: 1,
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

  it("routes events to the correct environment across multiple runtimes", async () => {
    const harness = await setupDaemonHarness();

    try {
      harness.server.queueCommand({
        ...createStandardThreadStartCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          eventSequence: 1,
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
          eventSequence: 1,
          input: [{ type: "text", text: "start" }],
        }),
      });
      harness.server.sendWebSocketMessage({ type: "commands-available" });
      await waitFor(() => harness.server.commandResults.length === 2);

      harness.server.queueCommand({
        ...createTurnRunCommand({
          environmentId: "env-a",
          threadId: "thread-a",
          workspacePath: harness.envAPath,
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-thread-a",
          eventSequence: 1,
          input: [{ type: "text", text: "delay:200 slow" }],
        }),
      });
      harness.server.queueCommand({
        ...createTurnRunCommand({
          environmentId: "env-b",
          threadId: "thread-b",
          workspacePath: harness.envBPath,
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-thread-b",
          eventSequence: 1,
          input: [{ type: "text", text: "fast" }],
        }),
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
    } finally {
      await harness.daemon.shutdown("test");
      await harness.server.close();
    }
  });
});
