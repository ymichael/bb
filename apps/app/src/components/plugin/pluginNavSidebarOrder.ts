import { arrangeByStoredOrder } from "@/lib/stored-order";

interface PluginNavPanelIdentity {
  pluginId: string;
  id: string;
}

export const BUILT_IN_SIDEBAR_NAVIGATION_KEYS = {
  newThread: "__bb__/new-thread",
  searchThreads: "__bb__/search-threads",
  extensions: "__bb__/extensions",
  automations: "__bb__/automations",
} as const;

export const DEFAULT_HIDDEN_SIDEBAR_NAVIGATION_KEYS = [
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.searchThreads,
] as const;

export const DEFAULT_BUILT_IN_SIDEBAR_NAVIGATION_ORDER = [
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.newThread,
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.searchThreads,
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.extensions,
  BUILT_IN_SIDEBAR_NAVIGATION_KEYS.automations,
] as const;

export function getPluginNavPanelKey(panel: PluginNavPanelIdentity): string {
  return `${panel.pluginId}/${panel.id}`;
}

interface ArrangePluginNavPanelsArgs<TPanel extends PluginNavPanelIdentity> {
  panels: readonly TPanel[];
  storedOrder: readonly string[];
}

interface ArrangedPluginNavPanels<TPanel extends PluginNavPanelIdentity> {
  ordered: TPanel[];
  normalizedOrder: string[];
}

interface ArrangePluginNavPanelPreferencesArgs<
  TPanel extends PluginNavPanelIdentity,
> extends ArrangePluginNavPanelsArgs<TPanel> {
  storedVisibleKeys: readonly string[] | null;
  defaultHiddenKeys: readonly string[];
}

interface ArrangedPluginNavPanelPreferences<
  TPanel extends PluginNavPanelIdentity,
> extends ArrangedPluginNavPanels<TPanel> {
  visible: TPanel[];
  visibleKeys: string[];
  normalizedVisibleKeys: string[] | null;
}

export function arrangePluginNavPanels<TPanel extends PluginNavPanelIdentity>({
  panels,
  storedOrder,
}: ArrangePluginNavPanelsArgs<TPanel>): ArrangedPluginNavPanels<TPanel> {
  return arrangeByStoredOrder({
    items: panels,
    getId: getPluginNavPanelKey,
    storedOrder,
  });
}

export function arrangePluginNavPanelPreferences<
  TPanel extends PluginNavPanelIdentity,
>({
  panels,
  storedOrder,
  storedVisibleKeys,
  defaultHiddenKeys,
}: ArrangePluginNavPanelPreferencesArgs<TPanel>): ArrangedPluginNavPanelPreferences<TPanel> {
  const { ordered, normalizedOrder } = arrangePluginNavPanels({
    panels,
    storedOrder,
  });
  const normalizedVisibleKeys =
    storedVisibleKeys === null
      ? null
      : [...new Set(storedVisibleKeys.filter((key) => key.length > 0))];
  const defaultHiddenKeySet = new Set(defaultHiddenKeys);
  const visibleKeys =
    normalizedVisibleKeys ??
    ordered
      .map(getPluginNavPanelKey)
      .filter((key) => !defaultHiddenKeySet.has(key));
  const visibleSet = new Set(visibleKeys);

  return {
    ordered,
    normalizedOrder,
    visible: ordered.filter((panel) =>
      visibleSet.has(getPluginNavPanelKey(panel)),
    ),
    visibleKeys: ordered
      .map(getPluginNavPanelKey)
      .filter((key) => visibleSet.has(key)),
    normalizedVisibleKeys,
  };
}

export function togglePluginNavPanelVisibility(
  visibleKeys: readonly string[],
  key: string,
  visible: boolean,
): string[] {
  const normalized = [
    ...new Set(visibleKeys.filter((item) => item.length > 0)),
  ];
  if (visible) {
    return normalized.includes(key) ? normalized : [...normalized, key];
  }
  return normalized.filter((item) => item !== key);
}

export function migrateLegacyHiddenPluginNavPanelOrder(
  order: readonly string[],
  hiddenKeys: readonly string[],
): string[] {
  const uniqueOrder = [
    ...new Set([...order, ...hiddenKeys].filter((key) => key.length > 0)),
  ];
  const hidden = new Set(hiddenKeys);
  return [
    ...uniqueOrder.filter((key) => !hidden.has(key)),
    ...uniqueOrder.filter((key) => hidden.has(key)),
  ];
}
