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

export function getAutoArchivePreferences(): AutoArchivePreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  const raw = window.localStorage.getItem(AUTO_ARCHIVE_PREFERENCES_STORAGE_KEY);
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return DEFAULT_PREFERENCES;
    return {
      autoArchiveThreadOnCommit:
        typeof parsed.autoArchiveThreadOnCommit === "boolean"
          ? parsed.autoArchiveThreadOnCommit
          : DEFAULT_PREFERENCES.autoArchiveThreadOnCommit,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function setAutoArchivePreferences(preferences: AutoArchivePreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    AUTO_ARCHIVE_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      autoArchiveThreadOnCommit: preferences.autoArchiveThreadOnCommit,
    }),
  );
}
