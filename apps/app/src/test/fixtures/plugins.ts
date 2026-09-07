import type { InstalledPlugin } from "@bb/server-contract";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import type { PluginRegistrationSet } from "@/lib/plugin-slots";

type PluginListItemOverrides = Omit<
  Partial<PluginListItem>,
  "app" | "handlerStats" | "updateState"
> & {
  app?: Partial<PluginListItem["app"]>;
  handlerStats?: Partial<PluginListItem["handlerStats"]>;
  updateState?: Partial<PluginListItem["updateState"]>;
};
type InstalledPluginOverrides = Omit<
  Partial<InstalledPlugin>,
  "app" | "handlerStats"
> & {
  app?: Partial<InstalledPlugin["app"]>;
  handlerStats?: Partial<InstalledPlugin["handlerStats"]>;
};

export function makePluginRegistrationSet(
  overrides: Partial<PluginRegistrationSet> = {},
): PluginRegistrationSet {
  return {
    homepageSections: [],
    settingsSections: [],
    appOverlays: [],
    navPanels: [],
    threadPanelActions: [],
    newThreadPanelActions: [],
    composerCustomizations: [],
    pendingInteractions: [],
    sidebarFooterActions: [],
    experimentalSidebarNavigations: [],
    threadLists: [],
    threadHeaderActions: [],
    fileOpeners: [],
    sourceCodeRenderers: [],
    diffRenderers: [],
    messageDirectives: [],
    messageActions: [],
    commandPaletteActions: [],
    providerIcons: [],
    timelineRenderers: [],
    ...overrides,
  };
}

export function makePluginListItem(
  overrides: PluginListItemOverrides = {},
): PluginListItem {
  const plugin: PluginListItem = {
    id: "plugin-test",
    source: "path:/plugins/plugin-test",
    rootDir: "/plugins/plugin-test",
    version: "0.1.0",
    enabled: true,
    status: "running",
    statusDetail: null,
    description: null,
    name: "Test plugin",
    icon: null,
    compactIconUrl: null,
    logoUrl: null,
    logoDarkUrl: null,
    hasSettings: false,
    provenance: "direct",
    isOrphanedBuiltin: false,
    catalogEntryId: null,
    publisherLabel: null,
    sourceDisplay: "path · /plugins/plugin-test",
    updateState: {
      outcome: null,
      detail: null,
      availableVersion: null,
      blockedVersion: null,
      blockedReasons: [],
      lastCheckAt: null,
      lastFailure: null,
    },
    handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    app: { hasApp: false, bundle: null },
  };
  return {
    ...plugin,
    ...overrides,
    app: { ...plugin.app, ...overrides.app },
    handlerStats: { ...plugin.handlerStats, ...overrides.handlerStats },
    updateState: { ...plugin.updateState, ...overrides.updateState },
  };
}

export function makeInstalledPlugin(
  overrides: InstalledPluginOverrides = {},
): InstalledPlugin {
  const plugin: InstalledPlugin = {
    id: "plugin-test",
    source: "path:/plugins/plugin-test",
    rootDir: "/plugins/plugin-test",
    version: "0.1.0",
    provenance: "direct",
    isOrphanedBuiltin: false,
    publisherLabel: null,
    sourceDisplay: "path · /plugins/plugin-test",
    updateState: {},
    enabled: true,
    description: null,
    name: "Test plugin",
    screenshots: [],
    collections: [],
    icon: null,
    iconUrl: null,
    status: "running",
    statusDetail: null,
    handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    hasSettings: false,
    app: { hasApp: false, bundle: null },
    logoUrl: null,
    logoDarkUrl: null,
    providerIds: [],
    icons: {},
  };
  return {
    ...plugin,
    ...overrides,
    app: { ...plugin.app, ...overrides.app },
    handlerStats: { ...plugin.handlerStats, ...overrides.handlerStats },
  };
}
