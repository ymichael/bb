import type { SandboxHost } from "@bb/sandbox-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxHostRegistry,
  SANDBOX_HOST_REGISTRY_ENTRY_TTL_MS,
  SANDBOX_HOST_REGISTRY_MAX_ENTRIES,
} from "../../src/services/hosts/sandbox-registry.js";

function createMockSandboxHost(hostId: string): SandboxHost {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    extendTimeout: vi.fn().mockResolvedValue(undefined),
    externalId: `sandbox-${hostId}`,
    hostId,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
  };
}

describe("sandbox host registry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts stale hosts after the cache TTL elapses", () => {
    vi.useFakeTimers();
    const registry = createSandboxHostRegistry();
    const host = createMockSandboxHost("host-stale");

    registry.set(host.hostId, host);
    vi.advanceTimersByTime(SANDBOX_HOST_REGISTRY_ENTRY_TTL_MS + 1);

    expect(registry.get(host.hostId)).toBeUndefined();
  });

  it("evicts the oldest cached hosts once the registry reaches capacity", () => {
    vi.useFakeTimers();
    const registry = createSandboxHostRegistry();

    for (let index = 0; index <= SANDBOX_HOST_REGISTRY_MAX_ENTRIES; index += 1) {
      registry.set(`host-${index}`, createMockSandboxHost(`host-${index}`));
      vi.advanceTimersByTime(1);
    }

    expect(registry.get("host-0")).toBeUndefined();
    expect(registry.get(`host-${SANDBOX_HOST_REGISTRY_MAX_ENTRIES}`)).toMatchObject({
      hostId: `host-${SANDBOX_HOST_REGISTRY_MAX_ENTRIES}`,
    });
  });

  it("deduplicates concurrent getOrCreate loads and caches the resolved host", async () => {
    vi.useFakeTimers();
    const registry = createSandboxHostRegistry();
    const host = createMockSandboxHost("host-concurrent");
    let resolveLoad: ((value: SandboxHost) => void) | null = null;
    const loadHost = vi.fn(
      () =>
        new Promise<SandboxHost>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const firstLoad = registry.getOrCreate(host.hostId, loadHost);
    const secondLoad = registry.getOrCreate(host.hostId, loadHost);

    expect(loadHost).toHaveBeenCalledTimes(1);
    if (!resolveLoad) {
      throw new Error("Expected concurrent load to be pending");
    }
    resolveLoad(host);

    const [firstHost, secondHost] = await Promise.all([firstLoad, secondLoad]);
    expect(firstHost).toBe(host);
    expect(secondHost).toBe(host);
    expect(registry.get(host.hostId)).toBe(host);
  });

  it("refreshes a cached host while deduplicating concurrent reloads", async () => {
    vi.useFakeTimers();
    const registry = createSandboxHostRegistry();
    const staleHost = createMockSandboxHost("host-refresh");
    const refreshedHost = createMockSandboxHost("host-refresh");
    let resolveLoad: ((value: SandboxHost) => void) | null = null;
    const loadHost = vi.fn(
      () =>
        new Promise<SandboxHost>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    registry.set(staleHost.hostId, staleHost);

    const firstRefresh = registry.refresh(staleHost.hostId, loadHost);
    const secondRefresh = registry.refresh(staleHost.hostId, loadHost);

    expect(loadHost).toHaveBeenCalledTimes(1);
    if (!resolveLoad) {
      throw new Error("Expected refresh load to be pending");
    }
    resolveLoad(refreshedHost);

    const [firstHost, secondHost] = await Promise.all([firstRefresh, secondRefresh]);
    expect(firstHost).toBe(refreshedHost);
    expect(secondHost).toBe(refreshedHost);
    expect(registry.get(staleHost.hostId)).toBe(refreshedHost);
  });

  it("applies capacity eviction to hosts loaded through getOrCreate", async () => {
    vi.useFakeTimers();
    const registry = createSandboxHostRegistry();

    for (let index = 0; index < SANDBOX_HOST_REGISTRY_MAX_ENTRIES; index += 1) {
      registry.set(`host-${index}`, createMockSandboxHost(`host-${index}`));
      vi.advanceTimersByTime(1);
    }

    const loadedHost = await registry.getOrCreate(
      "host-loaded",
      async () => createMockSandboxHost("host-loaded"),
    );

    expect(loadedHost.hostId).toBe("host-loaded");
    expect(registry.get("host-0")).toBeUndefined();
    expect(registry.get("host-loaded")).toBe(loadedHost);
  });
});
