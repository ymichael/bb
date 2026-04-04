import type { SandboxHost } from "@bb/sandbox-host";

export type SandboxHostLoader = () => Promise<SandboxHost>;

interface SandboxHostRegistryEntry {
  host: SandboxHost;
  lastTouchedAt: number;
}

export interface SandboxHostRegistry {
  get(hostId: string): SandboxHost | undefined;
  getOrCreate(
    hostId: string,
    loadHost: SandboxHostLoader,
  ): Promise<SandboxHost>;
  refresh(hostId: string, loadHost: SandboxHostLoader): Promise<SandboxHost>;
  remove(hostId: string): void;
  set(hostId: string, host: SandboxHost): void;
}

export const SANDBOX_HOST_REGISTRY_ENTRY_TTL_MS = 30 * 60 * 1000;
export const SANDBOX_HOST_REGISTRY_MAX_ENTRIES = 128;

export function createSandboxHostRegistry(): SandboxHostRegistry {
  const hosts = new Map<string, SandboxHostRegistryEntry>();
  const pendingHosts = new Map<string, Promise<SandboxHost>>();

  function pruneExpiredEntries(now: number): void {
    for (const [hostId, entry] of hosts) {
      if (now - entry.lastTouchedAt > SANDBOX_HOST_REGISTRY_ENTRY_TTL_MS) {
        hosts.delete(hostId);
      }
    }
  }

  function touchHost(hostId: string, host: SandboxHost, now: number): SandboxHost {
    hosts.set(hostId, { host, lastTouchedAt: now });
    return host;
  }

  function loadAndCacheHost(
    hostId: string,
    loadHost: SandboxHostLoader,
  ): Promise<SandboxHost> {
    const pending = pendingHosts.get(hostId);
    if (pending) {
      return pending;
    }

    const loadingHost = loadHost()
      .then((host) => {
        if (pendingHosts.get(hostId) === loadingHost) {
          touchHost(hostId, host, Date.now());
          enforceMaxEntries();
        }
        return hosts.get(hostId)?.host ?? host;
      })
      .finally(() => {
        if (pendingHosts.get(hostId) === loadingHost) {
          pendingHosts.delete(hostId);
        }
      });
    pendingHosts.set(hostId, loadingHost);
    return loadingHost;
  }

  function enforceMaxEntries(): void {
    if (hosts.size <= SANDBOX_HOST_REGISTRY_MAX_ENTRIES) {
      return;
    }

    const oldestEntries = [...hosts.entries()]
      .sort((left, right) => left[1].lastTouchedAt - right[1].lastTouchedAt)
      .slice(0, hosts.size - SANDBOX_HOST_REGISTRY_MAX_ENTRIES);
    for (const [hostId] of oldestEntries) {
      hosts.delete(hostId);
    }
  }

  return {
    get(hostId: string): SandboxHost | undefined {
      const now = Date.now();
      pruneExpiredEntries(now);
      const cached = hosts.get(hostId);
      if (!cached) {
        return undefined;
      }
      return touchHost(hostId, cached.host, now);
    },
    getOrCreate(
      hostId: string,
      loadHost: SandboxHostLoader,
    ): Promise<SandboxHost> {
      const now = Date.now();
      pruneExpiredEntries(now);
      const cached = hosts.get(hostId);
      if (cached) {
        return Promise.resolve(touchHost(hostId, cached.host, now));
      }

      return loadAndCacheHost(hostId, loadHost);
    },
    refresh(hostId: string, loadHost: SandboxHostLoader): Promise<SandboxHost> {
      pruneExpiredEntries(Date.now());
      hosts.delete(hostId);
      return loadAndCacheHost(hostId, loadHost);
    },
    remove(hostId: string): void {
      pendingHosts.delete(hostId);
      hosts.delete(hostId);
    },
    set(hostId: string, host: SandboxHost): void {
      pruneExpiredEntries(Date.now());
      pendingHosts.delete(hostId);
      touchHost(hostId, host, Date.now());
      enforceMaxEntries();
    },
  };
}
