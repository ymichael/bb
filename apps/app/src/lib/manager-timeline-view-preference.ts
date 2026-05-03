import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageSyncStorage } from "./browser-storage";
import type { SyncStorage } from "./browser-storage";

const USE_STANDARD_MANAGER_TIMELINE_STORAGE_KEY =
  "bb.thread.useStandardManagerTimeline";
const LEGACY_SHOW_ALL_EVENTS_STORAGE_KEY = "bb.thread.showAllEvents";

export interface StoredStandardManagerTimelinePreference {
  currentValue: string | null;
  initialValue: boolean;
  legacyValue: string | null;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function parseStoredBoolean(
  storedValue: string | null,
  initialValue: boolean,
): boolean {
  if (storedValue === "true") {
    return true;
  }
  if (storedValue === "false") {
    return false;
  }
  return initialValue;
}

export function resolveStoredStandardManagerTimelinePreference({
  currentValue,
  initialValue,
  legacyValue,
}: StoredStandardManagerTimelinePreference): boolean {
  if (currentValue !== null) {
    return parseStoredBoolean(currentValue, initialValue);
  }
  return parseStoredBoolean(legacyValue, initialValue);
}

const booleanStorage = createLocalStorageSyncStorage<boolean>({
  parse: parseStoredBoolean,
  serialize: (value) => String(value),
});

const useStandardManagerTimelineStorage: SyncStorage<boolean> = {
  getItem: (key: string, initialValue: boolean) => {
    const localStorage = getLocalStorage();
    return resolveStoredStandardManagerTimelinePreference({
      currentValue: localStorage?.getItem(key) ?? null,
      legacyValue:
        localStorage?.getItem(LEGACY_SHOW_ALL_EVENTS_STORAGE_KEY) ?? null,
      initialValue,
    });
  },
  removeItem: (key: string) => {
    booleanStorage.removeItem(key);
  },
  setItem: (key: string, value: boolean) => {
    booleanStorage.setItem(key, value);
  },
  subscribe: booleanStorage.subscribe,
};

const useStandardManagerTimelineAtom = atomWithStorage<boolean>(
  USE_STANDARD_MANAGER_TIMELINE_STORAGE_KEY,
  false,
  useStandardManagerTimelineStorage,
  { getOnInit: true },
);

export function useStandardManagerTimelinePreference() {
  return useAtom(useStandardManagerTimelineAtom);
}
