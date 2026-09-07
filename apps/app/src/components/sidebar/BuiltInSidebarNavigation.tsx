import type { ComponentProps } from "react";
import { useNavigate } from "react-router-dom";
import {
  type BuiltInSidebarNavEntry,
  ExtensionsNavSidebarItem,
  PluginNavSidebarItems,
  type SidebarNavActivationModifiers,
} from "@/components/plugin/PluginNavSidebarItems";
import { useAppCommandRunner } from "@/components/commands/AppCommandProvider";
import { Icon } from "@bb/shared-ui/icon";
import { usePluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import {
  ProjectListNewThreadAction,
  ProjectListSearchThreadsAction,
} from "./ProjectList";
import { DEFAULT_BUILT_IN_SIDEBAR_NAVIGATION_ORDER } from "@/components/plugin/pluginNavSidebarOrder";

export type BuiltInSidebarNavigationProps = ComponentProps<
  typeof ProjectListNewThreadAction
> &
  ComponentProps<typeof ProjectListSearchThreadsAction> &
  ComponentProps<typeof PluginNavSidebarItems> & {
    toolsRoutePath?: string;
  };

export function BuiltInSidebarNavigation({
  compactCustomizeMode,
  newThreadSplit,
  onCompactCustomizeModeChange,
  onNavigate,
  onNewChat,
  onSearchThreads,
  splitEnabled,
  toolsRoutePath,
}: BuiltInSidebarNavigationProps) {
  const navigate = useNavigate();
  const commandRunner = useAppCommandRunner();
  const pluginNavPanels = usePluginNavPanelChrome();
  const builtInEntries: BuiltInSidebarNavEntry[] = [
    {
      kind: "built-in",
      pluginId: "__bb__",
      id: "new-thread",
      title: "New thread",
      icon: <Icon name="MessageSquarePlus" aria-hidden="true" />,
      content: (
        <ProjectListNewThreadAction
          splitEnabled={splitEnabled}
          newThreadSplit={newThreadSplit}
          onNewChat={onNewChat}
        />
      ),
      disabled: onNewChat === undefined,
      onActivate: (event: SidebarNavActivationModifiers) => {
        if (event.metaKey || event.ctrlKey) {
          newThreadSplit?.openInSplit();
          return;
        }
        onNewChat?.();
      },
    },
    {
      kind: "built-in",
      pluginId: "__bb__",
      id: "search-threads",
      title: "Search threads",
      icon: <Icon name="Search" aria-hidden="true" />,
      content: (
        <ProjectListSearchThreadsAction onSearchThreads={onSearchThreads} />
      ),
      disabled: !commandRunner.isCommandAvailable("thread.search", null),
      onActivate: () => {
        onSearchThreads?.();
        commandRunner.dispatch("thread.search", null);
      },
    },
    ...(toolsRoutePath
      ? [
          {
            kind: "built-in" as const,
            pluginId: "__bb__" as const,
            id: "extensions",
            title: "Extensions",
            icon: <Icon name="Toolbox" aria-hidden="true" />,
            content: (
              <ExtensionsNavSidebarItem
                routePath={toolsRoutePath}
                onNavigate={onNavigate}
              />
            ),
            onActivate: () => {
              onNavigate?.();
              void navigate(toolsRoutePath);
            },
          },
        ]
      : []),
  ];

  return (
    <div
      className="contents"
      data-testid="built-in-sidebar-navigation"
      data-sidebar-navigation-unified="true"
    >
      <div className="contents" data-testid="app-sidebar-primary-actions">
        <PluginNavSidebarItems
          builtInEntries={builtInEntries}
          compactCustomizeMode={compactCustomizeMode}
          entries={pluginNavPanels}
          leadingOrderKeys={DEFAULT_BUILT_IN_SIDEBAR_NAVIGATION_ORDER}
          onCompactCustomizeModeChange={onCompactCustomizeModeChange}
          onNavigate={onNavigate}
          splitEnabled={splitEnabled}
        />
      </div>
    </div>
  );
}
