import type { QueryClient } from "@tanstack/react-query";
import type { DiffPatchEntry } from "@bb/server-contract";
import {
  environmentDiffPatchQueryKey,
  environmentDiffPatchQueryKeyPrefix,
} from "./query-keys";

export interface PatchQueryIdentity {
  environmentId: string;
  targetType: string | null;
  targetKey: string | null;
}

interface EvictionGenerations {
  perEnvironment: Map<string, number>;
  all: number;
}

const evictionGenerationsByClient = new WeakMap<
  QueryClient,
  EvictionGenerations
>();

function getGenerations(queryClient: QueryClient): EvictionGenerations {
  let generations = evictionGenerationsByClient.get(queryClient);
  if (generations === undefined) {
    generations = { perEnvironment: new Map(), all: 0 };
    evictionGenerationsByClient.set(queryClient, generations);
  }
  return generations;
}

export function getDiffPatchEvictionGeneration(
  queryClient: QueryClient,
  environmentId: string,
): number {
  const generations = getGenerations(queryClient);
  return (generations.perEnvironment.get(environmentId) ?? 0) + generations.all;
}

export function removeEnvironmentDiffPatchQueries(
  queryClient: QueryClient,
  environmentId: string,
): void {
  const generations = getGenerations(queryClient);
  generations.perEnvironment.set(
    environmentId,
    (generations.perEnvironment.get(environmentId) ?? 0) + 1,
  );
  queryClient.removeQueries({
    queryKey: environmentDiffPatchQueryKeyPrefix(environmentId),
  });
}

export function removeAllDiffPatchQueries(queryClient: QueryClient): void {
  const generations = getGenerations(queryClient);
  generations.all += 1;
  queryClient.removeQueries({
    queryKey: [environmentDiffPatchQueryKeyPrefix("")[0]],
  });
}

export function readDiffPatchEntry(
  queryClient: QueryClient,
  identity: PatchQueryIdentity,
  path: string,
): DiffPatchEntry | undefined {
  return queryClient.getQueryData<DiffPatchEntry>(
    environmentDiffPatchQueryKey(
      identity.environmentId,
      identity.targetType,
      identity.targetKey,
      path,
    ),
  );
}

export function writeDiffPatchEntry(
  queryClient: QueryClient,
  identity: PatchQueryIdentity,
  entry: DiffPatchEntry,
): void {
  const queryKey = environmentDiffPatchQueryKey(
    identity.environmentId,
    identity.targetType,
    identity.targetKey,
    entry.path,
  );
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey, gcTime: Infinity });
  queryClient.setQueryData<DiffPatchEntry>(queryKey, entry);
}

const DIFF_PATCH_RETENTION_MS = 2 * 60_000;

interface DiffPatchRetentionLease {
  readers: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

const retentionLeasesByClient = new WeakMap<
  QueryClient,
  Map<string, DiffPatchRetentionLease>
>();

function getRetentionLeases(
  queryClient: QueryClient,
): Map<string, DiffPatchRetentionLease> {
  let leases = retentionLeasesByClient.get(queryClient);
  if (leases === undefined) {
    leases = new Map();
    retentionLeasesByClient.set(queryClient, leases);
  }
  return leases;
}

export function retainDiffPatchQueries(
  queryClient: QueryClient,
  environmentId: string,
  retentionMs: number = DIFF_PATCH_RETENTION_MS,
): () => void {
  const leases = getRetentionLeases(queryClient);
  let lease = leases.get(environmentId);
  if (lease === undefined) {
    lease = { readers: 0, evictionTimer: null };
    leases.set(environmentId, lease);
  }
  if (lease.evictionTimer !== null) {
    clearTimeout(lease.evictionTimer);
    lease.evictionTimer = null;
  }
  lease.readers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lease.readers -= 1;
    if (lease.readers > 0) return;
    lease.evictionTimer = setTimeout(() => {
      lease.evictionTimer = null;
      if (lease.readers > 0) return;
      leases.delete(environmentId);
      removeEnvironmentDiffPatchQueries(queryClient, environmentId);
    }, retentionMs);
  };
}
