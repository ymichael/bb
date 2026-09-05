import { EnvironmentProviderIcon } from "@/components/plugin/EnvironmentProviderIcon";
import { MachineProviderIcon } from "@/components/plugin/MachineProviderIcon";
import { useMemo } from "react";
import type { Host, ProjectSource } from "@bb/domain";
import type {
  SystemEnvironmentProvider,
  SystemMachineProvider,
} from "@bb/server-contract";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { pluginIconName } from "@/components/plugin/PluginIcon";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { REUSE_ENVIRONMENT_ICON_NAME } from "@/lib/environment-workspace-display";
import { formatRelativeTime } from "@/lib/relative-time";
import { formatHostUpdateStatus } from "@/lib/host-update-status";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MENU_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import {
  encodeProviderValue,
  parseEnvironmentValue,
} from "./environment-picker-value";
import { selectHosts } from "@/hooks/queries/host-queries";
import { providerInputsControlRequired } from "./environment-provider-inputs";
import { machineProviderInputsControlRequired } from "./machine-provider-inputs";

interface SelectedEnvironment {
  modeLabel: string;
  compactModeLabel: string;
  icon: IconName;
}

export interface EnvironmentPickerMachines {
  hosts: readonly Host[];
  localDaemonHostId: string | null;
  primaryHostId: string | null;
}

export interface EnvironmentPickerUIProps {
  value: string;
  sources: readonly ProjectSource[];
  host: Host | null;
  isLocal: boolean;
  muted?: boolean;
  disabled?: boolean;
  className?: string;
  defaultOpen?: boolean;
  modal?: boolean;
  machines?: EnvironmentPickerMachines | null;
  onRequestMachineSetup?: (host: Host) => void;
  providers?: readonly SystemEnvironmentProvider[];
  projectless?: boolean;
  providersByHostId?: ReadonlyMap<
    string,
    readonly SystemEnvironmentProvider[] | undefined
  >;
  selectedProviderHostId?: string | null;
  inputsControlProviderIds?: ReadonlySet<string>;
  onSelectProvider?: (
    provider: SystemEnvironmentProvider,
    hostId: string | null,
  ) => void;
  machineProviders?: readonly SystemMachineProvider[];
  selectedMachineProviderId?: string | null;
  machineInputsControlProviderIds?: ReadonlySet<string>;
  onSelectMachineProvider?: (provider: SystemMachineProvider) => void;
}

export const PROVIDER_INPUTS_CONTROL_MISSING_REASON =
  "Needs its plugin's control";

const NO_INPUTS_CONTROL_PROVIDER_IDS: ReadonlySet<string> = new Set();

function machineProviderDisabledReason(
  provider: SystemMachineProvider,
  inputsControlProviderIds: ReadonlySet<string>,
): string | null {
  if (provider.availability?.status === "unavailable") {
    return provider.availability.message;
  }
  if (
    !inputsControlProviderIds.has(provider.id) &&
    machineProviderInputsControlRequired(provider)
  ) {
    return PROVIDER_INPUTS_CONTROL_MISSING_REASON;
  }
  return null;
}

function providerValueSelected(
  value: string,
  provider: SystemEnvironmentProvider,
): boolean {
  return value === encodeProviderValue(provider.id);
}

function providerDisabledReason(
  provider: SystemEnvironmentProvider,
  inputsControlProviderIds: ReadonlySet<string>,
): string | null {
  if (provider.availability?.status === "unavailable") {
    return provider.availability.message;
  }
  if (
    !inputsControlProviderIds.has(provider.id) &&
    providerInputsControlRequired(provider)
  ) {
    return PROVIDER_INPUTS_CONTROL_MISSING_REASON;
  }
  return null;
}

function providerDescription(
  provider: SystemEnvironmentProvider,
  inputsControlProviderIds: ReadonlySet<string>,
): string | undefined {
  if (provider.availability?.status === "setup-required") {
    return provider.availability.message;
  }
  return (
    providerDisabledReason(provider, inputsControlProviderIds) ?? undefined
  );
}

