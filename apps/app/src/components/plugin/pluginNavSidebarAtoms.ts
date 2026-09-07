import { atomWithStorage } from "jotai/utils";
import {
  createJsonLocalStorage,
  type SyncStorage,
} from "@/lib/browser-storage";
import { AUTOMATIONS_PLUGIN_ID } from "@/lib/route-paths";
import {
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS,
  migrateLegacyHiddenPluginNavPanelOrder,
} from "./pluginNavSidebarOrder";

const PLUGIN_NAV_PANEL_ORDER_STORAGE_KEY = "bb.sidebar.pluginPanelOrder";
const VISIBLE_PLUGIN_NAV_PANELS_STORAGE_KEY =
  "bb.sidebar.visiblePluginPanels";
const HIDDEN_PLUGIN_NAV_PANELS_STORAGE_KEY = "bb.sidebar.hiddenPluginPanels";
const LEGACY_EXTENSIONS_NAV_PANEL_KEY = "__builtin__/tools";

function toSidebarNavigationKey(key: string): string {
  if (key === LEGACY_EXTENSIONS_NAV_PANEL_KEY) {
    return BUILT_IN_SIDEBAR_NAVIGATION_KEYS.extensions;
  }
  if (key.startsWith(`${AUTOMATIONS_PLUGIN_ID}/`)) {
    return BUILT_IN_SIDEBAR_NAVIGATION_KEYS.automations;
  }
  return key;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === "string"),
    ),
  ];
}

function normalizeSidebarNavigationKeys(value: unknown): string[] {
  return [...new Set(normalizeStringArray(value).map(toSidebarNavigationKey))];
}

function normalizeVisiblePanelKeys(value: unknown): string[] | null {
  return Array.isArray(value) ? normalizeSidebarNavigationKeys(value) : null;
}

function migrateLegacyPluginNavPreferences(
  storage: SyncStorage<unknown>,
  order: readonly string[],
): string[] {
  const normalizedOrder = normalizeSidebarNavigationKeys(order);
  const legacyHiddenValue = storage.getItem(
    HIDDEN_PLUGIN_NAV_PANELS_STORAGE_KEY,
    null,
  );
  const legacyHidden = normalizeSidebarNavigationKeys(
    legacyHiddenValue,
  );
  const migrated = migrateLegacyHiddenPluginNavPanelOrder(
    normalizedOrder,
    legacyHidden,
  );
  const storedVisibleKeys = normalizeVisiblePanelKeys(
    storage.getItem(VISIBLE_PLUGIN_NAV_PANELS_STORAGE_KEY, null),
  );
  if (storedVisibleKeys === null && Array.isArray(legacyHiddenValue)) {
    const hidden = new Set(legacyHidden);
    storage.setItem(
      VISIBLE_PLUGIN_NAV_PANELS_STORAGE_KEY,
      migrated.filter((key) => !hidden.has(key)),
    );
  }
  storage.setItem(PLUGIN_NAV_PANEL_ORDER_STORAGE_KEY, migrated);
  storage.removeItem(HIDDEN_PLUGIN_NAV_PANELS_STORAGE_KEY);
  return migrated;
}

function createPluginNavPanelOrderStorage(): SyncStorage<string[]> {
  const storage = createJsonLocalStorage<unknown>();
  return {
    getItem(key, initialValue) {
      const order = normalizeSidebarNavigationKeys(
        storage.getItem(key, initialValue),
      );
      return migrateLegacyPluginNavPreferences(storage, order);
    },
    setItem(key, value) {
      storage.setItem(key, normalizeSidebarNavigationKeys(value));
    },
    removeItem(key) {
      storage.removeItem(key);
    },
    subscribe: (key, callback, initialValue) =>
      storage.subscribe?.(
        key,
        (value) => callback(normalizeSidebarNavigationKeys(value)),
        initialValue,
      ),
  };
}

function createPluginNavVisiblePanelKeysStorage(): SyncStorage<
  string[] | null
> {
  const storage = createJsonLocalStorage<unknown>();
  return {
    getItem(key, initialValue) {
      const storedVisibleKeys = normalizeVisiblePanelKeys(
        storage.getItem(key, initialValue),
      );
      if (storedVisibleKeys !== null) return storedVisibleKeys;

      const order = normalizeSidebarNavigationKeys(
        storage.getItem(PLUGIN_NAV_PANEL_ORDER_STORAGE_KEY, []),
      );
      migrateLegacyPluginNavPreferences(storage, order);
      return normalizeVisiblePanelKeys(storage.getItem(key, initialValue));
    },
    setItem(key, value) {
      if (value === null) {
        storage.removeItem(key);
        return;
      }
      storage.setItem(key, normalizeSidebarNavigationKeys(value));
    },
    removeItem(key) {
      storage.removeItem(key);
    },
    subscribe: (key, callback, initialValue) =>
      storage.subscribe?.(
        key,
        (value) => callback(normalizeVisiblePanelKeys(value)),
        initialValue,
      ),
  };
}

export const pluginNavPanelOrderAtom = atomWithStorage<string[]>(
  PLUGIN_NAV_PANEL_ORDER_STORAGE_KEY,
  [],
  createPluginNavPanelOrderStorage(),
  { getOnInit: true },
);

export const pluginNavVisiblePanelKeysAtom = atomWithStorage<string[] | null>(
  VISIBLE_PLUGIN_NAV_PANELS_STORAGE_KEY,
  null,
  createPluginNavVisiblePanelKeysStorage(),
  { getOnInit: true },
);
