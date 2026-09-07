import { useId, useState } from "react";
import type { Host, ProviderInfo } from "@bb/domain";
import type {
  ProviderUsage,
  ProviderUsageResponse,
  ProviderUsageWindow,
} from "@bb/host-daemon-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  SettingsBadge,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  useSystemConfig,
  useSystemProviderUsageLimits,
  useSystemProviders,
  type ProviderUsageQueryState,
} from "@/hooks/queries/system-queries";
import { selectPrimaryHost, useHosts } from "@/hooks/queries/host-queries";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { ProviderIconMark } from "./ProviderIconMark";
import { cn } from "@bb/shared-ui/lib/utils";

interface ProviderConfig {
  name: string;
  providerId: string;
  signInHint: string;
  expiredHint: string;
  strings: ProviderInfo["strings"];
  provider: ProviderInfo | undefined;
}

function providerConfig(
  providerId: string,
  info: ProviderInfo | undefined,
): ProviderConfig {
  const name = info?.displayName ?? providerId;
  return {
    providerId,
    name,
    strings: info?.strings,
    provider: info,
    signInHint:
      info?.strings?.signInHint ?? `Sign in to ${name}, then reload usage.`,
    expiredHint:
      info?.strings?.expiredHint ??
      `Your ${name} session expired. Sign in again, then reload usage.`,
  };
}

function barColorClass(usedPercent: number): string {
  if (usedPercent >= 95) {
    return "bg-destructive";
  }
  if (usedPercent >= 80) {
    return "bg-warning";
  }
  return "bg-primary";
}

