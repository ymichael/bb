import { createServer } from "node:http";
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
      });
    expect(deliveredSequences).toEqual([[1]]);
  });
});
