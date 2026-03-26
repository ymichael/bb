import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAdapter } from "@bb/agent-runtime/test";
import { readCommandCursor } from "../../src/command-cursor.js";
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
        workspacePath: harness.envAPath,
        projectId: "project-1",
        providerId: "fake",
        providerThreadId: "provider-thread-a",
        eventSequence: 1,
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
      await waitForCursor(harness.dataDir, 1);

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
      await waitForCursor(harness.dataDir, 2);
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
        workspacePath: harness.envAPath,
        projectId: "project-1",
        providerId: "fake",
        providerThreadId: "provider-thread-a",
        eventSequence: 1,
        input: [{ type: "text", text: "delay:200 slow" }],
      });
      harness.server.queueCommand({
        type: "turn.run",
        environmentId: "env-b",
        threadId: "thread-b",
        workspacePath: harness.envBPath,
        projectId: "project-1",
        providerId: "fake",
        providerThreadId: "provider-thread-b",
        eventSequence: 1,
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
