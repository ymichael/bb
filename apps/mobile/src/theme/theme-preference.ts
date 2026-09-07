export type ThemeMode = "light" | "dark";
export type ThemeModePreference = ThemeMode | "system";

export const THEME_PREFERENCE_STORAGE_KEY = "bb.theme";
const DEFAULT_THEME_PREFERENCE: ThemeModePreference = "system";

export interface ThemePreferenceStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const PREFERENCES: readonly ThemeModePreference[] = ["system", "light", "dark"];

export function parseThemePreference(
  value: string | null | undefined,
): ThemeModePreference {
  return (
    PREFERENCES.find((candidate) => candidate === value) ??
    DEFAULT_THEME_PREFERENCE
  );
}

export function readThemePreference(
  storage: ThemePreferenceStorage,
): ThemeModePreference {
  return parseThemePreference(storage.getString(THEME_PREFERENCE_STORAGE_KEY));
}

export function writeThemePreference(
  storage: ThemePreferenceStorage,
  preference: ThemeModePreference,
): void {
  if (preference === DEFAULT_THEME_PREFERENCE) {
    storage.remove(THEME_PREFERENCE_STORAGE_KEY);
    return;
  }
  storage.set(THEME_PREFERENCE_STORAGE_KEY, preference);
}

export function resolveThemeMode(
  preference: ThemeModePreference,
  systemScheme: string | null | undefined,
): ThemeMode {
  if (preference !== "system") return preference;
  return systemScheme === "dark" ? "dark" : "light";
}
