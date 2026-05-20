import { describe, expect, it, vi } from "vitest";
import { createAppVersionService } from "../../src/services/system/app-version.js";
import { testLogger } from "../helpers/test-app.js";

interface StubFetchOptions {
  body?: unknown;
  ok?: boolean;
  status?: number;
  throwError?: Error;
}

interface FetchCall {
  url: string;
  signal: AbortSignal | null;
}

function createStubFetch(
  responses: StubFetchOptions[],
  calls: FetchCall[],
): typeof fetch {
  let index = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
    calls.push({ url, signal: init?.signal ?? null });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response.throwError) {
      throw response.throwError;
    }
    return new Response(
      response.body === undefined ? "" : JSON.stringify(response.body),
      {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
}

describe("createAppVersionService", () => {
  it("skips the npm lookup in development mode", async () => {
    const calls: FetchCall[] = [];
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: true },
      fetchImpl: createStubFetch([{ body: { version: "0.0.6" } }], calls),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response).toEqual({
      currentVersion: "0.0.5",
      isDevelopment: true,
      latestVersion: null,
      source: "npm",
      updateAvailable: false,
      upgradeCommand: "npx bb-app@latest",
    });
    expect(calls).toEqual([]);
  });

  it("reports updateAvailable=true when npm latest is greater", async () => {
    const calls: FetchCall[] = [];
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.6" } }], calls),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBe("0.0.6");
    expect(response.updateAvailable).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://registry.npmjs.org/bb-app/latest");
  });

  it("reports updateAvailable=false when versions are equal", async () => {
    const service = createAppVersionService({
      config: { appVersion: "0.0.6", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.6" } }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBe("0.0.6");
    expect(response.updateAvailable).toBe(false);
  });

  it("reports updateAvailable=false when local is ahead of npm latest", async () => {
    const service = createAppVersionService({
      config: { appVersion: "9.9.9", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.6" } }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBe("0.0.6");
    expect(response.updateAvailable).toBe(false);
  });

  it("returns latestVersion=null when npm fails and there is no cache", async () => {
    const warn = vi.fn();
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch(
        [{ throwError: new Error("network down") }],
        [],
      ),
      logger: { ...testLogger, warn },
    });
    const response = await service.getSystemVersion();
    expect(response).toEqual({
      currentVersion: "0.0.5",
      isDevelopment: false,
      latestVersion: null,
      source: "npm",
      updateAvailable: false,
      upgradeCommand: "npx bb-app@latest",
    });
    expect(warn).toHaveBeenCalled();
  });

  it("returns latestVersion=null when npm returns a non-200 status", async () => {
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch([{ ok: false, status: 429, body: {} }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBeNull();
    expect(response.updateAvailable).toBe(false);
  });

  it("returns latestVersion=null when npm returns an unexpected payload", async () => {
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { unexpected: true } }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBeNull();
  });

  it("returns latestVersion but updateAvailable=false when current version is not semver", async () => {
    const service = createAppVersionService({
      config: { appVersion: "totally-not-semver", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.6" } }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBe("0.0.6");
    expect(response.updateAvailable).toBe(false);
  });

  it("caches the npm result and avoids repeat fetches inside the TTL", async () => {
    const calls: FetchCall[] = [];
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch(
        [{ body: { version: "0.0.6" } }, { body: { version: "0.0.7" } }],
        calls,
      ),
      logger: testLogger,
    });
    const first = await service.getSystemVersion();
    const second = await service.getSystemVersion();
    expect(first.latestVersion).toBe("0.0.6");
    expect(second.latestVersion).toBe("0.0.6");
    expect(calls).toHaveLength(1);
  });

  it("re-fetches once the TTL has expired", async () => {
    const calls: FetchCall[] = [];
    let currentTime = 1_000;
    const service = createAppVersionService({
      cacheTtlMs: 100,
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch(
        [{ body: { version: "0.0.6" } }, { body: { version: "0.0.7" } }],
        calls,
      ),
      logger: testLogger,
      now: () => currentTime,
    });
    const first = await service.getSystemVersion();
    currentTime += 1_000;
    const second = await service.getSystemVersion();
    expect(first.latestVersion).toBe("0.0.6");
    expect(second.latestVersion).toBe("0.0.7");
    expect(calls).toHaveLength(2);
  });

  it("dedupes concurrent inflight requests", async () => {
    const calls: FetchCall[] = [];
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.6" } }], calls),
      logger: testLogger,
    });
    const [first, second] = await Promise.all([
      service.getSystemVersion(),
      service.getSystemVersion(),
    ]);
    expect(first.latestVersion).toBe("0.0.6");
    expect(second.latestVersion).toBe("0.0.6");
    expect(calls).toHaveLength(1);
  });

  it("returns latestVersion=null after TTL expiry even if the prior cache held a value (no stale fallback)", async () => {
    // Locks in Sawyer's iteration decision (2026-05-20): choice A —
    // null on failure rather than serving the stale cached value.
    const calls: FetchCall[] = [];
    let currentTime = 1_000;
    const service = createAppVersionService({
      cacheTtlMs: 100,
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch(
        [
          { body: { version: "0.0.6" } },
          { throwError: new Error("npm down later") },
        ],
        calls,
      ),
      logger: testLogger,
      now: () => currentTime,
    });
    const first = await service.getSystemVersion();
    expect(first.latestVersion).toBe("0.0.6");
    currentTime += 1_000;
    const second = await service.getSystemVersion();
    expect(second.latestVersion).toBeNull();
    expect(second.updateAvailable).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("treats a published prerelease latest as an update when local is the stable predecessor", async () => {
    // semver.gt("0.0.6-alpha.1", "0.0.5") === true. If npm `latest` is a
    // prerelease, trust npm.
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.6-alpha.1" } }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBe("0.0.6-alpha.1");
    expect(response.updateAvailable).toBe(true);
  });

  it("does not flag updateAvailable when local is the stable that follows a published prerelease", async () => {
    // semver.gt("0.0.5-alpha.1", "0.0.5") === false.
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.5-alpha.1" } }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBe("0.0.5-alpha.1");
    expect(response.updateAvailable).toBe(false);
  });

  it("ignores semver build metadata when comparing equal versions", async () => {
    // semver.gt("0.0.5+build.1", "0.0.5") === false; build metadata is
    // ignored by precedence rules.
    const service = createAppVersionService({
      config: { appVersion: "0.0.5", isDevelopment: false },
      fetchImpl: createStubFetch([{ body: { version: "0.0.5+build.1" } }], []),
      logger: testLogger,
    });
    const response = await service.getSystemVersion();
    expect(response.latestVersion).toBe("0.0.5+build.1");
    expect(response.updateAvailable).toBe(false);
  });
});