function formatReset(resetsAt: string | null): string | null {
  if (!resetsAt) {
    return null;
  }
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) {
    return null;
  }
  const diffMs = reset.getTime() - Date.now();
  if (diffMs <= 0) {
    return "Resetting now";
  }

  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `Resets in ${diffMinutes} min`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    const minutes = diffMinutes % 60;
    return minutes > 0
      ? `Resets in ${diffHours} hr ${minutes} min`
      : `Resets in ${diffHours} hr`;
  }

  const withinWeek = diffMs < 7 * 24 * 60 * 60_000;
  const formatted = reset.toLocaleString(undefined, {
    weekday: withinWeek ? "short" : undefined,
    month: withinWeek ? undefined : "short",
    day: withinWeek ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Resets ${formatted}`;
}

function formatUsdCents(cents: number, alwaysShowCents: boolean): string {
  const hasFractionalDollar = cents % 100 !== 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: alwaysShowCents || hasFractionalDollar ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function usageWindowValue(window: ProviderUsageWindow): string {
  if (!window.cost) {
    return `${window.usedPercent}% used`;
  }
  return `${formatUsdCents(window.cost.usedUsdCents, true)} / ${formatUsdCents(window.cost.limitUsdCents, false)}`;
}

function UsageWindowRow({ window }: { window: ProviderUsageWindow }) {
  const reset = formatReset(window.resetsAt);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-foreground">{window.label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {usageWindowValue(window)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            barColorClass(window.usedPercent),
          )}
          style={{ width: `${Math.max(window.usedPercent, 2)}%` }}
        />
      </div>
      {reset ? <p className="text-xs text-muted-foreground">{reset}</p> : null}
    </div>
  );
}

interface ProviderUsageBlockProps {
  config: ProviderConfig;
  usage: ProviderUsage | undefined;
  isLoading: boolean;
  isError: boolean;
}

export interface UsageLimitsSettingsSectionContentProps {
  usage: ProviderUsageResponse;
  isLoading: boolean;
  isError: boolean;
  isProviderListLoading?: boolean;
  isProviderListError?: boolean;
  isFetching: boolean;
  onRefresh: () => void;
  providerStates?: Readonly<Record<string, ProviderUsageQueryState>>;
  providers?: readonly ProviderInfo[];
  hosts?: readonly Host[];
  selectedHostId?: string | null;
  onSelectHost?: (hostId: string) => void;
}

function UsageMachinePicker({
  hosts,
  selectedHostId,
  onSelectHost,
}: {
  hosts: readonly Host[];
  selectedHostId: string | null;
  onSelectHost: (hostId: string) => void;
}) {
  const selectedHost =
    hosts.find((host) => host.id === selectedHostId) ?? hosts[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-w-48 gap-1.5"
          aria-label="Usage limits machine"
        >
          <Icon name="Laptop" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {selectedHost?.name ?? "Machine"}
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle="Usage limits machine">
        {hosts.map((host) => {
          const connected = host.status === "connected";
          return (
            <DropdownMenuItem
              key={host.id}
              disabled={!connected}
              onSelect={() => onSelectHost(host.id)}
              className="flex items-center gap-2"
            >
              <MachineStatusDot connected={connected} />
              <span className="min-w-0 flex-1 truncate">{host.name}</span>
              {host.id === selectedHost?.id ? (
                <Icon name="Check" className="size-3.5 shrink-0" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderUsageBlock({
  config,
  usage,
  isLoading,
  isError,
}: ProviderUsageBlockProps) {
  const planLabel = usage?.status === "ok" ? usage.planLabel : null;
  const accountEmail = usage?.status === "ok" ? usage.accountEmail : null;
  const iconInfo = getProviderIconInfo(
    config.providerId,
    config.provider ?? null,
  );
  const ProviderIcon = iconInfo?.icon;
  const headingId = useId();
  const showsUsageWindows =
    !isError && usage?.status === "ok" && usage.windows.length > 0;

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3.5 py-3.5 first:pt-0 last:pb-0"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {ProviderIcon ? (
            <span aria-hidden="true" className="mt-0.5 shrink-0">
              <ProviderIconMark
                provider={{ id: config.providerId, strings: config.strings }}
                icon={ProviderIcon}
                className="size-4"
              />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <h3
              id={headingId}
              className="text-sm font-semibold text-foreground"
            >
              {config.name}
            </h3>
            {accountEmail ? (
              <p className="truncate text-xs text-muted-foreground">
                {accountEmail}
              </p>
            ) : null}
            {!showsUsageWindows ? (
              <div className={accountEmail ? "mt-1.5" : undefined}>
                <ProviderUsageBody
                  config={config}
                  usage={usage}
                  isLoading={isLoading}
                  isError={isError}
                />
              </div>
            ) : null}
          </div>
        </div>
        {planLabel ? <SettingsBadge>{planLabel}</SettingsBadge> : null}
      </div>
      {showsUsageWindows ? (
        <div className={ProviderIcon ? "pl-6" : undefined}>
          <ProviderUsageBody
            config={config}
            usage={usage}
            isLoading={isLoading}
            isError={isError}
          />
        </div>
      ) : null}
    </section>
  );
}

function ProviderUsageBody({
  config,
  usage,
  isLoading,
  isError,
}: ProviderUsageBlockProps) {
  if (isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn&apos;t load usage right now. Make sure the selected machine is
        connected, then reload usage.
      </p>
    );
  }
  if (!usage) {
    return (
      <p className="text-xs text-muted-foreground">
        {isLoading ? "Loading usage…" : "Usage not provided."}
      </p>
    );
  }
  switch (usage.status) {
    case "ok":
      if (usage.windows.length === 0) {
        return (
          <p className="text-xs text-muted-foreground">
            No usage limits reported for this plan.
          </p>
        );
      }
      return (
        <div className="space-y-3.5">
          {usage.windows.map((window) => (
            <UsageWindowRow key={window.label} window={window} />
          ))}
        </div>
      );
    case "not_installed":
      return (
        <p className="text-xs text-muted-foreground">
          Not installed on this machine.
        </p>
      );
    case "unauthenticated":
      return (
        <p className="text-xs text-muted-foreground">{config.signInHint}</p>
      );
    case "expired":
      return (
        <p className="text-xs text-muted-foreground">{config.expiredHint}</p>
      );
    case "error":
      return <p className="text-xs text-muted-foreground">{usage.message}</p>;
    default:
      return null;
  }
}

export function UsageLimitsSettingsSectionContent({
  usage,
  isLoading,
  isError,
  isProviderListLoading = false,
  isProviderListError = false,
  isFetching,
  onRefresh,
  providerStates = {},
  providers = [],
  hosts = [],
  selectedHostId = null,
  onSelectHost,
}: UsageLimitsSettingsSectionContentProps) {
  const showMachinePicker = hosts.length > 1 && onSelectHost !== undefined;
  const providerById = new Map(
    providers.map((provider) => [provider.id, provider] as const),
  );
  const reportedProviderIds = Object.keys(usage);
  const orderedProviderIds = [
    ...providers
      .filter((provider) => provider.maintenance.usage)
      .map((provider) => provider.id),
    ...reportedProviderIds.filter(
      (providerId) => !providerById.has(providerId),
    ),
  ];
  const providerConfigs = orderedProviderIds
    .filter((providerId) => usage[providerId]?.status !== "not_installed")
    .map((providerId) =>
      providerConfig(providerId, providerById.get(providerId)),
    );
  const emptyMessage =
    isLoading || isProviderListLoading
      ? "Loading providers and usage…"
      : isError || isProviderListError
        ? "Couldn't load providers or usage right now."
        : "No providers available.";
  return (
    <SettingsSection
      actionPlacement={showMachinePicker ? "responsive" : "inline"}
      title="Usage limits"
      description="Your provider subscription usage."
      action={
        <div className="flex items-center gap-1">
          {showMachinePicker ? (
            <UsageMachinePicker
              hosts={hosts}
              selectedHostId={selectedHostId}
              onSelectHost={onSelectHost}
            />
          ) : null}
          <Tooltip delayDuration={300} disableHoverableContent>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                disabled={isFetching}
                onClick={onRefresh}
                aria-label={
                  isFetching ? "Reloading usage data" : "Reload usage data"
                }
              >
                <Icon
                  name="RotateCcw"
                  className={cn("size-3.5", isFetching && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reload usage data</TooltipContent>
          </Tooltip>
        </div>
      }
    >
      <SettingsRowList>
        {providerConfigs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyMessage}</p>
        ) : (
          providerConfigs.map((config) => (
            <ProviderUsageBlock
              key={config.providerId}
              config={config}
              usage={usage[config.providerId]}
              isLoading={
                providerStates[config.providerId]?.isLoading ?? isLoading
              }
              isError={providerStates[config.providerId]?.isError ?? isError}
            />
          ))
        )}
      </SettingsRowList>
    </SettingsSection>
  );
}

export function UsageLimitsSettingsSection() {
  const systemConfigQuery = useSystemConfig();
  const hostsQuery = useHosts();
  const hosts = hostsQuery.data ?? [];
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const primaryHost = selectPrimaryHost(
    hosts,
    systemConfigQuery.data?.primaryHostId ?? null,
  );
  const selectedHost =
    hosts.find((host) => host.id === selectedHostId) ?? primaryHost;
  const usageHostId =
    selectedHost?.id ?? systemConfigQuery.data?.primaryHostId ?? undefined;
  const providersQuery = useSystemProviders(
    usageHostId === undefined
      ? {
          capability: "usage",
          enabled: systemConfigQuery.data !== undefined,
        }
      : {
          capability: "usage",
          enabled: systemConfigQuery.data !== undefined,
          hostId: usageHostId,
        },
  );
  const providers = providersQuery.data ?? [];
  const usageQuery = useSystemProviderUsageLimits({
    ...(usageHostId === undefined ? {} : { hostId: usageHostId }),
    enabled: systemConfigQuery.data !== undefined && providersQuery.isSuccess,
    providerIds: providers.map((provider) => provider.id),
  });

  return (
    <UsageLimitsSettingsSectionContent
      usage={usageQuery.usage}
      isLoading={usageQuery.isLoading}
      isError={usageQuery.isError}
      isProviderListLoading={providersQuery.isLoading}
      isProviderListError={providersQuery.isError}
      isFetching={usageQuery.isFetching}
      onRefresh={() => {
        void usageQuery.refetch();
      }}
      providerStates={usageQuery.providerStates}
      providers={providers}
      hosts={hosts}
      selectedHostId={selectedHost?.id ?? null}
      onSelectHost={setSelectedHostId}
    />
  );
}
