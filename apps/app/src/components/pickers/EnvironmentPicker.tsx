import { useMemo } from "react";
import type { Host, ProjectSource } from "@bb/domain";
import { Icon, type IconName } from "@/components/ui/icon.js";
import { LocalhostBadge } from "@/components/ui/localhost-badge.js";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@/components/ui/coarse-pointer-sizing.js";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useEffectiveHosts } from "@/hooks/queries/effective-hosts";
import { getEnvironmentWorkspaceLabelIconName } from "@/lib/environment-workspace-display";
import {
  HostStatusBadge,
  HostStatusDot,
} from "@/components/HostStatusIndicator";
import { cn } from "@/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_CONTENT_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
} from "./OptionPicker";
import {
  encodeHostValue,
  parseEnvironmentValue,
  REUSE_VALUE_WITHOUT_ENVIRONMENT,
} from "./environment-picker-value";

// ---------------------------------------------------------------------------
// Host section data
// ---------------------------------------------------------------------------

interface HostSection {
  host: Host;
  isLocal: boolean;
  hasSource: boolean;
  isConnected: boolean;
}

function buildHostSections(
  hosts: readonly Host[],
  sources: readonly ProjectSource[],
  isLocalHost: (hostId: string | null | undefined) => boolean,
): HostSection[] {
  const sections = hosts.map((host): HostSection => {
    const isConnected = host.status === "connected";
    const hasSource =
      findLocalPathProjectSourceForHost(sources, host.id) !== undefined;
    return {
      host,
      isLocal: isLocalHost(host.id),
      hasSource,
      isConnected,
    };
  });

  // Sort: connected+has-source first, then connected without source, then disconnected
  sections.sort((a, b) => {
    const scoreA = (a.isConnected ? 2 : 0) + (a.hasSource ? 1 : 0);
    const scoreB = (b.isConnected ? 2 : 0) + (b.hasSource ? 1 : 0);
    return scoreB - scoreA;
  });

  return sections;
}

// ---------------------------------------------------------------------------
// Pure presentational picker. Use directly in stories with mocked data.
// App callers should use EnvironmentPicker (the connected wrapper below).
// ---------------------------------------------------------------------------

interface SelectedEnvironment {
  modeLabel: string;
  hostLabel?: string;
  icon: IconName;
  hostConnected?: boolean;
}

export interface EnvironmentPickerUIProps {
  value: string;
  onChange: (value: string) => void;
  sources: readonly ProjectSource[];
  hosts: readonly Host[];
  isLocalHost: (hostId: string | null | undefined) => boolean;
  /** When true, the "Reuse existing worktree" entry is disabled — the
   * caller signals that the project has no worktree envs available to
   * reuse. The entry is always rendered so the affordance stays
   * discoverable; it just can't be selected. */
  reuseDisabled?: boolean;
  /** Render with the dim, hover-to-foreground treatment used inside the prompt box. */
  muted?: boolean;
  /** Render with the menu open on mount. Story-only escape hatch. */
  defaultOpen?: boolean;
  /** Whether the menu blocks page interaction. Defaults to Radix's true; pass false in stories. */
  modal?: boolean;
}

export function EnvironmentPickerUI({
  value,
  onChange,
  sources,
  hosts,
  isLocalHost,
  reuseDisabled,
  muted,
  defaultOpen,
  modal,
}: EnvironmentPickerUIProps) {
  const hostSections = useMemo(
    () => buildHostSections(hosts, sources, isLocalHost),
    [hosts, sources, isLocalHost],
  );

  const parsed = useMemo(() => parseEnvironmentValue(value), [value]);

  const selected = useMemo((): SelectedEnvironment => {
    if (!parsed) return { modeLabel: "Environment", icon: "Laptop" as const };
    if (parsed.type === "reuse") {
      return {
        modeLabel: "Reuse worktree",
        icon: getEnvironmentWorkspaceLabelIconName("managed-worktree"),
      };
    }
    const host = hosts.find((h) => h.id === parsed.hostId);
    const isLocal = isLocalHost(parsed.hostId);
    const modeLabel =
      parsed.mode === "worktree"
        ? "New worktree"
        : isLocal
          ? "Work locally"
          : "Work remotely";
    const icon = getEnvironmentWorkspaceLabelIconName(
      parsed.mode === "worktree" ? "managed-worktree" : "other",
    );
    if (isLocal) {
      return { modeLabel, icon };
    }
    return {
      modeLabel,
      hostLabel: host?.name ?? "Unknown",
      icon,
      hostConnected: host?.status === "connected",
    };
  }, [parsed, hosts, isLocalHost]);

  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={modal}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Environment"
          title={`Environment: ${selected.modeLabel}${selected.hostLabel ? ` · ${selected.hostLabel}` : ""}`}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            muted && OPTION_MUTED_CLASS_NAME,
          )}
        >
          <span className={OPTION_CONTENT_CLASS_NAME}>
            <Icon
              name={selected.icon}
              className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
            />
            <span className="truncate">
              {selected.modeLabel}
              {selected.hostLabel ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {selected.hostLabel}
                </span>
              ) : null}
            </span>
            {selected.hostConnected !== undefined ? (
              <HostStatusBadge connected={selected.hostConnected} />
            ) : null}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              "text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52 max-w-80 divide-y [&>*+*]:pt-2 [&>*:not(:last-child)]:pb-2"
        mobileTitle="Environment"
      >
        {hostSections.map((section) => {
          const enabled = section.isConnected && section.hasSource;
          return (
            <HostSectionGroup
              key={section.host.id}
              section={section}
              enabled={enabled}
              value={value}
              onChange={onChange}
            />
          );
        })}
        <ReuseSection
          isReuseSelected={parsed?.type === "reuse"}
          disabled={Boolean(reuseDisabled)}
          onChange={onChange}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Connected variant — wires app-wide hooks into the presentational
