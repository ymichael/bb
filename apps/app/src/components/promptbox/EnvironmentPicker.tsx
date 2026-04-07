import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { Check, ChevronDown, Cloud, Monitor } from "lucide-react";
import type { Host, ProjectSource, SandboxBackendInfo } from "@bb/domain";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
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
  icon: typeof Monitor;
  hostConnected?: boolean;
}

interface EnvironmentPickerProps {
  value: string;
  onChange: (value: string) => void;
  sources: readonly ProjectSource[];
}

export function EnvironmentPicker({
  value,
  onChange,
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
      const host = hosts.find((h) => h.id === parsed.hostId);
      const hostConnected = host?.status === "connected";
      if (isLocalHost(parsed.hostId)) {
        return { modeLabel, icon: Monitor, hostConnected };
      }
      return { modeLabel, hostLabel: host?.name ?? "Unknown", icon: Monitor, hostConnected };
    }
    const backend = sandboxBackends.find((b) => b.id === parsed.backendId);
    return { modeLabel: backend?.displayName ?? "Cloud", icon: Cloud };
  }, [value, hosts, sandboxBackends]);

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
            <selected.icon className="size-3.5 shrink-0" />
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
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52 max-w-80 divide-y [&>*+*]:pt-2 [&>*:not(:last-child)]:pb-2">
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
        <DropdownMenuLabel className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{section.host.name}</span>
          {section.isLocal ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
              localhost
            </span>
          ) : null}
          {section.isConnected ? <HostStatusDot /> : null}
        </DropdownMenuLabel>
        {enabled ? (
          <>
            <EnvironmentMenuItem
              label="Direct"
              itemValue={localValue}
              selectedValue={value}
              onSelect={onChange}
            />
            <EnvironmentMenuItem
              label="Worktree"
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
  value: string;
  onChange: (value: string) => void;
}

function SandboxSection({ backends, value, onChange }: SandboxSectionProps) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-[11px] text-muted-foreground">
        Cloud
      </DropdownMenuLabel>
      {backends
        .filter((backend) => backend.available)
        .map((backend) => (
          <EnvironmentMenuItem
            key={backend.id}
            label={backend.displayName}
            itemValue={encodeSandboxValue(backend.id)}
            selectedValue={value}
            onSelect={onChange}
          />
        ))}
    </DropdownMenuGroup>
  );
}

// ---------------------------------------------------------------------------
// Shared menu item
// ---------------------------------------------------------------------------

interface EnvironmentMenuItemProps {
  label: string;
  itemValue: string;
  selectedValue: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}

function EnvironmentMenuItem({
  label,
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
      <span className="truncate text-xs">{label}</span>
      <Check
        className={cn(
          "size-4",
          itemValue === selectedValue ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}