function scopedProviders(
  providers: readonly SystemEnvironmentProvider[],
  providersByHostId: EnvironmentPickerUIProps["providersByHostId"],
  hostId: string | null,
): readonly SystemEnvironmentProvider[] {
  if (hostId === null || providersByHostId === undefined) return providers;
  const hostProviders = new Map(
    (providersByHostId.get(hostId) ?? []).map((provider) => [
      provider.id,
      provider,
    ]),
  );
  return providers.flatMap((provider) => {
    const hostProvider = hostProviders.get(provider.id);
    return hostProvider === undefined ? [] : [hostProvider];
  });
}

export function EnvironmentPickerUI({
  value,
  sources,
  host,
  isLocal,
  muted,
  disabled = false,
  className,
  defaultOpen,
  modal,
  machines,
  onRequestMachineSetup,
  providers = [],
  projectless = false,
  providersByHostId,
  selectedProviderHostId = null,
  inputsControlProviderIds = NO_INPUTS_CONTROL_PROVIDER_IDS,
  onSelectProvider,
  machineProviders: creatableMachineProviders = [],
  selectedMachineProviderId = null,
  machineInputsControlProviderIds = NO_INPUTS_CONTROL_PROVIDER_IDS,
  onSelectMachineProvider,
}: EnvironmentPickerUIProps) {
  const availableMachines = useMemo(
    () =>
      machines === null || machines === undefined
        ? null
        : { ...machines, hosts: selectHosts(machines.hosts) },
    [machines],
  );
  const hostId = host?.id ?? null;
  const hasMultipleMachines = (availableMachines?.hosts.length ?? 0) > 1;
  const environmentProviders = useMemo(
    () =>
      providers.filter(
        (provider) => provider.requires.projectless === projectless,
      ),
    [projectless, providers],
  );
  const isMachineMenu = hasMultipleMachines;
  const hostConnected = host?.status === "connected";
  const hostUnavailableReason = !host
    ? "No host connected"
    : !hostConnected
      ? "Host is offline"
      : null;
  const parsed = useMemo(() => parseEnvironmentValue(value), [value]);

  const selectedMachineName = useMemo(() => {
    if (!hasMultipleMachines || !availableMachines) return null;
    const machineHostId =
      parsed?.type === "provider" ? selectedProviderHostId : null;
    if (machineHostId === null) return null;
    return (
      availableMachines.hosts.find(
        (machineHost) => machineHost.id === machineHostId,
      )?.name ?? null
    );
  }, [hasMultipleMachines, parsed, availableMachines, selectedProviderHostId]);

  const selectedProvider = useMemo(
    () =>
      parsed?.type === "provider"
        ? environmentProviders.find(
            (provider) => provider.id === parsed.environmentProviderId,
          )
        : undefined,
    [environmentProviders, parsed],
  );
  const selectedMachineProvider = useMemo(
    () =>
      selectedMachineProviderId === null
        ? undefined
        : creatableMachineProviders.find(
            (provider) => provider.id === selectedMachineProviderId,
          ),
    [creatableMachineProviders, selectedMachineProviderId],
  );

  const selected = useMemo((): SelectedEnvironment => {
    if (
      selectedMachineProvider !== undefined &&
      selectedMachineProvider.environmentRow !== null
    ) {
      return {
        modeLabel: selectedMachineProvider.environmentRow.displayName,
        compactModeLabel: selectedMachineProvider.environmentRow.displayName,
        icon: pluginIconName(selectedMachineProvider.icon),
      };
    }
    if (selectedProvider !== undefined && hostUnavailableReason === null) {
      const showsHost = selectedMachineName !== null;
      return {
        modeLabel: showsHost
          ? `${selectedMachineName} · ${selectedProvider.displayName}`
          : selectedProvider.displayName,
        compactModeLabel: selectedProvider.displayName,
        icon: pluginIconName(selectedProvider.icon),
      };
    }
    if (hostUnavailableReason !== null) {
      return {
        modeLabel: selectedMachineName
          ? `${selectedMachineName} · ${hostUnavailableReason}`
          : hostUnavailableReason,
        compactModeLabel: host ? "Offline" : "No host",
        icon: "AlertTriangle" as const,
      };
    }
    if (parsed?.type === "reuse") {
      return {
        modeLabel: "Reuse",
        compactModeLabel: "Reuse",
        icon: REUSE_ENVIRONMENT_ICON_NAME,
      };
    }
    return {
      modeLabel: "Environment",
      compactModeLabel: "Env",
      icon: "Laptop" as const,
    };
  }, [
    parsed,
    hostUnavailableReason,
    host,
    selectedMachineName,
    selectedProvider,
    selectedMachineProvider,
  ]);

  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={modal}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Environment"
          disabled={disabled}
          data-promptbox-icon-only-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            !disabled && OPTION_INTERACTIVE_CLASS_NAME,
            !disabled && LIST_HOVER_TRANSITION,
            muted && OPTION_MUTED_CLASS_NAME,
            disabled && "cursor-default disabled:opacity-100",
            className,
          )}
        >
          <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
            {selectedMachineProvider !== undefined ? (
              <MachineProviderIcon
                provider={selectedMachineProvider}
                className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
              />
            ) : selectedProvider === undefined ? (
              <Icon
                name={selected.icon}
                className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
              />
            ) : (
              <EnvironmentProviderIcon
                provider={selectedProvider}
                className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
              />
            )}
            <span className="min-w-0 truncate" data-promptbox-full-label="">
              {selected.modeLabel}
            </span>
            <span
              className="min-w-0 truncate"
              data-promptbox-compact-label=""
              data-promptbox-hide-tiny=""
            >
              {selected.compactModeLabel}
            </span>
          </span>
          {disabled ? null : (
            <Icon
              name="ChevronDown"
              className={cn(
                "shrink-0 text-muted-foreground",
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
              )}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, "max-w-80")}
        mobileTitle="Environment"
      >
        {onSelectMachineProvider === undefined ? null : (
          <MachineProviderEnvironmentOptions
            providers={creatableMachineProviders}
            selectedProviderId={selectedMachineProviderId}
            inputsControlProviderIds={machineInputsControlProviderIds}
            onSelect={onSelectMachineProvider}
          />
        )}
        {isMachineMenu && availableMachines ? (
          <MachineGroupedEnvironmentOptions
            machines={availableMachines}
            sources={sources}
            value={value}
            onRequestMachineSetup={onRequestMachineSetup}
            machineProviders={environmentProviders}
            providersByHostId={providersByHostId}
            selectedProviderHostId={selectedProviderHostId}
            inputsControlProviderIds={inputsControlProviderIds}
            onSelectProvider={onSelectProvider}
          />
        ) : (
          <EnvironmentOptionsSection
            hostId={hostId}
            hostName={isLocal ? null : (host?.name ?? null)}
            hostUnavailableReason={hostUnavailableReason}
            value={value}
            machineProviders={scopedProviders(
              environmentProviders,
              providersByHostId,
              hostId,
            )}
            selectedProviderHostId={selectedProviderHostId}
            inputsControlProviderIds={inputsControlProviderIds}
            onSelectProvider={onSelectProvider}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MachineProviderEnvironmentOptions({
  providers,
  selectedProviderId,
  inputsControlProviderIds,
  onSelect,
}: {
  providers: readonly SystemMachineProvider[];
  selectedProviderId: string | null;
  inputsControlProviderIds: ReadonlySet<string>;
  onSelect: (provider: SystemMachineProvider) => void;
}) {
  const rows = providers.filter((provider) => provider.environmentRow !== null);
  if (rows.length === 0) return null;
  return (
    <DropdownMenuGroup>
      {rows.map((provider) => {
        const disabledReason = machineProviderDisabledReason(
          provider,
          inputsControlProviderIds,
        );
        const description =
          provider.availability?.status === "setup-required"
            ? provider.availability.message
            : (disabledReason ?? undefined);
        return (
          <MachineProviderMenuItem
            key={provider.id}
            provider={provider}
            label={provider.environmentRow?.displayName ?? provider.displayName}
            description={description}
            selected={selectedProviderId === provider.id}
            disabled={disabledReason !== null}
            onSelect={() => onSelect(provider)}
          />
        );
      })}
    </DropdownMenuGroup>
  );
}

interface EnvironmentOptionsSectionProps {
  hostId: string | null;
  hostName: string | null;
  hostUnavailableReason: string | null;
  value: string;
  machineProviders: readonly SystemEnvironmentProvider[];
  selectedProviderHostId: string | null;
  inputsControlProviderIds: ReadonlySet<string>;
  onSelectProvider:
    | ((provider: SystemEnvironmentProvider, hostId: string | null) => void)
    | undefined;
}

function EnvironmentOptionsSection({
  hostId,
  hostName,
  hostUnavailableReason,
  value,
  machineProviders,
  selectedProviderHostId,
  inputsControlProviderIds,
  onSelectProvider,
}: EnvironmentOptionsSectionProps) {
  return (
    <DropdownMenuGroup>
      {hostName ? (
        <DropdownMenuLabel className="whitespace-normal break-words text-muted-foreground">
          {hostName}
        </DropdownMenuLabel>
      ) : null}
      {hostUnavailableReason !== null ? (
        <DropdownMenuItem
          disabled
          className="whitespace-normal break-words text-xs text-muted-foreground"
        >
          {hostUnavailableReason}
        </DropdownMenuItem>
      ) : onSelectProvider !== undefined && hostId !== null ? (
        machineProviders.map((provider) => {
          const disabledReason = providerDisabledReason(
            provider,
            inputsControlProviderIds,
          );
          return (
            <EnvironmentMenuItem
              key={provider.id}
              label={provider.displayName}
              description={providerDescription(
                provider,
                inputsControlProviderIds,
              )}
              icon={pluginIconName(provider.icon)}
              provider={provider}
              selected={
                providerValueSelected(value, provider) &&
                selectedProviderHostId === hostId
              }
              disabled={disabledReason !== null}
              onSelect={() => onSelectProvider(provider, hostId)}
            />
          );
        })
      ) : null}
    </DropdownMenuGroup>
  );
}

const MACHINE_BADGE_CLASS_NAME =
  "shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground";

interface MachineGroupedEnvironmentOptionsProps {
  machines: EnvironmentPickerMachines;
  sources: readonly ProjectSource[];
  value: string;
  onRequestMachineSetup: ((host: Host) => void) | undefined;
  machineProviders: readonly SystemEnvironmentProvider[];
  providersByHostId: EnvironmentPickerUIProps["providersByHostId"];
  selectedProviderHostId: string | null;
  inputsControlProviderIds: ReadonlySet<string>;
  onSelectProvider:
    | ((provider: SystemEnvironmentProvider, hostId: string | null) => void)
    | undefined;
}

function MachineGroupedEnvironmentOptions({
  machines,
  sources,
  value,
  onRequestMachineSetup,
  machineProviders,
  providersByHostId,
  selectedProviderHostId,
  inputsControlProviderIds,
  onSelectProvider,
}: MachineGroupedEnvironmentOptionsProps) {
  const now = Date.now();
  const orderedHosts = [...machines.hosts].sort(
    (left, right) =>
      Number(left.id !== machines.localDaemonHostId) -
      Number(right.id !== machines.localDaemonHostId),
  );
  return (
    <>
      {orderedHosts.map((machineHost) => (
        <MachineSection
          key={machineHost.id}
          host={machineHost}
          isThisMachine={machineHost.id === machines.localDaemonHostId}
          source={
            findLocalPathProjectSourceForHost(sources, machineHost.id) ?? null
          }
          now={now}
          value={value}
          onRequestMachineSetup={onRequestMachineSetup}
          machineProviders={scopedProviders(
            machineProviders,
            providersByHostId,
            machineHost.id,
          )}
          selectedProviderHostId={selectedProviderHostId}
          inputsControlProviderIds={inputsControlProviderIds}
          onSelectProvider={onSelectProvider}
        />
      ))}
    </>
  );
}

interface MachineSectionProps {
  host: Host;
  isThisMachine: boolean;
  source: ProjectSource | null;
  now: number;
  value: string;
  onRequestMachineSetup: ((host: Host) => void) | undefined;
  machineProviders: readonly SystemEnvironmentProvider[];
  selectedProviderHostId: string | null;
  inputsControlProviderIds: ReadonlySet<string>;
  onSelectProvider:
    | ((provider: SystemEnvironmentProvider, hostId: string | null) => void)
    | undefined;
}

function MachineSection({
  host,
  isThisMachine,
  source,
  now,
  value,
  onRequestMachineSetup,
  machineProviders,
  selectedProviderHostId,
  inputsControlProviderIds,
  onSelectProvider,
}: MachineSectionProps) {
  const connected = host.status === "connected";
  const hostProviders = machineProviders;
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="min-w-0 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <MachineStatusDot connected={connected} />
          <span className="min-w-0 truncate">{host.name}</span>
          {isThisMachine ? (
            <span className={MACHINE_BADGE_CLASS_NAME}>this machine</span>
          ) : null}
          {formatHostUpdateStatus(host) !== null ? (
            <span className="ml-auto shrink-0 pl-2 text-2xs text-warning-foreground">
              {formatHostUpdateStatus(host)}
            </span>
          ) : !connected && host.lastSeenAt !== null ? (
            <span className="ml-auto shrink-0 pl-2 text-2xs">
              last seen{" "}
              {formatRelativeTime({ timestamp: host.lastSeenAt, now })}
            </span>
          ) : null}
        </span>
      </DropdownMenuLabel>
      {onSelectProvider !== undefined
        ? hostProviders.map((provider) => {
            const disabledReason = providerDisabledReason(
              provider,
              inputsControlProviderIds,
            );
            return (
              <EnvironmentMenuItem
                key={provider.id}
                label={provider.displayName}
                description={
                  connected
                    ? providerDescription(provider, inputsControlProviderIds)
                    : undefined
                }
                icon={pluginIconName(provider.icon)}
                provider={provider}
                selected={
                  providerValueSelected(value, provider) &&
                  selectedProviderHostId === host.id
                }
                disabled={!connected || disabledReason !== null}
                onSelect={() => onSelectProvider(provider, host.id)}
              />
            );
          })
        : null}
      {source === null && onRequestMachineSetup && connected ? (
        <EnvironmentMenuItem
          label={`Set up on ${host.name}…`}
          icon="Plus"
          selected={false}
          onSelect={() => onRequestMachineSetup(host)}
        />
      ) : source === null && hostProviders.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="whitespace-normal break-words text-xs text-muted-foreground"
        >
          Not set up for this project
        </DropdownMenuItem>
      ) : null}
    </DropdownMenuGroup>
  );
}

