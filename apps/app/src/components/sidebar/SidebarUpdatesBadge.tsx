import { Link } from "react-router-dom";
import type { ProviderCliKey } from "@bb/host-daemon-contract";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { useProviderCliInstallRunner } from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { SidebarMenuItem } from "@/components/ui/sidebar.js";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useUpdateInventory } from "@/hooks/useUpdateInventory";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { getSettingsRoutePath } from "@/lib/route-paths";

interface SidebarUpdatesBadgeProps {
  onNavigate?: () => void;
}

const CHIP_CLASS = cn(
  "flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-sidebar-border px-2",
  "text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
);

function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface StaleProvider {
  provider: ProviderCliKey;
  displayName: string;
}

export function SidebarUpdatesBadge({ onNavigate }: SidebarUpdatesBadgeProps) {
  const inventory = useUpdateInventory();
  const providers = useSystemProviders().data;
  const { runningJobKey } = useProviderCliInstallRunner();

  const stuckDaemonCount = inventory.machines.filter(
    (machine) => machine.canRetryDaemonUpdate,
  ).length;
  const bbUpdateCount =
    (inventory.appUpdateAvailable ? 1 : 0) +
    (inventory.desktopUpdateReady ? 1 : 0) +
    stuckDaemonCount;

  const staleProvidersByKey = new Map<ProviderCliKey, StaleProvider>();
  for (const machine of inventory.machines) {
    for (const issue of machine.issues) {
      if (!issue.status.installed) {
        continue;
      }
      if (!staleProvidersByKey.has(issue.provider)) {
        staleProvidersByKey.set(issue.provider, {
          provider: issue.provider,
          displayName: issue.status.displayName,
        });
      }
    }
  }
  const staleProviders = [...staleProvidersByKey.values()];
  const providerUpdateRunning = inventory.machines.some((machine) =>
    machine.issues.some(
      (issue) =>
        issue.status.installed &&
        runningJobKey === providerCliJobKey(machine.host.id, issue.provider),
    ),
  );

  if (bbUpdateCount === 0 && staleProviders.length === 0) {
    return null;
  }

  const updatesRoutePath = getSettingsRoutePath("updates");
  const bbLabel =
    bbUpdateCount === 1 ? "bb update available" : "bb updates available";
  const providerLabel = `${joinNames(
    staleProviders.map((stale) => stale.displayName),
  )} ${staleProviders.length === 1 ? "update" : "updates"} available`;

  return (
    <SidebarMenuItem className="flex min-w-0 items-center gap-1">
      {bbUpdateCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={bbLabel}
              data-testid="sidebar-updates-badge-bb"
              className={CHIP_CLASS}
            >
              <Icon name="Download" className="size-3 text-muted-foreground" />
              bb
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{bbLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {staleProviders.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={providerLabel}
              data-testid="sidebar-updates-badge-providers"
              className={CHIP_CLASS}
            >
              <Icon
                name={providerUpdateRunning ? "Loading" : "Download"}
                className={cn(
                  "size-3 text-muted-foreground",
                  providerUpdateRunning && "animate-spin",
                )}
              />
              <span className="flex items-center gap-1">
                {staleProviders.map((stale) => {
                  const providerId = stale.provider;
                  const provider = providers?.find(
                    (candidate) => candidate.id === providerId,
                  );
                  const iconInfo = getProviderIconInfo(
                    providerId,
                    provider ?? null,
                  );
                  if (iconInfo === undefined) {
                    return null;
                  }
                  return (
                    <span
                      key={stale.provider}
                      data-provider-icon={providerId}
                      aria-hidden
                      className="flex size-3 shrink-0 items-center justify-center"
                    >
                      {provider === undefined ? (
                        <iconInfo.icon className="size-3" />
                      ) : (
                        <ProviderIconMark
                          provider={provider}
                          icon={iconInfo.icon}
                          className="size-3"
                        />
                      )}
                    </span>
                  );
                })}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{providerLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}
