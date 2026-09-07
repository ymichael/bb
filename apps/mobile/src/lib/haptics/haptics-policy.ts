export type HapticKind =
  | "selection"
  | "impact-light"
  | "impact-medium"
  | "impact-heavy"
  | "success"
  | "warning"
  | "error";

export type HapticCall =
  | { method: "selection" }
  | { method: "impact"; style: "light" | "medium" | "heavy" }
  | { method: "notification"; type: "success" | "warning" | "error" };

export const HAPTICS_ENABLED_STORAGE_KEY = "bb.haptics.enabled";
const HAPTICS_ENABLED_DEFAULT = true;

export function parseHapticsEnabled(stored: string | undefined): boolean {
  if (stored === undefined) return HAPTICS_ENABLED_DEFAULT;
  return stored !== "false";
}

function serializeHapticsEnabled(enabled: boolean): string {
  return enabled ? "true" : "false";
}

export function resolveHapticCall(
  enabled: boolean,
  kind: HapticKind,
): HapticCall | null {
  if (!enabled) return null;
  switch (kind) {
    case "selection":
      return { method: "selection" };
    case "impact-light":
      return { method: "impact", style: "light" };
    case "impact-medium":
      return { method: "impact", style: "medium" };
    case "impact-heavy":
      return { method: "impact", style: "heavy" };
    case "success":
      return { method: "notification", type: "success" };
    case "warning":
      return { method: "notification", type: "warning" };
    case "error":
      return { method: "notification", type: "error" };
  }
}

export type ButtonHaptic = "light" | "medium" | "heavy" | "selection";

export function hapticKindForButton(haptic: ButtonHaptic | true): HapticKind {
  switch (haptic) {
    case true:
    case "light":
      return "impact-light";
    case "medium":
      return "impact-medium";
    case "heavy":
      return "impact-heavy";
    case "selection":
      return "selection";
  }
}

export interface HapticsPreferenceStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface HapticsPreferenceStore {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createHapticsPreferenceStore(
  storage: HapticsPreferenceStorage,
): HapticsPreferenceStore {
  const listeners = new Set<() => void>();
  let enabled = parseHapticsEnabled(
    storage.getString(HAPTICS_ENABLED_STORAGE_KEY),
  );
  return {
    isEnabled: () => enabled,
    setEnabled: (next) => {
      if (next === enabled) return;
      enabled = next;
      storage.set(HAPTICS_ENABLED_STORAGE_KEY, serializeHapticsEnabled(next));
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
