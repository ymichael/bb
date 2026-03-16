import type { OpenPathTarget } from "@bb/core";

const OPEN_PATH_PREFERENCES_STORAGE_KEY = "bb.open-path.preferences";

export interface OpenPathPreferences {
  fileCommand: string;
  directoryCommand: string;
}

const DEFAULT_OPEN_PATH_PREFERENCES: OpenPathPreferences = {
  fileCommand: "",
  directoryCommand: "",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeCommand(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parsePreferences(value: string | null): OpenPathPreferences {
  if (!value) return DEFAULT_OPEN_PATH_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(value);
    const record = asRecord(parsed);
    if (!record) return DEFAULT_OPEN_PATH_PREFERENCES;

    return {
      fileCommand: normalizeCommand(record.fileCommand),
      directoryCommand: normalizeCommand(record.directoryCommand),
    };
  } catch {
    return DEFAULT_OPEN_PATH_PREFERENCES;
  }
}

export function getOpenPathPreferences(): OpenPathPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_OPEN_PATH_PREFERENCES;
  }
  return parsePreferences(window.localStorage.getItem(OPEN_PATH_PREFERENCES_STORAGE_KEY));
}

export function setOpenPathPreferences(preferences: OpenPathPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    OPEN_PATH_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      fileCommand: preferences.fileCommand.trim(),
      directoryCommand: preferences.directoryCommand.trim(),
    }),
  );
}

export function getPathCommandForTarget(target: OpenPathTarget): string | undefined {
  const preferences = getOpenPathPreferences();
  const command = target === "file"
    ? preferences.fileCommand
    : preferences.directoryCommand;
  return command.trim() || undefined;
}
