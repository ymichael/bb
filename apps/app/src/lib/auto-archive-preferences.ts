import { getDefaultStore, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageSyncStorage } from "./browser-storage";

const AUTO_ARCHIVE_PREFERENCES_STORAGE_KEY = "bb.auto-archive.preferences";

interface AutoArchivePreferences {
  autoArchiveThreadOnCommit: boolean;
}

const DEFAULT_PREFERENCES: AutoArchivePreferences = {
  autoArchiveThreadOnCommit: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const autoArchivePreferencesStorage = createLocalStorageSyncStorage<AutoArchivePreferences>({
  parse: (storedValue, initialValue) => {
    if (!storedValue) {
      return initialValue;
    }

    try {
      const parsed = JSON.parse(storedValue) as unknown;
      if (!isRecord(parsed)) {
        return initialValue;
      }

      return {
        autoArchiveThreadOnCommit:
          typeof parsed.autoArchiveThreadOnCommit === "boolean"
            ? parsed.autoArchiveThreadOnCommit
            : initialValue.autoArchiveThreadOnCommit,
      };
    } catch {
      return initialValue;
    }
  },
  serialize: (value) =>
    JSON.stringify({
      autoArchiveThreadOnCommit: value.autoArchiveThreadOnCommit,
    }),
});

const autoArchivePreferencesAtom = atomWithStorage<AutoArchivePreferences>(
  AUTO_ARCHIVE_PREFERENCES_STORAGE_KEY,
  DEFAULT_PREFERENCES,
  autoArchivePreferencesStorage,
  { getOnInit: true },
);

export function useAutoArchivePreferences() {
  return useAtom(autoArchivePreferencesAtom);
}

export function getAutoArchivePreferences(): AutoArchivePreferences {
  return getDefaultStore().get(autoArchivePreferencesAtom);
}

export function setAutoArchivePreferences(preferences: AutoArchivePreferences): void {
  getDefaultStore().set(autoArchivePreferencesAtom, preferences);
}
