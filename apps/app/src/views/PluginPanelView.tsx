import { useParams } from "react-router-dom";
import { PageShell } from "@/components/ui/page-shell.js";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { usePluginSlots } from "@/lib/plugin-slots";

interface PluginPanelViewProps {
  pluginId?: string;
  panelPath?: string;
  subPath?: string;
}

export function PluginPanelView(props: PluginPanelViewProps = {}) {
  const params = useParams<{
    pluginId: string;
    panelPath: string;
    "*": string;
  }>();
  const pluginId = props.pluginId ?? params.pluginId;
  const panelPath = props.panelPath ?? params.panelPath;
  const subPath = props.subPath ?? params["*"] ?? "";
  const { navPanels } = usePluginSlots();
  const pluginsSettled = usePluginFrontendsSettled();
  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.path === panelPath,
    ) ?? null;

  if (panel === null) {
    if (!pluginsSettled) {
      return <PageShell contentClassName="pt-4 md:pt-5">{null}</PageShell>;
    }
    return (
      <PageShell contentClassName="pt-4 md:pt-5">
        <EmptyStatePanel className="rounded-lg p-6 text-sm">
          This plugin panel is not available. The plugin may have been disabled
          or removed.
        </EmptyStatePanel>
      </PageShell>
    );
  }

  return (
    <div
      className="-m-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-m-5"
      data-testid="plugin-panel-body"
    >
      <PluginSlotMount
        key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
        pluginId={panel.pluginId}
        slotKind="navPanel"
        slotId={panel.id}
      >
        <panel.component subPath={subPath} />
      </PluginSlotMount>
    </div>
  );
}
