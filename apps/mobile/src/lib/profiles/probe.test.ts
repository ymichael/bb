import { describe, expect, it } from "vitest";
import { probeServer, type ProbeFetch } from "./probe";

function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown; throws?: Error }>,
): ProbeFetch & { calls: string[] } {
  const calls: string[] = [];
  const impl: ProbeFetch = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    if (route.throws) throw route.throws;
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (route.body === undefined) throw new SyntaxError("not json");
        return route.body;
      },
    };
  };
  return Object.assign(impl, { calls });
}

const config = { serverUrl: "http://127.0.0.1:20304", primaryHostId: "host-1" };

describe("probeServer", () => {
  it("probes /health then /system/config and keeps the entered URL", async () => {
    const fetchImpl = fakeFetch({
      "/health": { body: { ok: true } },
      "/api/v1/system/config": { body: config },
    });
    const result = await probeServer("http://192.168.1.20:20304/", fetchImpl);
    expect(result).toEqual({
      ok: true,
      serverUrl: "http://192.168.1.20:20304",
      primaryHostId: "host-1",
      advertisedServerUrl: null,
    });
    expect(fetchImpl.calls).toEqual([
      "http://192.168.1.20:20304/health",
      "http://192.168.1.20:20304/api/v1/system/config",
    ]);
  });

  it("surfaces a differing non-loopback advertised URL without adopting it", async () => {
    const fetchImpl = fakeFetch({
      "/health": { body: { ok: true } },
      "/api/v1/system/config": {
        body: { serverUrl: "https://mac.tail.ts.net/", primaryHostId: null },
      },
    });
    const result = await probeServer("http://192.168.1.20:20304", fetchImpl);
    expect(result).toEqual({
      ok: true,
      serverUrl: "http://192.168.1.20:20304",
      primaryHostId: null,
      advertisedServerUrl: "https://mac.tail.ts.net",
    });
  });

  it("reports the health stage when the host is unreachable", async () => {
    const fetchImpl = fakeFetch({
      "/health": { throws: new TypeError("Network request failed") },
    });
    expect(await probeServer("http://10.0.0.5:1", fetchImpl)).toEqual({
      ok: false,
      serverUrl: "http://10.0.0.5:1",
      stage: "health",
      error: "Network request failed",
    });
  });

  it("rejects a non-bb server that answers /health with something else", async () => {
    const fetchImpl = fakeFetch({ "/health": { body: "<html>" } });
    expect(await probeServer("https://example.com", fetchImpl)).toMatchObject({
      ok: false,
      stage: "health",
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("reports the config stage for an auth-gated or broken server", async () => {
    const fetchImpl = fakeFetch({
      "/health": { body: { ok: true } },
      "/api/v1/system/config": { status: 401 },
    });
    expect(await probeServer("https://me.getbb.app", fetchImpl)).toEqual({
      ok: false,
      serverUrl: "https://me.getbb.app",
      stage: "config",
      error: "HTTP 401",
    });
  });
});
