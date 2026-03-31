import { atom, useAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageSyncStorage } from "./browser-storage";

const THREAD_SHOW_ALL_EVENTS_STORAGE_KEY_PREFIX = "bb.thread.showAllEvents";

const threadShowAllEventsStorage = createLocalStorageSyncStorage<boolean>({
  parse: (storedValue, initialValue) => {
    if (storedValue === "true") {
      return true;
    }
    if (storedValue === "false") {
      return false;
    }
    return initialValue;
  },
  serialize: (value) => String(value),
});

const fallbackShowAllEventsAtom = atom(false);

const threadShowAllEventsAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<boolean>(
    `${THREAD_SHOW_ALL_EVENTS_STORAGE_KEY_PREFIX}:${threadId}`,
    false,
    threadShowAllEventsStorage,
    { getOnInit: true },
  )
);

export function useStoredThreadShowAllEvents(threadId?: string | null) {
  return useAtom(threadId ? threadShowAllEventsAtomFamily(threadId) : fallbackShowAllEventsAtom);
}
