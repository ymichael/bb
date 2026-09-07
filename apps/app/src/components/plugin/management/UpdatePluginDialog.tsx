import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UPDATE_ACTION_ICON } from "@bb/domain/update-state";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { pluginToast } from "@/components/plugin/PluginNotificationDescription";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";
import { invalidatePluginList } from "@/hooks/cache-owners/plugin-cache-owner";
import {
  applyPluginUpdate,
  type PluginUpdateResult,
} from "@/hooks/queries/plugin-catalog-queries";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import {
  DetailsDisclosure,
  displayPluginVersion,
  formatAbsoluteDate,
  KeyValueGrid,
  RollbackNote,
  SUCCESS_TEXT_STYLE,
} from "./plugin-ui";

interface UpdatePluginDialogProps {
  plugin: PluginListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UpdatePluginDialog({
  plugin,
  open,
  onOpenChange,
}: UpdatePluginDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <UpdatePluginDialogContent
            plugin={plugin}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UpdatePluginDialogContent({
  plugin,
  onOpenChange,
}: {
  plugin: PluginListItem;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const name = plugin.name ?? plugin.id;
  const state = plugin.updateState;
  const [rolledBack, setRolledBack] = useState<PluginUpdateResult | null>(null);

  const update = useMutation({
    meta: { showErrorToast: false },
    mutationFn: () => applyPluginUpdate(fetch, plugin.id),
    onSuccess: (result) => {
      invalidatePluginList({ queryClient });
      if (result.outcome === "rolled-back") {
        setRolledBack(result);
        return;
      }
      if (result.applied) {
        pluginToast.success(
          "Plugin updated",
          plugin,
          "installed",
          result.to !== null
            ? `Now running ${displayPluginVersion(result.to.display)}.`
            : undefined,
        );
      } else {
        pluginToast.message("Plugin is up to date", plugin, "installed");
      }
      onOpenChange(false);
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

  const fromLine = `Currently ${displayPluginVersion(plugin.version)}`;
  const persistedFailure = state.lastFailure;
  const failure =
    rolledBack !== null
      ? {
          version:
            rolledBack.to?.display ??
            state.availableVersion ??
            "The new version",
          at: null,
          detail: rolledBack.detail ?? "",
        }
      : persistedFailure === null
        ? null
        : persistedFailure;

  if (failure !== null) {
    const retryVersion = state.availableVersion;
    return (
      <>
        <DialogHeader>
          <DialogTitle>Update failed</DialogTitle>
          <DialogDescription>
            {failure.at === null
              ? "The update couldn’t be completed."
              : `Failed on ${formatAbsoluteDate(failure.at)}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-sm">
            <Icon
              name="CircleX"
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-hidden
            />
            <span>
              bb couldn&rsquo;t activate {displayPluginVersion(failure.version)}
              . It restored {displayPluginVersion(plugin.version)} and its data.
            </span>
          </div>
          {failure.detail.length > 0 ? (
            <DetailsDisclosure
              key="failure-details"
              summary="Technical details"
              defaultExpanded
            >
              <p className="break-words font-mono text-foreground">
                {failure.detail}
              </p>
            </DetailsDisclosure>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {retryVersion === null
              ? `The restored version can keep running. Try again when a compatible update becomes available.`
              : `A compatible update to ${displayPluginVersion(retryVersion)} is still available. Retry when you’re ready.`}
          </p>
          {rolledBack === null ? null : (
            <p className="text-xs text-subtle-foreground">
              The plugin is marked &ldquo;Update failed&rdquo; in the installed
              list until an update succeeds.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          {retryVersion === null ? null : (
            <Button
              type="button"
              disabled={update.isPending}
              aria-busy={update.isPending}
              aria-label={`Retry update to ${retryVersion}`}
              onClick={() => update.mutate()}
            >
              {update.isPending ? (
                <Icon name="Spinner" className="animate-spin" />
              ) : null}
              Retry update
            </Button>
          )}
        </DialogFooter>
      </>
    );
  }

  if (state.availableVersion !== null) {
    const candidate = state.availableVersion;
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {}
            Update {name} to {displayPluginVersion(candidate)}?
          </DialogTitle>
          <DialogDescription>{fromLine}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium" style={SUCCESS_TEXT_STYLE}>
              ✓
            </span>
            <span>Compatible with your bb and plugin SDK</span>
          </div>
          <DetailsDisclosure summary="Details — source, versions">
            <KeyValueGrid
              entries={[
                { key: "Source", value: plugin.sourceDisplay },
                { key: "Current", value: plugin.version },
                { key: "Candidate", value: candidate },
              ]}
            />
          </DetailsDisclosure>
          <RollbackNote
            fromVersion={displayPluginVersion(plugin.version)}
            toVersion={displayPluginVersion(candidate)}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={update.isPending}
            onClick={() => onOpenChange(false)}
          >
            Not now
          </Button>
          <Button
            type="button"
            disabled={update.isPending}
            aria-busy={update.isPending}
            onClick={() => update.mutate()}
          >
            {update.isPending ? (
              <Icon name="Spinner" className="animate-spin" />
            ) : (
              <Icon name={UPDATE_ACTION_ICON} aria-hidden />
            )}
            Update
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (state.blockedVersion !== null) {
    const blocked = state.blockedVersion;
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            Update {name} to {displayPluginVersion(blocked)}?
          </DialogTitle>
          <DialogDescription>{fromLine}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Icon
              name="AlertTriangle"
              className="size-4 shrink-0 text-warning"
              aria-hidden
            />
            <span>
              {displayPluginVersion(blocked)} isn&rsquo;t compatible with this
              bb
            </span>
          </div>
          {}
          <DetailsDisclosure summary="Details" defaultExpanded>
            <div className="space-y-1.5">
              {state.blockedReasons.length > 0 ? (
                <ul className="space-y-1">
                  {state.blockedReasons.map((reason) => (
                    <li key={reason} className="text-foreground">
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              <KeyValueGrid
                entries={[
                  {
                    key: "Newest compatible",
                    value: `${plugin.version} — already installed`,
                  },
                ]}
              />
            </div>
          </DetailsDisclosure>
          <p className="text-xs text-subtle-foreground">
            Keep using {plugin.version} and check again when a compatible plugin
            version is available.
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button type="button" disabled>
            <Icon name={UPDATE_ACTION_ICON} aria-hidden />
            Update
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{name} is up to date</DialogTitle>
        <DialogDescription>{fromLine}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
