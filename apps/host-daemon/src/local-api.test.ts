import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonLocalClient } from "@bb/host-daemon-contract";
import { startLocalApiServer, type LocalApiServer } from "./local-api.js";

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

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves host identity and status over localhost", async () => {
    server = await startLocalApiServer({
      hostId: "host-1",
      port: 0,
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart: () => undefined,
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const hostIdResponse = await client["host-id"].$get();
    const statusResponse = await client.status.$get();

    expect(await hostIdResponse.json()).toEqual({ hostId: "host-1" });
    expect(await statusResponse.json()).toEqual({
      connected: true,
      serverUrl: "http://server.test",
    });
  });

  it("delegates open and folder-pick operations to the provided callbacks", async () => {
    const openPath = vi.fn(async () => undefined);
    const pickFolder = vi.fn(async () => "/tmp/project");
    server = await startLocalApiServer({
      hostId: "host-1",
      port: 0,
      serverUrl: "http://server.test",
      getConnected: () => false,
      openPath,
      pickFolder,
      restart: () => undefined,
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    await client.open.$post({ json: { path: "/tmp/file.ts" } });
    const pickFolderResponse = await client["pick-folder"].$post({});

    expect(openPath).toHaveBeenCalledWith("/tmp/file.ts");
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(await pickFolderResponse.json()).toEqual({ path: "/tmp/project" });
  });

  it("schedules a restart after acknowledging the request", async () => {
    const restart = vi.fn(async () => undefined);
    server = await startLocalApiServer({
      hostId: "host-1",
      port: 0,
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart,
      scheduleRestart: (callback) => {
        setTimeout(callback, 0);
      },
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client.restart.$post({});
    expect(response.ok).toBe(true);
    await waitFor(() => restart.mock.calls.length === 1);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
