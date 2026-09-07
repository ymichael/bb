import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { appToast } from "@/components/ui/app-toast";
import { invalidatePluginList } from "@/hooks/cache-owners/plugin-cache-owner";
import {
  checkPluginUpdates,
  type PluginUpdatesEntry,
} from "@/hooks/queries/plugin-catalog-queries";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";

export function summarizeUpdateCheck(
  results: readonly PluginUpdatesEntry[],
  scope: { pluginId?: string } = {},
): {
  tone: "success" | "message" | "warning";
  title: string;
  description?: string;
} {
  const ids = (outcome: PluginUpdatesEntry["outcome"]) =>
    results
      .filter((result) => result.outcome === outcome)
      .map((result) => result.id)
      .sort();
  const available = ids("update-available");
  const unavailable = ids("unavailable");
  const problem =
    unavailable.length === 0
      ? null
      : scope.pluginId !== undefined
        ? (results[0]?.detail ?? "The update check did not complete.")
        : `Could not check ${unavailable.length === 1 ? "1 plugin" : `${unavailable.length} plugins`}: ${unavailable.join(", ")}.`;
  if (available.length > 0) {
    return {
      tone: problem === null ? "success" : "warning",
      title: `${available.length} plugin update${available.length === 1 ? "" : "s"} available`,
      description: [available.join(", "), problem].filter(Boolean).join(" "),
    };
  }
  if (problem !== null) {
    return {
      tone: "warning",
      title:
        scope.pluginId === undefined
          ? "Update check incomplete"
          : `Could not check ${scope.pluginId} for updates`,
      description: problem,
    };
  }
  return {
    tone: "message",
    title:
      scope.pluginId === undefined
        ? "All plugins are up to date"
        : `${scope.pluginId} is up to date`,
  };
}

export function CheckPluginUpdatesButton({
  pluginId,
  appearance = "toolbar",
}: {
  pluginId?: string;
  appearance?: "toolbar" | "inline";
}) {
  const queryClient = useQueryClient();
  const check = useMutation({
    meta: { showErrorToast: false },
    mutationFn: () =>
      checkPluginUpdates(fetch, pluginId === undefined ? {} : { id: pluginId }),
    onSuccess: (results) => {
      const summary = summarizeUpdateCheck(results, { pluginId });
      appToast[summary.tone](summary.title, {
        description: summary.description,
      });
    },
    onError: (error) => {
      appToast.error("Checking for plugin updates failed", {
        description: pluginAdminErrorMessage(error),
      });
    },
    onSettled: () => invalidatePluginList({ queryClient }),
  });
  const label = check.isPending ? "Checking for updates…" : "Check for updates";
  const inline = appearance === "inline";
  const button = (
    <Button
      type="button"
      variant="outline"
      size={inline ? "sm" : "icon"}
      data-testid="check-plugin-updates"
      className={
        inline
          ? "h-6 px-2 text-xs"
          : "size-8 shrink-0 rounded-md border border-input bg-background p-0 text-muted-foreground"
      }
      aria-label={label}
      aria-busy={check.isPending}
      disabled={check.isPending}
      onClick={() => check.mutate()}
    >
      <Icon
        name={check.isPending ? "Spinner" : "RotateCcw"}
        className={cn(
          inline ? "size-3.5" : "size-4",
          check.isPending && "animate-spin",
        )}
        aria-hidden
      />
      {inline ? "Check" : null}
    </Button>
  );
  if (inline) return button;
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
