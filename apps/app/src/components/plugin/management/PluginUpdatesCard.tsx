import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UPDATE_ACTION_ICON } from "@bb/domain/update-state";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { pluginToast } from "@/components/plugin/PluginNotificationDescription";
import { invalidatePluginList } from "@/hooks/cache-owners/plugin-cache-owner";
import { applyPluginUpdate } from "@/hooks/queries/plugin-catalog-queries";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";
import { DetailsDisclosure, displayPluginVersion } from "./plugin-ui";
import { UpdatePluginDialog } from "./UpdatePluginDialog";

export function pluginHasUpdateSurfaces(plugin: PluginListItem): boolean {
  if (plugin.source.startsWith("builtin:")) return false;
  return plugin.provenance === "direct" || plugin.provenance === "catalog";
}

function pluginCompatibilityBlockedVersion(
  plugin: PluginListItem,
): string | null {
  if (!pluginHasUpdateSurfaces(plugin)) return null;
  return plugin.updateState.availableVersion === null
    ? plugin.updateState.blockedVersion
    : null;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  const capitalized = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

export function PluginDetailReleaseControl({
  plugin,
}: {
  plugin: PluginListItem;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const queryClient = useQueryClient();
  const availableVersion = plugin.updateState.availableVersion;
  const failure = plugin.updateState.lastFailure;
  const retry = useMutation({
    meta: { showErrorToast: false },
    mutationFn: () => applyPluginUpdate(fetch, plugin.id),
    onSuccess: (result) => {
      invalidatePluginList({ queryClient });
      if (result.outcome === "rolled-back") {
        pluginToast.error(
          "Plugin update failed",
          plugin,
          "installed",
          result.detail ??
            `${displayPluginVersion(plugin.version)} was restored.`,
        );
      } else if (result.applied) {
        pluginToast.success(
          "Plugin updated",
          plugin,
          "installed",
          result.to === null
            ? undefined
            : `Now running ${displayPluginVersion(result.to.display)}.`,
        );
      } else {
        pluginToast.message("Plugin is up to date", plugin, "installed");
      }
    },
    onError: (error) => {
      pluginToast.error(
        "Plugin update failed",
        plugin,
        "installed",
        pluginAdminErrorMessage(error),
      );
    },
  });

  if (!pluginHasUpdateSurfaces(plugin)) return null;
  if (availableVersion === null) return null;

  if (failure !== null) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={retry.isPending}
        aria-busy={retry.isPending}
        aria-label={`Retry update to ${displayPluginVersion(availableVersion)}`}
        onClick={() => retry.mutate()}
      >
        {retry.isPending ? (
          <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Icon name="RotateCcw" className="size-3.5" aria-hidden />
        )}
        Retry
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 px-2 text-xs"
        aria-label={`Update ${plugin.name ?? plugin.id} to ${displayPluginVersion(availableVersion)}`}
        onClick={() => setDetailsOpen(true)}
      >
        <Icon name={UPDATE_ACTION_ICON} className="size-3.5" aria-hidden />
        Update
      </Button>
      <UpdatePluginDialog
        plugin={plugin}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </>
  );
}

export function PluginDetailReleaseStatus({
  plugin,
}: {
  plugin: PluginListItem;
}) {
  const failure = plugin.updateState.lastFailure;
  const blockedVersion = pluginCompatibilityBlockedVersion(plugin);
  const blockedReasons = plugin.updateState.blockedReasons;

  if (!pluginHasUpdateSurfaces(plugin)) return null;

  if (failure !== null) {
    return (
      <div
        role="status"
        aria-label="Update failed"
        className="flex min-w-0 items-start gap-2.5"
      >
        <Icon
          name="CircleX"
          className="mt-0.5 size-4 shrink-0 text-destructive"
          aria-hidden
        />
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          bb couldn&rsquo;t activate {displayPluginVersion(failure.version)}. It
          restored {displayPluginVersion(plugin.version)} and its data.
        </p>
      </div>
    );
  }

  if (
    plugin.updateState.outcome === "unavailable" &&
    plugin.updateState.detail !== null
  ) {
    return (
      <div
        role="status"
        aria-label="Update needs attention"
        className="flex min-w-0 items-start gap-2.5"
      >
        <Icon
          name="AlertTriangle"
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden
        />
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          {plugin.updateState.detail}
        </p>
      </div>
    );
  }

  if (plugin.updateState.availableVersion !== null) {
    return (
      <div role="status" className="flex min-w-0 items-baseline gap-2">
        <span className="font-mono text-xs text-foreground">
          {displayPluginVersion(plugin.updateState.availableVersion)}
        </span>
        <span className="text-xs text-muted-foreground">Available</span>
      </div>
    );
  }

  if (blockedVersion === null) return null;
  return (
    <div
      role="status"
      aria-label="Update blocked"
      className="flex min-w-0 items-start gap-2.5"
    >
      <Icon
        name="AlertTriangle"
        className="mt-0.5 size-4 shrink-0 text-warning"
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {blockedReasons[0] === undefined
            ? `${displayPluginVersion(blockedVersion)} isn’t compatible with this bb.`
            : sentence(blockedReasons[0])}{" "}
          {displayPluginVersion(plugin.version)} remains installed. Keep using
          it and check again when a compatible plugin version is available.
        </p>
        {blockedReasons.length > 1 ? (
          <div className="mt-1.5">
            <DetailsDisclosure summary="Other requirements">
              <ul className="space-y-1 text-foreground">
                {blockedReasons.slice(1).map((reason) => (
                  <li key={reason}>{sentence(reason)}</li>
                ))}
              </ul>
            </DetailsDisclosure>
          </div>
        ) : null}
      </div>
    </div>
  );
}
