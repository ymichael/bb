import { Component, type ReactNode } from "react";
import type { PluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import { usePluginCss } from "@/lib/plugin-css";
import { PluginIcon } from "./PluginIcon";
import { PluginContext } from "./plugin-context";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";

class HeaderContentBoundary extends Component<
  { pluginId: string; children: ReactNode },
  { crashed: boolean }
> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: Error): void {
    console.warn(
      `[plugin:${this.props.pluginId}] navPanel headerContent crashed and is hidden: ${error.message}`,
    );
  }

  override render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

export function PluginPanelHeaderCenter({
  chrome,
}: {
  chrome: Pick<PluginNavPanelChrome, "pluginId" | "icon" | "title">;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <PluginIcon
        pluginId={chrome.pluginId}
        icon={chrome.icon}
        className="text-muted-foreground"
      />
      <p className="truncate text-sm font-semibold">{chrome.title}</p>
    </div>
  );
}

export function PluginPanelHeaderActions({
  panel,
  paneId,
  subPath,
}: {
  panel: PluginNavPanelSlot;
  paneId?: string;
  subPath: string;
}) {
  const paneContext = useOptionalPaneContext();
  const HeaderContent = panel.headerContent;
  usePluginCss(HeaderContent === undefined ? null : panel.pluginId);
  const panelStateId = getPluginPagePanelStateId({
    panelPath: panel.path,
    paneId: paneId ?? paneContext?.paneId,
    pluginId: panel.pluginId,
  });
  return (
    <div className="flex shrink-0 items-center gap-2">
      {HeaderContent === undefined ? null : (
        <HeaderContentBoundary
          key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
          pluginId={panel.pluginId}
        >
          <PluginContext.Provider value={panel.pluginId}>
            {}
            <div
              data-bb-plugin-root=""
              data-bb-plugin={panel.pluginId}
              className="flex shrink-0 items-center gap-2"
            >
              <HeaderContent subPath={subPath} />
            </div>
          </PluginContext.Provider>
        </HeaderContentBoundary>
      )}
      <div data-plugin-right-panel-toggle-portal={panelStateId} />
    </div>
  );
}