// EnvironmentPickerUI. App callers use this; stories use EnvironmentPickerUI
// directly with mocks.
// ---------------------------------------------------------------------------

export interface EnvironmentPickerProps {
  value: string;
  onChange: (value: string) => void;
  sources: readonly ProjectSource[];
  reuseDisabled?: boolean;
  muted?: boolean;
}

export function EnvironmentPicker({
  value,
  onChange,
  sources,
  reuseDisabled,
  muted,
}: EnvironmentPickerProps) {
  const { isLocalHost } = useHostDaemon();
  const { data: hosts = [] } = useEffectiveHosts();

  return (
    <EnvironmentPickerUI
      value={value}
      onChange={onChange}
      sources={sources}
      hosts={hosts}
      isLocalHost={isLocalHost}
      reuseDisabled={reuseDisabled}
      muted={muted}
    />
  );
}

// ---------------------------------------------------------------------------
// Reuse section — single entry, sets the value to the bare reuse marker.
// The actual worktree picker lives beside the env picker (see WorktreePicker).
// ---------------------------------------------------------------------------

interface ReuseSectionProps {
  isReuseSelected: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}

function ReuseSection({
  isReuseSelected,
  disabled,
  onChange,
}: ReuseSectionProps) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Reuse</DropdownMenuLabel>
      <DropdownMenuItem
        disabled={disabled}
        onSelect={() => {
          if (disabled) return;
          onChange(REUSE_VALUE_WITHOUT_ENVIRONMENT);
        }}
        className="flex items-center justify-between gap-3"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            name={getEnvironmentWorkspaceLabelIconName("managed-worktree")}
            className={cn(
              "text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
            )}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs">Existing worktree</span>
            {disabled ? (
              // No extra muting: the disabled DropdownMenuItem already
              // applies opacity-50 to its content. Stacking more dimming
              // here would make the subtitle barely readable.
              <span className="text-xs">No worktrees in this project yet</span>
            ) : null}
          </span>
        </span>
        <Icon
          name="Check"
          className={cn(
            COARSE_POINTER_ICON_SIZE_CLASS,
            isReuseSelected ? "opacity-100" : "opacity-0",
          )}
        />
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

// ---------------------------------------------------------------------------
// Host section
// ---------------------------------------------------------------------------

interface HostSectionGroupProps {
  section: HostSection;
  enabled: boolean;
  value: string;
  onChange: (value: string) => void;
}

function HostSectionGroup({
  section,
  enabled,
  value,
  onChange,
}: HostSectionGroupProps) {
  const localValue = encodeHostValue(section.host.id, "local");
  const worktreeValue = encodeHostValue(section.host.id, "worktree");

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="flex items-center gap-1.5">
        <span className="truncate">{section.host.name}</span>
        {section.isLocal ? <LocalhostBadge /> : null}
        {section.isConnected ? <HostStatusDot /> : null}
      </DropdownMenuLabel>
      {enabled ? (
        <>
          <EnvironmentMenuItem
            label={section.isLocal ? "Work locally" : "Work remotely"}
            icon={getEnvironmentWorkspaceLabelIconName("other")}
            itemValue={localValue}
            selectedValue={value}
            onSelect={onChange}
          />
          <EnvironmentMenuItem
            label="New worktree"
            icon={getEnvironmentWorkspaceLabelIconName("managed-worktree")}
            itemValue={worktreeValue}
            selectedValue={value}
            onSelect={onChange}
          />
        </>
      ) : (
        <DropdownMenuItem disabled className="text-xs text-muted-foreground">
          {!section.isConnected
            ? "Host is offline"
            : "Host not configured for project"}
        </DropdownMenuItem>
      )}
    </DropdownMenuGroup>
  );
}

// Shared menu item
// ---------------------------------------------------------------------------

interface EnvironmentMenuItemProps {
  label: string;
  icon: IconName;
  itemValue: string;
  selectedValue: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}

function EnvironmentMenuItem({
  label,
  icon,
  itemValue,
  selectedValue,
  onSelect,
  disabled,
}: EnvironmentMenuItemProps) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onSelect(itemValue)}
      className="flex items-center justify-between gap-3"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          name={icon}
          className={cn(
            "text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
          )}
        />
        <span className="truncate text-xs">{label}</span>
      </span>
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          itemValue === selectedValue ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}
