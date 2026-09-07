import { useMemo } from "react";
import type { Host, ProjectSource } from "@bb/domain";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { getEnvironmentWorkspaceLabelIconName } from "@/lib/environment-workspace-display";
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
  encodeHostValue,
  parseEnvironmentValue,
  REUSE_VALUE_WITHOUT_ENVIRONMENT,
} from "./environment-picker-value";

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
  onChange: (value: string) => void;
  sources: readonly ProjectSource[];
  host: Host | null;
  isLocal: boolean;
  reuseDisabled?: boolean;
  worktreeDisabledReason?: string | null;
  muted?: boolean;
  disabled?: boolean;
  className?: string;
  defaultOpen?: boolean;
  modal?: boolean;
  machines?: EnvironmentPickerMachines | null;
  onRequestMachineSetup?: (host: Host) => void;
}

export function EnvironmentPickerUI({
  value,
  onChange,
  sources,
  host,
  isLocal,
  reuseDisabled,
  worktreeDisabledReason,
  muted,
  disabled = false,
  className,
  defaultOpen,
  modal,
  machines,
  onRequestMachineSetup,
}: EnvironmentPickerUIProps) {
  const hostId = host?.id ?? null;
  const isMachineMenu = (machines?.hosts.length ?? 0) > 1;
  const hostConnected = host?.status === "connected";
  const hasSource = useMemo(
    () =>
      hostId !== null &&
      findLocalPathProjectSourceForHost(sources, hostId) !== undefined,
    [hostId, sources],
  );
  const localLabel = isLocal ? "Work locally" : "Work remotely";

  const hostUnavailableReason = !host
    ? "No host connected"
    : !hostConnected
      ? "Host is offline"
      : null;
  const workspaceDisabledReason = hasSource
    ? null
    : "Project source unavailable";
  const newWorktreeDisabledReason =
    workspaceDisabledReason ?? worktreeDisabledReason ?? null;
  const reuseDisabledReason = reuseDisabled
    ? "No worktrees in this project yet"
    : null;

  const parsed = useMemo(() => parseEnvironmentValue(value), [value]);

  const selectedMachineName = useMemo(() => {
    if (!isMachineMenu || !machines || parsed?.type !== "host") return null;
    return (
      machines.hosts.find((machineHost) => machineHost.id === parsed.hostId)
        ?.name ?? null
    );
  }, [isMachineMenu, machines, parsed]);

  const selected = useMemo((): SelectedEnvironment => {
    if (hostUnavailableReason !== null) {
      return {
        modeLabel: selectedMachineName
          ? `${selectedMachineName} · ${hostUnavailableReason}`
          : hostUnavailableReason,
        compactModeLabel: host ? "Offline" : "No host",
        icon: "AlertTriangle" as const,
      };
    }
    if (!parsed) {
      return {
        modeLabel: "Environment",
        compactModeLabel: "Env",
        icon: "Laptop" as const,
      };
    }
    if (parsed.type === "reuse") {
      return {
        modeLabel: "Reuse worktree",
        compactModeLabel: "Reuse",
        icon: getEnvironmentWorkspaceLabelIconName("managed-worktree"),
      };
    }
    const modeLabel = parsed.mode === "worktree" ? "New worktree" : localLabel;
    const compactModeLabel =
      parsed.mode === "worktree" ? "Worktree" : isLocal ? "Local" : "Remote";
    const icon = getEnvironmentWorkspaceLabelIconName(
      parsed.mode === "worktree" ? "managed-worktree" : "other",
    );
    return {
      modeLabel: selectedMachineName
        ? `${selectedMachineName} · ${modeLabel}`
        : modeLabel,
      compactModeLabel,
      icon,
    };
  }, [
    parsed,
    localLabel,
    isLocal,
    hostUnavailableReason,
    host,
    selectedMachineName,
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
            <Icon
              name={selected.icon}
              className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
            />
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
        {isMachineMenu && machines ? (
          <MachineGroupedEnvironmentOptions
            machines={machines}
            sources={sources}
            selectedHostId={parsed?.type === "host" ? parsed.hostId : hostId}
            worktreeDisabledReason={worktreeDisabledReason ?? null}
            reuseDisabledReason={reuseDisabledReason}
            selectedType={parsed?.type}
            value={value}
            onChange={onChange}
            onRequestMachineSetup={onRequestMachineSetup}
          />
        ) : (
          <EnvironmentOptionsSection
            hostId={hostId}
            hostName={isLocal ? null : (host?.name ?? null)}
            hostUnavailableReason={hostUnavailableReason}
            localLabel={localLabel}
            workspaceDisabledReason={workspaceDisabledReason}
            worktreeDisabledReason={newWorktreeDisabledReason}
            reuseDisabledReason={reuseDisabledReason}
            selectedType={parsed?.type}
            value={value}
            onChange={onChange}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface EnvironmentOptionsSectionProps {
  hostId: string | null;
  hostName: string | null;
  hostUnavailableReason: string | null;
  localLabel: string;
  workspaceDisabledReason: string | null;
  worktreeDisabledReason: string | null;
  reuseDisabledReason: string | null;
  selectedType:
    | NonNullable<ReturnType<typeof parseEnvironmentValue>>["type"]
    | undefined;
  value: string;
  onChange: (value: string) => void;
}

function EnvironmentOptionsSection({
  hostId,
  hostName,
  hostUnavailableReason,
  localLabel,
  workspaceDisabledReason,
  worktreeDisabledReason,
  reuseDisabledReason,
  selectedType,
  value,
  onChange,
}: EnvironmentOptionsSectionProps) {
  const localValue = hostId ? encodeHostValue(hostId, "local") : null;
  const worktreeValue = hostId ? encodeHostValue(hostId, "worktree") : null;
  const workspaceDisabled = workspaceDisabledReason !== null;
  const workspaceDisabledDescription = workspaceDisabledReason ?? undefined;
  const worktreeDisabled = worktreeDisabledReason !== null;
  const worktreeDisabledDescription = worktreeDisabledReason ?? undefined;

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
      ) : (
        <>
          <EnvironmentMenuItem
            label={localLabel}
            description={workspaceDisabledDescription}
            icon={getEnvironmentWorkspaceLabelIconName("other")}
            selected={localValue !== null && value === localValue}
            disabled={workspaceDisabled || localValue === null}
            onSelect={() => {
              if (localValue !== null) onChange(localValue);
            }}
          />
          <EnvironmentMenuItem
            label="New worktree"
            description={worktreeDisabledDescription}
            icon={getEnvironmentWorkspaceLabelIconName("managed-worktree")}
            selected={worktreeValue !== null && value === worktreeValue}
            disabled={worktreeDisabled || worktreeValue === null}
            onSelect={() => {
              if (worktreeValue !== null) onChange(worktreeValue);
            }}
          />
          <EnvironmentMenuItem
            label="Existing worktree"
            description={reuseDisabledReason ?? undefined}
            icon={getEnvironmentWorkspaceLabelIconName("managed-worktree")}
            selected={selectedType === "reuse"}
            disabled={reuseDisabledReason !== null}
            onSelect={() => onChange(REUSE_VALUE_WITHOUT_ENVIRONMENT)}
          />
        </>
      )}
    </DropdownMenuGroup>
  );
}

const MACHINE_BADGE_CLASS_NAME =
  "shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground";

interface MachineGroupedEnvironmentOptionsProps {
  machines: EnvironmentPickerMachines;
  sources: readonly ProjectSource[];
  selectedHostId: string | null;
  worktreeDisabledReason: string | null;
  reuseDisabledReason: string | null;
  selectedType:
    | NonNullable<ReturnType<typeof parseEnvironmentValue>>["type"]
    | undefined;
  value: string;
  onChange: (value: string) => void;
  onRequestMachineSetup: ((host: Host) => void) | undefined;
}

function MachineGroupedEnvironmentOptions({
  machines,
  sources,
  selectedHostId,
  worktreeDisabledReason,
  reuseDisabledReason,
  selectedType,
  value,
  onChange,
  onRequestMachineSetup,
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
          worktreeDisabledReason={
            machineHost.id === selectedHostId ? worktreeDisabledReason : null
          }
          now={now}
          value={value}
          onChange={onChange}
          onRequestMachineSetup={onRequestMachineSetup}
        />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <EnvironmentMenuItem
          label="Existing worktree"
          description={reuseDisabledReason ?? undefined}
          icon={getEnvironmentWorkspaceLabelIconName("managed-worktree")}
          selected={selectedType === "reuse"}
          disabled={reuseDisabledReason !== null}
          onSelect={() => onChange(REUSE_VALUE_WITHOUT_ENVIRONMENT)}
        />
      </DropdownMenuGroup>
    </>
  );
}

interface MachineSectionProps {
  host: Host;
  isThisMachine: boolean;
  source: ProjectSource | null;
  worktreeDisabledReason: string | null;
  now: number;
  value: string;
  onChange: (value: string) => void;
  onRequestMachineSetup: ((host: Host) => void) | undefined;
}

function MachineSection({
  host,
  isThisMachine,
  source,
  worktreeDisabledReason,
  now,
  value,
  onChange,
  onRequestMachineSetup,
}: MachineSectionProps) {
  const connected = host.status === "connected";
  const localValue = encodeHostValue(host.id, "local");
  const worktreeValue = encodeHostValue(host.id, "worktree");
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-muted-foreground">
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
      {source ? (
        <>
          <EnvironmentMenuItem
            label={isThisMachine ? "Work locally" : "Work in checkout"}
            hint={source.path}
            icon={getEnvironmentWorkspaceLabelIconName("other")}
            selected={value === localValue}
            disabled={!connected}
            onSelect={() => onChange(localValue)}
          />
          <EnvironmentMenuItem
            label="New worktree"
            description={
              connected ? (worktreeDisabledReason ?? undefined) : undefined
            }
            icon={getEnvironmentWorkspaceLabelIconName("managed-worktree")}
            selected={value === worktreeValue}
            disabled={!connected || worktreeDisabledReason !== null}
            onSelect={() => onChange(worktreeValue)}
          />
        </>
      ) : onRequestMachineSetup && connected ? (
        <EnvironmentMenuItem
          label={`Set up on ${host.name}…`}
          icon="Plus"
          selected={false}
          onSelect={() => onRequestMachineSetup(host)}
        />
      ) : (
        <DropdownMenuItem
          disabled
          className="whitespace-normal break-words text-xs text-muted-foreground"
        >
          Not set up for this project
        </DropdownMenuItem>
      )}
    </DropdownMenuGroup>
  );
}

interface EnvironmentMenuItemProps {
  label: string;
  description?: string;
  hint?: string;
  icon: IconName;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

function EnvironmentMenuItem({
  label,
  description,
  hint,
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
        <Icon
          name={icon}
          className={cn(
            "mt-px max-md:pointer-coarse:mt-0",
            "text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
          )}
        />
        <span className="flex min-w-0 flex-col">
          <span className="whitespace-normal break-words text-xs">{label}</span>
          {description ? (
            <span className="mt-0.5 whitespace-normal break-words text-xs leading-snug text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      </span>
      {hint ? (
        <span className="max-w-32 truncate text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
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
