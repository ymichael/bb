import type { z } from "zod";

const QUERY_SNAPSHOT_STORAGE_ROOT = "bb-tasks:query-snapshot:";
const QUERY_SNAPSHOT_STORAGE_VERSION = "v1";
const QUERY_SNAPSHOT_STORAGE_PREFIX = `${QUERY_SNAPSHOT_STORAGE_ROOT}${QUERY_SNAPSHOT_STORAGE_VERSION}:`;

export function querySnapshotStorageKey(name: string): string {
  return `${QUERY_SNAPSHOT_STORAGE_PREFIX}${name}`;
}

let prunedOtherVersions = false;

const claimedRevisions = new Map<string, number>();
const writtenRevisions = new Map<string, number>();

export function resetQuerySnapshotStateForTest(): void {
  prunedOtherVersions = false;
  claimedRevisions.clear();
  writtenRevisions.clear();
}

export function claimQuerySnapshotRevision(name: string): number {
  const revision = (claimedRevisions.get(name) ?? 0) + 1;
  claimedRevisions.set(name, revision);
  return revision;
}

function pruneOtherSnapshotVersions(): void {
  if (prunedOtherVersions) return;
  prunedOtherVersions = true;
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key !== null &&
        key.startsWith(QUERY_SNAPSHOT_STORAGE_ROOT) &&
        !key.startsWith(QUERY_SNAPSHOT_STORAGE_PREFIX)
      ) {
        stale.push(key);
      }
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {}
}

export function readQuerySnapshot<T>(
  name: string,
  schema: z.ZodType<T>,
): T | undefined {
  pruneOtherSnapshotVersions();
  try {
    const raw = window.localStorage.getItem(querySnapshotStorageKey(name));
    if (raw === null) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeQuerySnapshot(
  name: string,
  value: unknown,
  revision: number,
): void {
  pruneOtherSnapshotVersions();
  if (revision < (writtenRevisions.get(name) ?? 0)) return;
  writtenRevisions.set(name, revision);
  try {
    window.localStorage.setItem(
      querySnapshotStorageKey(name),
      JSON.stringify(value),
    );
  } catch {}
}
