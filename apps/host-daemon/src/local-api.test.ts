import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonLocalClient } from "@bb/host-daemon-contract";
import { startLocalApiServer, type LocalApiServer } from "./local-api.js";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("local API server", () => {
  let server: LocalApiServer | null = null;

  function createLocalApiConfig(
    overrides: Partial<HostDaemonLocalApiConfig> = {},
  ): HostDaemonLocalApiConfig {
    return {
      bindHost: "localhost",
      healthPath: "/health",
      healthValue: "ok",
      mode: "full",
      port: 0,
      ...overrides,
    };
  }

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves host identity and status over localhost", async () => {
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const statusResponse = await client.status.$get();

    expect(await statusResponse.json()).toEqual({
      hostId: "host-1",
      connected: true,
      serverUrl: "http://server.test",
      supportsNativeFolderPicker: process.platform === "darwin",
    });
    const healthResponse = await client.health.$get();
    expect(await healthResponse.text()).toBe("ok");
  });

  it("delegates open and folder-pick operations to the provided callbacks", async () => {
    const openPath = vi.fn(async () => undefined);
    const pickFolder = vi.fn(async () => "/tmp/project");
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => false,
      openPath,
      pickFolder,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const statusResponse = await client.status.$get();
    await client["open-path"].$post({ json: { path: "/tmp" } });
    const pickFolderResponse = await client["pick-folder"].$post({});

    expect(await statusResponse.json()).toMatchObject({
      supportsNativeFolderPicker: true,
    });
    expect(openPath).toHaveBeenCalledWith("/tmp");
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(await pickFolderResponse.json()).toEqual({ path: "/tmp/project" });
  });

  it("schedules a restart after acknowledging the request", async () => {
    const restart = vi.fn(async () => undefined);
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart,
      listActiveThreads: () => [],
      scheduleRestart: (callback) => {
        setTimeout(callback, 0);
      },
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client.restart.$post({ json: {} });
    expect(response.ok).toBe(true);
    await waitFor(() => restart.mock.calls.length === 1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("rejects restart with 409 when threads are active and force is not set", async () => {
    const restart = vi.fn(async () => undefined);
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart,
      listActiveThreads: () => [{ threadId: "thread-1" }],
      scheduleRestart: (callback) => {
        setTimeout(callback, 0);
      },
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client.restart.$post({ json: {} });
    expect(response.status).toBe(409);
    expect(restart).not.toHaveBeenCalled();
  });

  it("allows restart with force even when threads are active", async () => {
    const restart = vi.fn(async () => undefined);
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart,
      listActiveThreads: () => [{ threadId: "thread-1" }],
      scheduleRestart: (callback) => {
        setTimeout(callback, 0);
      },
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client.restart.$post({ json: { force: true } });
    expect(response.ok).toBe(true);
    await waitFor(() => restart.mock.calls.length === 1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("supports health-only mode for sandbox hosts", async () => {
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig({
        bindHost: "127.0.0.1",
        healthPath: "/ready",
        healthValue: "bb-host-daemon",
        mode: "health-only",
      }),
      serverUrl: "http://server.test",
      getConnected: () => true,
      listActiveThreads: () => [],
      restart: () => undefined,
    });

    const healthResponse = await fetch(`http://127.0.0.1:${server.port}/ready`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe("bb-host-daemon");

    const client = createHostDaemonLocalClient(`http://127.0.0.1:${server.port}`);
    const statusResponse = await client.status.$get();
    expect(statusResponse.status).toBe(404);
  });
});
