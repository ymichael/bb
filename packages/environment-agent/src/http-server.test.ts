import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentAgentHttpServer } from "./http-server.js";
import { EnvironmentAgentRuntime } from "./runtime.js";

describe("environment-agent HTTP transport", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      await fn?.();
    }
  });

  it("serves status over HTTP", async () => {
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
    const response = await fetch(`${server.baseUrl}/control/status`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: "{}",
    });

    await expect(response.json()).resolves.toMatchObject({
      latestSequence: 1,
      pendingEventCount: 1,
    });
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

  it("accepts a session sync poke", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
    });
    const onSessionSyncRequested = vi.fn();
    const server = await createEnvironmentAgentHttpServer({
      runtime,
      bearerToken: "test-token",
      onSessionSyncRequested,
    });
    cleanup.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/control/session-sync`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: expect.objectContaining({
        latestSequence: 0,
        deliveryState: "stopped",
      }),
    });
    expect(onSessionSyncRequested).toHaveBeenCalledTimes(1);
  });

  it("accepts a shutdown poke", async () => {
    const runtime = new EnvironmentAgentRuntime({
      threadId: "thread-1",
    });
    const onShutdownRequested = vi.fn();
    const server = await createEnvironmentAgentHttpServer({
      runtime,
      bearerToken: "test-token",
      onShutdownRequested,
    });
    cleanup.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/control/shutdown`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onShutdownRequested).toHaveBeenCalledTimes(1);
  });
});
