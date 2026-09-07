import type {
  InfiniteData,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import type { ThreadListEntry } from "@bb/domain";

export type ThreadListCacheData =
  | ThreadListEntry[]
  | InfiniteData<ThreadListEntry[]>;

function isThreadListEntryArray(value: unknown): value is ThreadListEntry[] {
  return Array.isArray(value);
}

function isInfiniteThreadListData(
  value: unknown,
): value is InfiniteData<ThreadListEntry[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "pages" in value &&
    Array.isArray((value as { pages: unknown }).pages)
  );
}

export function* iterateThreadListCacheEntries(
  data: ThreadListCacheData | undefined,
): Iterable<ThreadListEntry> {
  if (!data) {
    return;
  }
  if (isThreadListEntryArray(data)) {
    for (const entry of data) {
      yield entry;
    }
    return;
  }
  for (const page of data.pages) {
    for (const entry of page) {
      yield entry;
    }
  }
}

function mapThreadListCacheData<T extends ThreadListCacheData>(
  data: T,
  mapper: (list: ThreadListEntry[]) => ThreadListEntry[],
): T {
  if (isThreadListEntryArray(data)) {
    return mapper(data) as T;
  }
  return { ...data, pages: data.pages.map(mapper) } as T;
}

function isThreadListCacheData(value: unknown): value is ThreadListCacheData {
  return isThreadListEntryArray(value) || isInfiniteThreadListData(value);
}

interface CachedThreadList {
  queryKey: QueryKey;
  data: ThreadListCacheData;
}

export type CachedThreadListSnapshot = CachedThreadList[];

interface ThreadListCacheQueryOptions {
  queryKey: QueryKey;
}

interface ApplyToCachedThreadListsOptions extends ThreadListCacheQueryOptions {
  mapper: (list: ThreadListEntry[]) => ThreadListEntry[];
}

export function getCachedThreadLists(
  queryClient: QueryClient,
  options: ThreadListCacheQueryOptions,
): CachedThreadList[] {
  const result: CachedThreadList[] = [];
  for (const [queryKey, data] of queryClient.getQueriesData({
    queryKey: options.queryKey,
  })) {
    if (!isThreadListCacheData(data)) {
      continue;
    }
    result.push({ queryKey, data });
  }
  return result;
}

export function restoreCachedThreadLists(
  queryClient: QueryClient,
  snapshot: CachedThreadListSnapshot,
): void {
  for (const { queryKey, data } of snapshot) {
    queryClient.setQueryData(queryKey, data);
  }
}

export function applyToCachedThreadLists(
  queryClient: QueryClient,
  options: ApplyToCachedThreadListsOptions,
): void {
  for (const { queryKey, data } of getCachedThreadLists(queryClient, {
    queryKey: options.queryKey,
  })) {
    queryClient.setQueryData(
      queryKey,
      mapThreadListCacheData(data, options.mapper),
    );
  }
}
