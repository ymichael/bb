import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createHttpEnvironmentAgentClient } from "./client.js";
import { createEnvironmentAgentHttpServer } from "./http-server.js";
import { EnvironmentAgentRuntime } from "./runtime.js";
import { ENVIRONMENT_AGENT_PROTOCOL_VERSION } from "./protocol.js";

describe("environment-agent HTTP transport", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      await fn?.();
    }
  });

  it("serves status and replay over HTTP", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "codex",
      providerArgs: ["app-server"],
    });
    runtime.appendEvent({
      type: "environment.ready",
      threadId: "thread-1",
    });
    const server = await createEnvironmentAgentHttpServer({
      runtime,
      bearerToken: "test-token",
    });
    cleanup.push(() => server.close());

    const client = await createHttpEnvironmentAgentClient({
      baseUrl: server.baseUrl,
      headers: {
        authorization: "Bearer test-token",
      },
    });

    await expect(client.status()).resolves.toMatchObject({
      latestSequence: 1,
      pendingEventCount: 1,
    });
    await expect(
      client.replay({
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        afterSequence: 0,
      }),
    ).resolves.toMatchObject({
      toSequenceInclusive: 1,
      events: [
        expect.objectContaining({
          sequence: 1,
        }),
      ],
    });

    client.close();
  });

  it("can start a provider on demand over HTTP", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
    });
    runtime.start();
    const server = await createEnvironmentAgentHttpServer({
      runtime,
      bearerToken: "test-token",
    });
    cleanup.push(() => server.close());

    const client = await createHttpEnvironmentAgentClient({
      baseUrl: server.baseUrl,
      headers: {
        authorization: "Bearer test-token",
      },
    });

    await expect(
      client.ensureProviderRunning({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{for (const line of d.trim().split(/\\n/)) { if (!line) continue; console.log(line); }});",
        ],
      }),
    ).resolves.toMatchObject({
      running: true,
      launched: true,
      pid: expect.any(Number),
    });

    client.close();
  });

  it("streams provider lines over HTTP", async () => {
    const received: string[] = [];
    const upstream = createServer((request, response) => {
      if (request.url === "/provider" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
      providerCommand: "node",
      providerArgs: [
        "-e",
        "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{for (const line of d.trim().split(/\\n/)) { if (!line) continue; console.log(line); }});",
      ],
    });
    runtime.start();
    const server = await createEnvironmentAgentHttpServer({
      runtime,
      bearerToken: "test-token",
    });
    cleanup.push(() => server.close());

    const client = await createHttpEnvironmentAgentClient({
      baseUrl: server.baseUrl,
      headers: {
        authorization: "Bearer test-token",
      },
    });
    client.providerTransport.setHandlers({
      onLine(line) {
        received.push(line);
      },
    });

    client.providerTransport.send('{"jsonrpc":"2.0","method":"turn/started","params":{}}');

    await expect.poll(() => received).toContain(
      '{"jsonrpc":"2.0","method":"turn/started","params":{}}',
    );
    client.close();
  });

  it("rejects unauthenticated requests", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
    });
    runtime.start();
    const server = await createEnvironmentAgentHttpServer({
      runtime,
      bearerToken: "test-token",
    });
    cleanup.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/control/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
  });
});
