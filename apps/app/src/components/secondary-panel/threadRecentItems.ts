import { useCallback } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { z } from "zod";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";

const THREAD_RECENT_ITEMS_STORAGE_PREFIX = "bb.thread.recentItems";
const THREAD_RECENT_ITEMS_STORAGE_VERSION = 1;
const THREAD_RECENT_ITEMS_MAX_STORED = 24;
export const THREAD_RECENT_ITEMS_VISIBLE_LIMIT = 6;

type RecentItemSource = "workspace" | "thread-storage";

export interface ThreadRecentItem {
  source: RecentItemSource;
  path: string;
  openedAt: number;
}

interface RecordRecentItemArgs {
  items: readonly ThreadRecentItem[];
  source: RecentItemSource;
  path: string;
  openedAt: number;
  limit?: number;
}

interface RecordThreadRecentItemArgs {
  source: RecentItemSource;
  path: string;
}

interface ThreadRecentItemsStorageKeyArgs {
  threadId: string;
}

const recentItemSchema = z
  .object({
    source: z.enum(["workspace", "thread-storage"]),
    path: z.string().min(1),
    openedAt: z.number().int().nonnegative(),
  })
  .strict();

const recentItemsSchema = z.array(recentItemSchema);

const EMPTY_RECENT_ITEMS: readonly ThreadRecentItem[] = [];

export function recordRecentItem({
  items,
  source,
  path,
  openedAt,
  limit = THREAD_RECENT_ITEMS_MAX_STORED,
}: RecordRecentItemArgs): ThreadRecentItem[] {
  const withoutExisting = items.filter(
    (item) => item.source !== source || item.path !== path,
  );
  return [{ source, path, openedAt }, ...withoutExisting].slice(0, limit);
}

const recentItemsStorage = createLocalStorageSyncStorage<
  readonly ThreadRecentItem[]
>({
  parse: (storedValue, initialValue) => {
    if (storedValue === null) {
      return initialValue;
    }
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(storedValue);
    } catch {
      return initialValue;
    }
    const result = recentItemsSchema.safeParse(parsedValue);
    if (!result.success) {
      return initialValue;
    }
    return result.data.slice(0, THREAD_RECENT_ITEMS_MAX_STORED);
  },
  serialize: (value) => JSON.stringify(value),
});

export function getThreadRecentItemsStorageKey({
  threadId,
}: ThreadRecentItemsStorageKeyArgs): string {
  return `${THREAD_RECENT_ITEMS_STORAGE_PREFIX}-${encodeURIComponent(
    threadId,
  )}-${THREAD_RECENT_ITEMS_STORAGE_VERSION}`;
}

const disabledThreadRecentItemsAtom =
  atom<readonly ThreadRecentItem[]>(EMPTY_RECENT_ITEMS);

const threadRecentItemsAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<readonly ThreadRecentItem[]>(
    getThreadRecentItemsStorageKey({ threadId }),
    EMPTY_RECENT_ITEMS,
    recentItemsStorage,
    { getOnInit: true },
  ),
);

function hasThreadId(threadId: string | null | undefined): threadId is string {
  return threadId !== null && threadId !== undefined && threadId.length > 0;
}

function getThreadRecentItemsAtom(threadId: string | null | undefined) {
  return hasThreadId(threadId)
    ? threadRecentItemsAtomFamily(threadId)
    : disabledThreadRecentItemsAtom;
}

export function useThreadRecentItems(
  threadId: string | null | undefined,
): readonly ThreadRecentItem[] {
  return useAtomValue(getThreadRecentItemsAtom(threadId));
}

export function useRecordThreadRecentItem(
  threadId: string | null | undefined,
): (args: RecordThreadRecentItemArgs) => void {
  const setRecentItems = useSetAtom(getThreadRecentItemsAtom(threadId));
  return useCallback(
    ({ source, path }: RecordThreadRecentItemArgs) => {
      if (!hasThreadId(threadId)) {
        return;
      }
      setRecentItems((items) =>
        recordRecentItem({ items, source, path, openedAt: Date.now() }),
      );
    },
    [setRecentItems, threadId],
  );
}
