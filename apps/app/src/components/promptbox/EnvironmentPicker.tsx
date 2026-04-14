import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, Monitor } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Host, ProjectSource, SandboxBackendInfo } from "@bb/domain";
import { LocalhostBadge } from "@bb/ui-core";
import { findLocalPathProjectSourceForHost, isGitHubRepoProjectSource } from "@bb/domain";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useHosts, useSandboxBackends } from "@/hooks/queries/system-queries";
import { sandboxHostSupportedAtom } from "@/lib/atoms";
import { getEnvironmentWorkspaceDisplayIcon } from "@/lib/environment-workspace-display";
import { HostStatusBadge, HostStatusDot } from "@/components/HostStatusIndicator";
import { cn } from "@/lib/utils";
import {
  PROMPT_OPTION_BASE_CLASS_NAME,
  PROMPT_OPTION_CONTENT_CLASS_NAME,
  PROMPT_OPTION_INTERACTIVE_CLASS_NAME,
} from "./PromptOptionPicker";

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
  hosts: Host[],
  sources: readonly ProjectSource[],
  isLocalHost: (hostId: string | null | undefined) => boolean,
): HostSection[] {
  const sections = hosts.map((host): HostSection => {
    const isConnected = host.status === "connected";
    const hasSource = findLocalPathProjectSourceForHost(sources, host.id) !== undefined;
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
// Component
// ---------------------------------------------------------------------------

interface SelectedEnvironment {
  modeLabel: string;
  hostLabel?: string;
  icon: LucideIcon;
  hostConnected?: boolean;
}

interface EnvironmentPickerProps {
  value: string;
  onChange: (value: string) => void;
  projectId: string | null;
  sources: readonly ProjectSource[];
}

export function EnvironmentPicker({
  value,
  onChange,
  projectId,
  sources,
}: EnvironmentPickerProps) {
  const { isLocalHost } = useHostDaemon();
  const { data: hosts = [] } = useHosts();
  const sandboxHostSupported = useAtomValue(sandboxHostSupportedAtom);
  const { data: sandboxBackends = [] } = useSandboxBackends(sandboxHostSupported);

  const hostSections = useMemo(
    () => buildHostSections(hosts, sources, isLocalHost),
    [hosts, sources, isLocalHost],
  );

  const selected = useMemo((): SelectedEnvironment => {
    const parsed = parseEnvironmentValue(value);
    if (!parsed) return { modeLabel: "Environment", icon: Monitor };
    if (parsed.type === "host") {
      const modeLabel = parsed.mode === "worktree" ? "Worktree" : "Direct";
      const icon = getEnvironmentWorkspaceDisplayIcon(
        parsed.mode === "worktree" ? "git-worktree" : "primary-checkout",
      ) ?? Monitor;
      const host = hosts.find((h) => h.id === parsed.hostId);
      const hostConnected = host?.status === "connected";
      if (isLocalHost(parsed.hostId)) {
        return { modeLabel, icon, hostConnected };
      }
      return { modeLabel, hostLabel: host?.name ?? "Unknown", icon, hostConnected };
    }
    const backend = sandboxBackends.find((b) => b.id === parsed.backendId);
    return {
      modeLabel: backend?.displayName ?? "Sandbox",
      icon: getEnvironmentWorkspaceDisplayIcon("sandbox") ?? Monitor,
    };
  }, [value, hosts, sandboxBackends, isLocalHost]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Environment"
          title={`Environment: ${selected.modeLabel}${selected.hostLabel ? ` · ${selected.hostLabel}` : ""}`}
          className={cn(
            PROMPT_OPTION_BASE_CLASS_NAME,
            PROMPT_OPTION_INTERACTIVE_CLASS_NAME,
          )}
        >
          <span className={PROMPT_OPTION_CONTENT_CLASS_NAME}>
            <selected.icon className="size-5 shrink-0 md:size-3.5" />
            <span className="truncate">
              {selected.modeLabel}
              {selected.hostLabel ? (
                <span className="text-muted-foreground/60"> · {selected.hostLabel}</span>
              ) : null}
            </span>
            {selected.hostConnected !== undefined ? (
              <HostStatusBadge connected={selected.hostConnected} />
            ) : null}
          </span>
          <ChevronDown className="size-5 text-muted-foreground md:size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52 max-w-80 divide-y [&>*+*]:pt-2 [&>*:not(:last-child)]:pb-2" mobileTitle="Environment">
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
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{section.host.name}</span>
          {section.isLocal ? <LocalhostBadge /> : null}
          {section.isConnected ? <HostStatusDot /> : null}
        </DropdownMenuLabel>
        {enabled ? (
          <>
            <EnvironmentMenuItem
              label="Direct"
              icon={getEnvironmentWorkspaceDisplayIcon("primary-checkout") ?? Monitor}
              itemValue={localValue}
              selectedValue={value}
              onSelect={onChange}
            />
            <EnvironmentMenuItem
              label="Worktree"
              icon={getEnvironmentWorkspaceDisplayIcon("git-worktree") ?? Monitor}
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
  backends: SandboxBackendInfo[];
  hasGitHubSource: boolean;
  projectId: string | null;
  value: string;
  onChange: (value: string) => void;
}

function SandboxSection({ backends, hasGitHubSource, projectId, value, onChange }: SandboxSectionProps) {
  const navigate = useNavigate();

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        Sandbox
      </DropdownMenuLabel>
      {hasGitHubSource ? (
        backends
          .filter((backend) => backend.available)
          .map((backend) => (
            <EnvironmentMenuItem
              key={backend.id}
              label={backend.displayName}
              icon={getEnvironmentWorkspaceDisplayIcon("sandbox") ?? Monitor}
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
        <Icon className="size-5 shrink-0 text-muted-foreground md:size-3.5" />
        <span className="truncate text-xs">{label}</span>
      </span>
      <Check
        className={cn(
          "size-5 md:size-4",
          itemValue === selectedValue ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}
