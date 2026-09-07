import type { ChangedMessage, EnvironmentChangeKind } from "@bb/domain";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";

const IGNORED_ENVIRONMENT_CHANGES: ReadonlySet<EnvironmentChangeKind> = new Set(
  ["metadata-changed", "thread-storage-changed"],
);

interface CacheEntry<TValue> {
  expiresAt: number;
  hostId: string;
  value: TValue;
}

interface InFlightEntry<TValue> {
  hostId: string;
  promise: Promise<TValue>;
}

interface EnvironmentReadCacheReadArgs<TValue> {
  environmentId: string;
  hostId: string;
  key: string;
  load: () => Promise<TValue>;
}

interface EnvironmentReadCacheOptions {
  now: () => number;
  ttlMs: number;
}

interface EnvironmentReadCacheInvalidation {
  invalidateAll(): void;
  invalidateEnvironment(environmentId: string): void;
  invalidateHost(hostId: string): void;
}

export class EnvironmentReadCache<
  TValue,
> implements EnvironmentReadCacheInvalidation {
  private readonly entries = new Map<string, CacheEntry<TValue>>();
  private readonly inFlight = new Map<string, InFlightEntry<TValue>>();

  constructor(private readonly options: EnvironmentReadCacheOptions) {}

  read(args: EnvironmentReadCacheReadArgs<TValue>): Promise<TValue> {
    const cacheKey = `${args.environmentId} ${args.key}`;
    const cached = this.entries.get(cacheKey);
    if (cached && cached.expiresAt > this.options.now()) {
      return Promise.resolve(cached.value);
    }
    if (cached) {
      this.entries.delete(cacheKey);
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending.promise;
    }

    const promise = args.load().then(
      (value) => {
        if (this.inFlight.get(cacheKey)?.promise === promise) {
          this.inFlight.delete(cacheKey);
          this.entries.set(cacheKey, {
            expiresAt: this.options.now() + this.options.ttlMs,
            hostId: args.hostId,
            value,
          });
        }
        return value;
      },
      (error: unknown) => {
        if (this.inFlight.get(cacheKey)?.promise === promise) {
          this.inFlight.delete(cacheKey);
        }
        throw error;
      },
    );
    this.inFlight.set(cacheKey, { hostId: args.hostId, promise });
    return promise;
  }

  invalidateEnvironment(environmentId: string): void {
    const prefix = `${environmentId} `;
    this.dropWhere((cacheKey) => cacheKey.startsWith(prefix));
  }

  invalidateHost(hostId: string): void {
    this.dropWhere((_cacheKey, entryHostId) => entryHostId === hostId);
  }

  invalidateAll(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private dropWhere(
    predicate: (cacheKey: string, hostId: string) => boolean,
  ): void {
    for (const [cacheKey, entry] of this.entries) {
      if (predicate(cacheKey, entry.hostId)) {
        this.entries.delete(cacheKey);
      }
    }
    for (const [cacheKey, entry] of this.inFlight) {
      if (predicate(cacheKey, entry.hostId)) {
        this.inFlight.delete(cacheKey);
      }
    }
  }
}

const WORKSPACE_STATUS_CACHE_TTL_MS = 3_000;
const WORKSPACE_PULL_REQUEST_CACHE_TTL_MS = 10_000;

interface WorkspaceReadCachesDeps {
  hub: {
    onChangedMessage(listener: (message: ChangedMessage) => void): () => void;
  };
  now?: () => number;
}

export class WorkspaceReadCaches {
  readonly status: EnvironmentReadCache<
    HostDaemonOnlineRpcResult<"workspace.status">
  >;
  readonly pullRequest: EnvironmentReadCache<
    HostDaemonOnlineRpcResult<"workspace.pull_request">
  >;

  constructor(deps: WorkspaceReadCachesDeps) {
    const now = deps.now ?? Date.now;
    this.status = new EnvironmentReadCache({
      now,
      ttlMs: WORKSPACE_STATUS_CACHE_TTL_MS,
    });
    this.pullRequest = new EnvironmentReadCache({
      now,
      ttlMs: WORKSPACE_PULL_REQUEST_CACHE_TTL_MS,
    });
    deps.hub.onChangedMessage((message) => {
      this.handleChangedMessage(message);
    });
  }

  private get caches(): EnvironmentReadCacheInvalidation[] {
    return [this.status, this.pullRequest];
  }

  invalidateEnvironment(environmentId: string): void {
    for (const cache of this.caches) {
      cache.invalidateEnvironment(environmentId);
    }
  }

  invalidateHost(hostId: string): void {
    for (const cache of this.caches) {
      cache.invalidateHost(hostId);
    }
  }

  private invalidateAll(): void {
    for (const cache of this.caches) {
      cache.invalidateAll();
    }
  }

  private handleChangedMessage(message: ChangedMessage): void {
    if (message.entity === "environment") {
      const relevant = message.changes.some(
        (change) => !IGNORED_ENVIRONMENT_CHANGES.has(change),
      );
      if (!relevant) {
        return;
      }
      if (message.id === undefined) {
        this.invalidateAll();
      } else {
        this.invalidateEnvironment(message.id);
      }
      return;
    }
    if (message.entity === "host") {
      if (message.id === undefined) {
        this.invalidateAll();
      } else {
        this.invalidateHost(message.id);
      }
    }
  }
}
