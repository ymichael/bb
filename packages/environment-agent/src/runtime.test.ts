import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
} from "./protocol.js";
import { EnvironmentAgentRuntime } from "./runtime.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    await fn?.();
  }
});

describe("EnvironmentAgentRuntime", () => {
  it("appends replayable sequenced events", () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "codex",
      providerArgs: ["app-server"],
    });

    runtime.appendEvent({
      type: "environment.ready",
      threadId: "thread-1",
    });
    runtime.appendEvent({
      type: "workspace.status.changed",
      threadId: "thread-1",
    });

    const replay = runtime.replay({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      afterSequence: 0,
    });

    expect(replay.events).toHaveLength(2);
    expect(replay.toSequenceInclusive).toBe(2);
    expect(replay.events[0]?.sequence).toBe(1);
  });

  it("tracks acknowledged sequence progress", () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "codex",
      providerArgs: ["app-server"],
    });
    runtime.appendEvent({
      type: "environment.ready",
      threadId: "thread-1",
    });
    runtime.appendEvent({
      type: "workspace.status.changed",
      threadId: "thread-1",
    });

    const ack = runtime.acknowledge({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence: 1,
      threadId: "thread-1",
    });
    const status = runtime.getStatusSnapshot();

    expect(ack.acknowledgedSequence).toBe(1);
    expect(status.lastAckedSequence).toBe(1);
    expect(status.pendingEventCount).toBe(1);
  });

  it("normalizes provider notifications into replayable provider events", () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "codex",
      providerArgs: ["app-server"],
    });

    runtime.appendEvent({
      type: "provider.event",
      threadId: "thread-1",
      method: "turn/started",
      payload: { turnId: "turn-1" },
    });

    const replay = runtime.replay({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      afterSequence: 0,
    });

    expect(replay.events[0]?.event).toMatchObject({
      type: "provider.event",
      method: "turn/started",
      payload: { turnId: "turn-1" },
    });
  });

  it("does not require a provider at startup when launched in control-plane mode", () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
    });

    expect(runtime.start()).toBeNull();
    expect(runtime.getProviderStatus()).toEqual({
      running: false,
      launched: false,
    });
  });

  it("materializes launch env and auth files before spawning the provider", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "beanbag-env-agent-runtime-"));
    cleanup.push(() => rm(tempHome, { recursive: true, force: true }));

    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
    });
    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);

    runtime.ensureProviderStatus({
      command: "node",
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const authPath = path.join(process.env.HOME, '.codex', 'auth.json');",
          "console.log(JSON.stringify({",
          "  apiKey: process.env.OPENAI_API_KEY,",
          "  authFile: fs.readFileSync(authPath, 'utf8')",
          "}));",
        ].join(""),
      ],
      env: {
        HOME: tempHome,
        OPENAI_API_KEY: "sk-test-123",
      },
      files: [
        {
          placement: "home",
          path: ".codex/auth.json",
          content: '{"auth_mode":"chatgpt"}',
        },
      ],
    });

    await expect.poll(() => lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      apiKey: "sk-test-123",
      authFile: '{"auth_mode":"chatgpt"}',
    });
    await expect(readFile(join(tempHome, ".codex", "auth.json"), "utf8")).resolves.toBe(
      '{"auth_mode":"chatgpt"}',
    );
  });

  it("accepts explicit commands and forwards them to the provider transport", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "node",
      providerArgs: [
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "let buffer='';",
          "process.stdin.on('data',chunk=>{",
          "buffer+=chunk;",
          "const parts=buffer.split(/\\r\\n|\\n|\\r/g);",
          "buffer=parts.pop() ?? '';",
          "for (const line of parts) {",
          "if (!line.trim()) continue;",
          "const msg = JSON.parse(line);",
          "if (msg.method === 'initialize') {",
          "console.log(JSON.stringify({ id: msg.id, result: { capabilities: {} } }));",
          "} else if (msg.method === 'thread/start') {",
          "console.log(JSON.stringify({ id: msg.id, result: { thread: { id: 'provider-thread-1' } } }));",
          "}",
          "}",
          "});",
        ].join(""),
      ],
    });
    const lines: string[] = [];
    const unsubscribe = runtime.subscribeToProviderStdout((line) => {
      lines.push(line);
    });
    cleanup.push(unsubscribe);

    const ack = await runtime.executeCommand({
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        commandId: "cmd-1",
        idempotencyKey: "idem-1",
        sentAt: Date.now(),
        threadId: "thread-1",
        projectId: "project-1",
      },
      command: {
        type: "thread.start",
        threadId: "thread-1",
        projectId: "project-1",
        params: { cwd: "/tmp/project" },
        initialize: {
          method: "initialize",
          params: { clientInfo: { name: "beanbag", version: "0.0.1" } },
        },
      },
    });

    expect(ack.state).toBe("accepted");
    expect(ack.result).toEqual({ thread: { id: "provider-thread-1" } });
    await expect.poll(() => lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      id: 1,
      result: { capabilities: {} },
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      id: 2,
      result: { thread: { id: "provider-thread-1" } },
    });
  });

  it("pushes buffered events back to the daemon and advances the ack cursor", async () => {
    const deliveredSequences: number[][] = [];
    const daemon = createServer((request, response) => {
      if (request.url !== "/threads/thread-1/environment-agent/deliver") {
        response.writeHead(404);
        response.end();
        return;
      }

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as {
          events: Array<{ sequence: number }>;
        };
        deliveredSequences.push(parsed.events.map((event) => event.sequence));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            threadId: "thread-1",
            acknowledgedSequence:
              parsed.events[parsed.events.length - 1]?.sequence ?? 0,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          daemon.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = daemon.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve daemon server address");
    }

    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      daemonConnection: {
        daemonUrl: `http://${address.address}:${address.port}`,
        authToken: "secret-token",
        threadId: "thread-1",
      },
    });

    runtime.start();

    await expect
      .poll(() => runtime.getStatusSnapshot())
      .toMatchObject({
        connectedToDaemon: true,
        pendingEventCount: 0,
        lastAckedSequence: 1,
        deliveryState: "healthy",
        retryAttemptCount: 0,
      });
    expect(deliveredSequences).toEqual([[1]]);
  });

  it("preserves daemon base path prefixes when pushing buffered events", async () => {
    const deliveredPaths: string[] = [];
    const daemon = createServer((request, response) => {
      deliveredPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          threadId: "thread-1",
          acknowledgedSequence: 1,
        }),
      );
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          daemon.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = daemon.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve daemon server address");
    }

    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      daemonConnection: {
        daemonUrl: `http://${address.address}:${address.port}/api/v1`,
        authToken: "secret-token",
        threadId: "thread-1",
      },
    });

    runtime.start();

    await expect.poll(() => deliveredPaths).toEqual([
      "/api/v1/threads/thread-1/environment-agent/deliver",
    ]);
  });

  it("stalls delivery when the daemon reports a sequence gap without progress", async () => {
    let requestCount = 0;
    const daemon = createServer((request, response) => {
      if (request.url !== "/threads/thread-1/environment-agent/deliver") {
        response.writeHead(404);
        response.end();
        return;
      }

      requestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          threadId: "thread-1",
          acknowledgedSequence: 0,
          state: "stalled",
          reason: "sequence_gap",
          message: "cursor gap",
        }),
      );
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          daemon.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = daemon.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve daemon server address");
    }

    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      daemonConnection: {
        daemonUrl: `http://${address.address}:${address.port}`,
        authToken: "secret-token",
        threadId: "thread-1",
      },
    });

    runtime.start();

    await expect
      .poll(() => runtime.getStatusSnapshot())
      .toMatchObject({
        connectedToDaemon: true,
        pendingEventCount: 1,
        deliveryState: "stalled",
        deliveryIssue: "sequence_gap",
        lastDeliveryError: "cursor gap",
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requestCount).toBe(1);
  });

  it("stops delivery when the daemon marks the thread as ineligible", async () => {
    let requestCount = 0;
    const daemon = createServer((request, response) => {
      if (request.url !== "/threads/thread-1/environment-agent/deliver") {
        response.writeHead(404);
        response.end();
        return;
      }

      requestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          threadId: "thread-1",
          acknowledgedSequence: 0,
          state: "stopped",
          reason: "thread_archived",
          message: "archived",
        }),
      );
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          daemon.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = daemon.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve daemon server address");
    }

    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      daemonConnection: {
        daemonUrl: `http://${address.address}:${address.port}`,
        authToken: "secret-token",
        threadId: "thread-1",
      },
    });

    runtime.start();

    await expect
      .poll(() => runtime.getStatusSnapshot())
      .toMatchObject({
        connectedToDaemon: true,
        pendingEventCount: 1,
        deliveryState: "stopped",
        deliveryIssue: "thread_archived",
        lastDeliveryError: "archived",
      });

    runtime.appendEvent({
      type: "workspace.status.changed",
      threadId: "thread-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requestCount).toBe(1);
  });
});