interface EnvironmentMenuItemProps {
  provider?: SystemEnvironmentProvider;
  label: string;
  description?: string;
  icon: IconName;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

function EnvironmentMenuItem({
  provider,
  label,
  description,
  icon,
  selected,
  onSelect,
  disabled,
}: EnvironmentMenuItemProps) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => {
        if (disabled) return;
        onSelect();
      }}
      className={cn(
        "flex items-start justify-between gap-3 whitespace-normal",
        LIST_HOVER_TRANSITION,
      )}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        {provider === undefined ? (
          <Icon
            name={icon}
            className={cn(
              "mt-px max-md:pointer-coarse:mt-0",
              "text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
            )}
          />
        ) : (
          <EnvironmentProviderIcon
            provider={provider}
            className={cn(
              "mt-px max-md:pointer-coarse:mt-0 text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
            )}
          />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="whitespace-normal break-words text-xs">{label}</span>
          {description ? (
            <span className="mt-0.5 whitespace-normal break-words text-xs leading-snug text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      </span>
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          "shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}

function MachineProviderMenuItem({
  provider,
  label,
  description,
  selected,
  onSelect,
  disabled,
}: {
  provider: SystemMachineProvider;
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => {
        if (!disabled) onSelect();
      }}
      className={cn(
        "flex items-start justify-between gap-3 whitespace-normal",
        LIST_HOVER_TRANSITION,
      )}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <MachineProviderIcon
          provider={provider}
          className={cn(
            "mt-px max-md:pointer-coarse:mt-0 text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
          )}
        />
        <span className="flex min-w-0 flex-col">
          <span className="whitespace-normal break-words text-xs">{label}</span>
          {description === undefined ? null : (
            <span className="mt-0.5 whitespace-normal break-words text-xs leading-snug text-muted-foreground">
              {description}
            </span>
          )}
        </span>
      </span>
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          "shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}
