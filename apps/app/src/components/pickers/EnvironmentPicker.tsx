import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, Laptop } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Host, ProjectSource, SandboxBackendInfo } from "@bb/domain";
import { LocalhostBadge } from "@/components/ui";
import {
  findLocalPathProjectSourceForHost,
  isGitHubRepoProjectSource,
} from "@bb/domain";
import { Button } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@/components/ui";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useSandboxBackends } from "@/hooks/queries/system-queries";
import { useEffectiveHosts } from "@/hooks/queries/effective-hosts";
import { sandboxHostSupportedAtom } from "@/lib/system-config-atoms";
import { getEnvironmentWorkspaceLabelIcon } from "@/lib/environment-workspace-display";
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

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

function encodeHostValue(hostId: string, mode: "local" | "worktree"): string {
  return `host:${hostId}:${mode}`;
}

function encodeSandboxValue(backendId: string): string {
  return `sandbox:${backendId}`;
}

interface ParsedHostValue {
  type: "host";
  hostId: string;
  mode: "local" | "worktree";
}

interface ParsedSandboxValue {
  type: "sandbox";
  backendId: string;
}

type ParsedEnvironmentValue = ParsedHostValue | ParsedSandboxValue | null;

export function parseEnvironmentValue(value: string): ParsedEnvironmentValue {
  if (value.startsWith("host:")) {
    const parts = value.split(":");
    const hostId = parts[1];
    const mode = parts[2];
    if (hostId && (mode === "local" || mode === "worktree")) {
      return { type: "host", hostId, mode };
    }
  }
  if (value.startsWith("sandbox:")) {
    const backendId = value.slice("sandbox:".length);
    if (backendId) {
      return { type: "sandbox", backendId };
    }
  }
  return null;
}

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
  icon: LucideIcon;
  hostConnected?: boolean;
}

export interface EnvironmentPickerUIProps {
  value: string;
  onChange: (value: string) => void;
  projectId: string | null;
  sources: readonly ProjectSource[];
  hosts: readonly Host[];
  sandboxBackends: readonly SandboxBackendInfo[];
  sandboxHostSupported: boolean;
  isLocalHost: (hostId: string | null | undefined) => boolean;
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
  projectId,
  sources,
  hosts,
  sandboxBackends,
  sandboxHostSupported,
  isLocalHost,
  muted,
  defaultOpen,
  modal,
}: EnvironmentPickerUIProps) {
  const hostSections = useMemo(
    () => buildHostSections(hosts, sources, isLocalHost),
    [hosts, sources, isLocalHost],
  );

  const selected = useMemo((): SelectedEnvironment => {
    const parsed = parseEnvironmentValue(value);
    if (!parsed) return { modeLabel: "Environment", icon: Laptop };
    if (parsed.type === "host") {
      const host = hosts.find((h) => h.id === parsed.hostId);
      const isLocal = isLocalHost(parsed.hostId);
      const modeLabel =
        parsed.mode === "worktree"
          ? "New worktree"
          : isLocal
            ? "Work locally"
            : "Work remotely";
      const icon = getEnvironmentWorkspaceLabelIcon(
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
    }
    const backend = sandboxBackends.find((b) => b.id === parsed.backendId);
    return {
      modeLabel: backend?.displayName ?? "Sandbox",
      icon: getEnvironmentWorkspaceLabelIcon("sandbox"),
    };
  }, [value, hosts, sandboxBackends, isLocalHost]);

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
            <selected.icon
              className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
            />
            <span className="truncate">
              {selected.modeLabel}
              {selected.hostLabel ? (
                <span className="text-muted-foreground/60">
                  {" "}
                  · {selected.hostLabel}
                </span>
              ) : null}
            </span>
            {selected.hostConnected !== undefined ? (
              <HostStatusBadge connected={selected.hostConnected} />
            ) : null}
          </span>
          <ChevronDown
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

        {sandboxHostSupported && sandboxBackends.some((b) => b.available) ? (
          <SandboxSection
            backends={sandboxBackends}
            hasGitHubSource={sources.some(isGitHubRepoProjectSource)}
            projectId={projectId}
            value={value}
            onChange={onChange}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Connected variant — wires app-wide hooks (jotai atoms + React Query) into
// the presentational EnvironmentPickerUI. App callers use this; stories use
// EnvironmentPickerUI directly with mocks.
// ---------------------------------------------------------------------------

export interface EnvironmentPickerProps {
  value: string;
  onChange: (value: string) => void;
  projectId: string | null;
  sources: readonly ProjectSource[];
  muted?: boolean;
}

export function EnvironmentPicker({
  value,
  onChange,
  projectId,
  sources,
  muted,
}: EnvironmentPickerProps) {
  const { isLocalHost } = useHostDaemon();
  const { data: hosts = [] } = useEffectiveHosts();
  const sandboxHostSupported = useAtomValue(sandboxHostSupportedAtom);
  const { data: sandboxBackends = [] } =
    useSandboxBackends(sandboxHostSupported);

  return (
    <EnvironmentPickerUI
      value={value}
      onChange={onChange}
      projectId={projectId}
      sources={sources}
      hosts={hosts}
      sandboxBackends={sandboxBackends}
      sandboxHostSupported={sandboxHostSupported}
      isLocalHost={isLocalHost}
      muted={muted}
    />
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
            icon={getEnvironmentWorkspaceLabelIcon("other")}
            itemValue={localValue}
            selectedValue={value}
            onSelect={onChange}
          />
          <EnvironmentMenuItem
            label="New worktree"
            icon={getEnvironmentWorkspaceLabelIcon("managed-worktree")}
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

// ---------------------------------------------------------------------------
// Sandbox section
// ---------------------------------------------------------------------------

interface SandboxSectionProps {
  backends: readonly SandboxBackendInfo[];
  hasGitHubSource: boolean;
  projectId: string | null;
  value: string;
  onChange: (value: string) => void;
}

function SandboxSection({
  backends,
  hasGitHubSource,
  projectId,
  value,
  onChange,
}: SandboxSectionProps) {
  const navigate = useNavigate();

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Sandbox</DropdownMenuLabel>
      {hasGitHubSource ? (
        backends
          .filter((backend) => backend.available)
          .map((backend) => (
            <EnvironmentMenuItem
              key={backend.id}
              label={backend.displayName}
              icon={getEnvironmentWorkspaceLabelIcon("sandbox")}
              itemValue={encodeSandboxValue(backend.id)}
              selectedValue={value}
              onSelect={onChange}
            />
          ))
      ) : (
        <div className="px-2 pb-1.5">
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => {
              if (projectId) {
                navigate(`/projects/${projectId}/settings`);
              }
            }}
          >
            Connect project to GitHub
          </button>
        </div>
      )}
    </DropdownMenuGroup>
  );
}

// ---------------------------------------------------------------------------
// Shared menu item
// ---------------------------------------------------------------------------

interface EnvironmentMenuItemProps {
  label: string;
  icon: LucideIcon;
  itemValue: string;
  selectedValue: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}

function EnvironmentMenuItem({
  label,
  icon: Icon,
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
          className={cn(
            "text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
          )}
        />
        <span className="truncate text-xs">{label}</span>
      </span>
      <Check
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          itemValue === selectedValue ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}
