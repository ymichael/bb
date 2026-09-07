import type {
  ExperimentalSidebarNavigationAction,
  ExperimentalSidebarNavigationItem,
  ExperimentalSidebarNavigationShortcut,
} from "@get-bb/plugin-sdk";
import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import { getPluginPanelRoutePath, isToolsRoutePath } from "@/lib/route-paths";

export const NEW_THREAD_NAVIGATION_ITEM_ID = "new-thread";
export const SEARCH_THREADS_NAVIGATION_ITEM_ID = "search-threads";
export const EXTENSIONS_NAVIGATION_ITEM_ID = "extensions";

export function getPluginPanelNavigationItemId(
  panel: Pick<PluginNavPanelSlot, "pluginId" | "id">,
): string {
  return `plugin-panel:${encodeURIComponent(panel.pluginId)}/${encodeURIComponent(panel.id)}`;
}

type SplitProps = ExperimentalSidebarNavigationItem["experimental_splitProps"];

interface CreateSidebarNavigationItemsOptions {
  navPanels: readonly PluginNavPanelSlot[];
  newThreadDisabled: boolean;
  newThreadShortcut: ExperimentalSidebarNavigationShortcut | null;
  searchThreadsDisabled: boolean;
  searchThreadsShortcut: ExperimentalSidebarNavigationShortcut | null;
  showExtensions: boolean;
  splitPropsFor(
    action: ExperimentalSidebarNavigationAction,
    label: string,
  ): SplitProps;
}

export function createSidebarNavigationItems({
  navPanels,
  newThreadDisabled,
  newThreadShortcut,
  searchThreadsDisabled,
  searchThreadsShortcut,
  showExtensions,
  splitPropsFor,
}: CreateSidebarNavigationItemsOptions): readonly ExperimentalSidebarNavigationItem[] {
  const newThreadAction = { kind: "new-thread" } as const;
  const searchAction = { kind: "search-threads" } as const;
  const extensionsAction = { kind: "open-extensions" } as const;
  return [
    {
      id: NEW_THREAD_NAVIGATION_ITEM_ID,
      label: "New thread",
      icon: { kind: "host", name: "new-thread" },
      action: newThreadAction,
      isDisabled: newThreadDisabled,
      shortcut: newThreadShortcut,
      experimental_splitProps: splitPropsFor(newThreadAction, "New thread"),
    },
    {
      id: SEARCH_THREADS_NAVIGATION_ITEM_ID,
      label: "Search threads",
      icon: { kind: "host", name: "search" },
      action: searchAction,
      isDisabled: searchThreadsDisabled,
      shortcut: searchThreadsShortcut,
      experimental_splitProps: {},
    },
    ...(showExtensions
      ? [
          {
            id: EXTENSIONS_NAVIGATION_ITEM_ID,
            label: "Extensions",
            icon: { kind: "host", name: "extensions" },
            action: extensionsAction,
            isDisabled: false,
            shortcut: null,
            experimental_splitProps: {},
          } satisfies ExperimentalSidebarNavigationItem,
        ]
      : []),
    ...navPanels.map((panel): ExperimentalSidebarNavigationItem => {
      const action = {
        kind: "open-plugin-panel",
        pluginId: panel.pluginId,
        panelId: panel.id,
      } as const;
      return {
        id: getPluginPanelNavigationItemId(panel),
        label: panel.title,
        icon: {
          kind: "plugin",
          pluginId: panel.pluginId,
          icon: panel.icon,
        },
        action,
        isDisabled: false,
        shortcut: null,
        experimental_splitProps: splitPropsFor(action, panel.title),
      };
    }),
  ];
}

export function resolveActiveSidebarNavigationItemId({
  items,
  pathname,
  navPanels,
}: {
  items: readonly ExperimentalSidebarNavigationItem[];
  pathname: string;
  navPanels: readonly PluginNavPanelSlot[];
}): string | null {
  if (pathname === "/") return NEW_THREAD_NAVIGATION_ITEM_ID;
  if (isToolsRoutePath(pathname)) {
    return items.some((item) => item.id === EXTENSIONS_NAVIGATION_ITEM_ID)
      ? EXTENSIONS_NAVIGATION_ITEM_ID
      : null;
  }
  for (const panel of navPanels) {
    const path = getPluginPanelRoutePath({
      pluginId: panel.pluginId,
      path: panel.path,
    });
    if (pathname === path || pathname.startsWith(`${path}/`)) {
      return getPluginPanelNavigationItemId(panel);
    }
  }
  return null;
}

export interface SidebarNavigationActivationHandlers {
  newThread(openInSplit: boolean): void;
  searchThreads(): void;
  openExtensions(): void;
  openPluginPanel(
    action: Extract<
      ExperimentalSidebarNavigationAction,
      { kind: "open-plugin-panel" }
    >,
    openInSplit: boolean,
  ): void;
}

export function activateSidebarNavigationItem(
  items: readonly ExperimentalSidebarNavigationItem[],
  itemId: string,
  openInSplit: boolean,
  handlers: SidebarNavigationActivationHandlers,
): void {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item || item.isDisabled) return;

  switch (item.action.kind) {
    case "new-thread":
      handlers.newThread(openInSplit);
      return;
    case "search-threads":
      handlers.searchThreads();
      return;
    case "open-extensions":
      handlers.openExtensions();
      return;
    case "open-plugin-panel":
      handlers.openPluginPanel(item.action, openInSplit);
  }
}
