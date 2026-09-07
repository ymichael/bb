import type { QueryClient } from "@tanstack/react-query";
import type { DiffPatchEntry } from "@bb/server-contract";
import { HEAVY_PAYLOAD_GC_TIME_MS } from "../queries/query-policies";
import {
  environmentDiffPatchQueryKey,
  environmentDiffPatchQueryKeyPrefix,
} from "../queries/query-keys";

export interface PatchQueryIdentity {
  environmentId: string;
  targetType: string | null;
  targetKey: string | null;
}

const diffPatchEvictionGenerations = new Map<string, number>();

let allEnvironmentsEvictionGeneration = 0;

export function getDiffPatchEvictionGeneration(environmentId: string): number {
  return (
    (diffPatchEvictionGenerations.get(environmentId) ?? 0) +
    allEnvironmentsEvictionGeneration
  );
}

export function bumpDiffPatchEvictionGeneration(environmentId: string): void {
  diffPatchEvictionGenerations.set(
    environmentId,
    (diffPatchEvictionGenerations.get(environmentId) ?? 0) + 1,
  );
}

export function bumpAllDiffPatchEvictionGenerations(): void {
  allEnvironmentsEvictionGeneration += 1;
}

interface ReadDiffPatchEntryArgs {
  queryClient: QueryClient;
  identity: PatchQueryIdentity;
  path: string;
}

export function readDiffPatchEntry({
  queryClient,
  identity,
  path,
}: ReadDiffPatchEntryArgs): DiffPatchEntry | undefined {
  return queryClient.getQueryData<DiffPatchEntry>(
    environmentDiffPatchQueryKey(
      identity.environmentId,
      identity.targetType,
      identity.targetKey,
      path,
    ),
  );
}

interface WriteDiffPatchEntryArgs {
  queryClient: QueryClient;
  identity: PatchQueryIdentity;
  entry: DiffPatchEntry;
}

export function writeDiffPatchEntry({
  queryClient,
  identity,
  entry,
}: WriteDiffPatchEntryArgs): void {
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

interface DiffPatchRetentionLease {
  readers: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

const diffPatchRetentionLeases = new WeakMap<
  QueryClient,
  Map<string, DiffPatchRetentionLease>
>();

function getDiffPatchRetentionLeases(
  queryClient: QueryClient,
): Map<string, DiffPatchRetentionLease> {
  let leases = diffPatchRetentionLeases.get(queryClient);
  if (leases === undefined) {
    leases = new Map();
    diffPatchRetentionLeases.set(queryClient, leases);
  }
  return leases;
}

export function retainDiffPatchQueries({
  queryClient,
  environmentId,
}: {
  queryClient: QueryClient;
  environmentId: string;
}): () => void {
  const leases = getDiffPatchRetentionLeases(queryClient);
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
    if (released) {
      return;
    }
    released = true;
    lease.readers -= 1;
    if (lease.readers > 0) {
      return;
    }
    lease.evictionTimer = setTimeout(() => {
      lease.evictionTimer = null;
      if (lease.readers > 0) {
        return;
      }
      leases.delete(environmentId);
      bumpDiffPatchEvictionGeneration(environmentId);
      queryClient.removeQueries({
        queryKey: environmentDiffPatchQueryKeyPrefix(environmentId),
      });
    }, HEAVY_PAYLOAD_GC_TIME_MS);
  };
}
