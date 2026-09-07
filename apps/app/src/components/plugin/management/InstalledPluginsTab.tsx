import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@bb/shared-ui/empty-state";
import { Switch } from "@bb/shared-ui/switch";
import {
  ResourceListPanel,
  ResourceRow,
  ResourceRowDetailChevron,
} from "@bb/shared-ui/resource-list";
import { ProvenancePill } from "@/components/tools/ProvenancePill";
import { appToast } from "@/components/ui/app-toast.js";
import { invalidatePluginList } from "@/hooks/cache-owners/plugin-cache-owner";
import {
  setPluginEnabled,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import { pluginNeedsAttention } from "@/hooks/usePluginAttention";
import { cn } from "@bb/shared-ui/lib/utils";
import { getPluginDetailRoutePath } from "@/lib/route-paths";
import {
  pluginRowSignal,
  pluginRuntimeStatusPresentation,
} from "./plugin-status";
import { PluginRowSignalView, PluginSignalLogo } from "./PluginRowSignal";
import { UpdatePluginDialog } from "./UpdatePluginDialog";
import { PluginLogo } from "./plugin-ui";

export function InstalledPluginsTab({
  plugins,
}: {
  plugins: readonly PluginListItem[];
}) {
  const [updateTargetId, setUpdateTargetId] = useState<string | null>(null);
  const updateTarget =
    updateTargetId === null
      ? null
      : (plugins.find((plugin) => plugin.id === updateTargetId) ?? null);

  if (plugins.length === 0) {
    return (
      <EmptyState message="No plugins installed. Browse the catalog, create a plugin, or run bb plugin install <source>." />
    );
  }

  return (
    <>
      <ResourceListPanel>
        <div className="divide-y divide-border">
          {plugins.map((plugin) => (
            <InstalledPluginRow
              key={plugin.id}
              plugin={plugin}
              onUpdateClick={() => setUpdateTargetId(plugin.id)}
            />
          ))}
        </div>
      </ResourceListPanel>
      {updateTarget !== null ? (
        <UpdatePluginDialog
          plugin={updateTarget}
          open
          onOpenChange={(open) => {
            if (!open) setUpdateTargetId(null);
          }}
        />
      ) : null}
    </>
  );
}

export function InstalledPluginRow({
  plugin,
  onUpdateClick,
}: {
  plugin: PluginListItem;
  onUpdateClick: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (enabled: boolean) =>
      setPluginEnabled(fetch, plugin.id, enabled),
    onError: (error, enabled) => {
      appToast.error(
        `${enabled ? "Enabling" : "Disabling"} ${plugin.id} failed`,
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    },
    onSettled: () => invalidatePluginList({ queryClient }),
  });
  const enabled = toggle.isPending ? toggle.variables : plugin.enabled;
  const signal = pluginRowSignal(plugin);
  const statusSignal = signal?.kind === "status" ? signal : null;
  const updateSignal = signal?.kind === "update" ? signal : null;
  const runtimeStatus = pluginRuntimeStatusPresentation(plugin);
  const notRunning = pluginNeedsAttention({
    enabled: enabled === true,
    status: plugin.status,
  });
  const runtimeStatusToneClass =
    runtimeStatus?.tone === "error"
      ? "text-destructive-text"
      : "text-warning-text";

  const openDetail = () =>
    navigate(
      getPluginDetailRoutePath({ pluginId: plugin.id, view: "installed" }),
    );
  return (
    <div data-testid={`plugin-row-${plugin.id}`}>
      <ResourceRow
        leading={
          <PluginSignalLogo signal={statusSignal} onStatusClick={openDetail}>
            <PluginLogo plugin={plugin} className="size-6 shrink-0" />
          </PluginSignalLogo>
        }
        title={plugin.name ?? plugin.id}
        titleMeta={
          plugin.publisherLabel === null ? undefined : (
            <ProvenancePill label={plugin.publisherLabel} />
          )
        }
        status={
          runtimeStatus === null ? undefined : (
            <span
              data-testid={`plugin-runtime-status-${plugin.id}`}
              className={cn(
                "shrink-0 text-xs font-medium",
                runtimeStatusToneClass,
              )}
            >
              {runtimeStatus.label}
            </span>
          )
        }
        description={
          runtimeStatus === null
            ? plugin.description
            : (plugin.statusDetail ?? runtimeStatus.condition)
        }
        openLabel={`${plugin.name ?? plugin.id} plugin details`}
        onOpen={openDetail}
        trailingMeta={
          updateSignal !== null ? (
            <span data-testid={`plugin-update-signal-${plugin.id}`}>
              <PluginRowSignalView
                signal={updateSignal}
                onUpdateClick={onUpdateClick}
                onStatusClick={openDetail}
              />
            </span>
          ) : undefined
        }
        persistentActions={
          <>
            {notRunning ? (
              <span
                data-testid={`plugin-not-running-${plugin.id}`}
                className={cn(
                  "mr-1 text-2xs font-medium",
                  runtimeStatusToneClass,
                )}
              >
                not running
              </span>
            ) : null}
            <Switch
              checked={enabled}
              disabled={toggle.isPending}
              onCheckedChange={(next) => toggle.mutate(next)}
              aria-label={`${enabled ? "Disable" : "Enable"} ${plugin.id}${
                notRunning ? ` (${plugin.status}, not running)` : ""
              }`}
            />
          </>
        }
        trailingVisual={<ResourceRowDetailChevron />}
      />
    </div>
  );
}
