import { useCallback } from "react";
import { atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { z } from "zod";
import { createLocalStorageSyncStorage } from "./browser-storage";

const BROWSER_HISTORY_STORAGE_PREFIX = "bb.thread.browserHistory";
const BROWSER_HISTORY_STORAGE_VERSION = "1";
const BROWSER_HISTORY_MAX_ENTRIES = 24;

const browserHistoryEntrySchema = z
  .object({
    url: z.string().min(1),
    title: z.string().min(1).nullable(),
    visitedAt: z.number().int().nonnegative(),
  })
  .strict();
const browserHistorySchema = z.array(browserHistoryEntrySchema);

export type BrowserHistoryEntry = z.infer<typeof browserHistoryEntrySchema>;

interface RecordBrowserVisitArgs {
  url: string;
  title: string | null;
}

interface BrowserHistoryController {
  entries: readonly BrowserHistoryEntry[];
  recordVisit: (args: RecordBrowserVisitArgs) => void;
  clear: () => void;
}

const EMPTY_BROWSER_HISTORY: readonly BrowserHistoryEntry[] = [];

const browserHistoryStorage = createLocalStorageSyncStorage<
  readonly BrowserHistoryEntry[]
>({
  parse: (storedValue, initialValue) => {
    if (storedValue === null) {
      return initialValue;
    }
    try {
      const parsed = browserHistorySchema.safeParse(JSON.parse(storedValue));
      return parsed.success ? parsed.data : initialValue;
    } catch {
      return initialValue;
    }
  },
  serialize: (value) => JSON.stringify(value),
});

export function getBrowserHistoryStorageKey(threadId: string): string {
  return `${BROWSER_HISTORY_STORAGE_PREFIX}-${encodeURIComponent(
    threadId.trim(),
  )}-${BROWSER_HISTORY_STORAGE_VERSION}`;
}

const disabledBrowserHistoryAtom = atom<readonly BrowserHistoryEntry[]>(
  EMPTY_BROWSER_HISTORY,
);

const browserHistoryAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<readonly BrowserHistoryEntry[]>(
    getBrowserHistoryStorageKey(threadId),
    EMPTY_BROWSER_HISTORY,
    browserHistoryStorage,
    { getOnInit: true },
  ),
);

function hasThreadId(threadId: string | null | undefined): threadId is string {
  return (
    threadId !== null && threadId !== undefined && threadId.trim().length > 0
  );
}

export function useBrowserHistory(
  threadId: string | null | undefined,
): BrowserHistoryController {
  const historyAtom = hasThreadId(threadId)
    ? browserHistoryAtomFamily(threadId)
    : disabledBrowserHistoryAtom;
  const [entries, setEntries] = useAtom(historyAtom);

  const recordVisit = useCallback(
    ({ url, title }: RecordBrowserVisitArgs) => {
      if (url.length === 0) {
        return;
      }
      setEntries((current) => {
        const next: BrowserHistoryEntry = {
          url,
          title,
          visitedAt: Date.now(),
        };
        const withoutDuplicate = current.filter((entry) => entry.url !== url);
        return [next, ...withoutDuplicate].slice(
          0,
          BROWSER_HISTORY_MAX_ENTRIES,
        );
      });
    },
    [setEntries],
  );

  const clear = useCallback(() => {
    setEntries(EMPTY_BROWSER_HISTORY);
  }, [setEntries]);

  return { entries, recordVisit, clear };
}
