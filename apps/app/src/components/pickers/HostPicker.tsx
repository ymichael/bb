import type { Host } from "@bb/domain";
import { Icon } from "@/components/ui/icon.js";
import { LocalhostBadge } from "@/components/ui/localhost-badge.js";
import { Button } from "@/components/ui/button.js";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@/components/ui/coarse-pointer-sizing.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import { getHostIconName } from "@/lib/host-display";
import { cn } from "@/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_CONTENT_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
} from "./OptionPicker";

interface HostPickerProps {
  hosts: Host[];
  eligibleHosts: Host[];
  selectedHostId: string;
  onChange: (hostId: string) => void;
  isLocalHost: (hostId: string | null | undefined) => boolean;
  /** Render with the menu open on mount. Story-only escape hatch. */
  defaultOpen?: boolean;
  /** Whether the menu blocks page interaction. Defaults to Radix's true; pass false in stories. */
  modal?: boolean;
}

export function HostPicker({
  hosts,
  eligibleHosts,
  selectedHostId,
  onChange,
  isLocalHost,
  defaultOpen,
  modal,
}: HostPickerProps) {
  const selectedHost = hosts.find((h) => h.id === selectedHostId);
  const isLocal = selectedHost ? isLocalHost(selectedHost.id) : false;
  const label = selectedHost?.name ?? "Select host";
  const isConnected = selectedHost?.status === "connected";
  const selectedHostIcon = getHostIconName(selectedHost);

  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={modal}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Host"
          title={`Host: ${label}`}
          className={cn(OPTION_BASE_CLASS_NAME, OPTION_INTERACTIVE_CLASS_NAME)}
        >
          <span className={OPTION_CONTENT_CLASS_NAME}>
            <Icon name={selectedHostIcon} className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
            {isLocal ? <LocalhostBadge /> : null}
            {selectedHost ? <HostStatusBadge connected={isConnected} /> : null}
          </span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44 max-w-80">
        {eligibleHosts.length > 0 ? (
          eligibleHosts.map((host) => {
            const hostIcon = getHostIconName(host);
            return (
            <DropdownMenuItem
              key={host.id}
              onSelect={() => onChange(host.id)}
              className="flex items-center justify-between gap-3"
            >
              <span className="flex min-w-0 items-center gap-2 text-xs">
                <Icon name={hostIcon} className="size-3.5 shrink-0" />
                <span className="truncate">{host.name}</span>
                {isLocalHost(host.id) ? <LocalhostBadge /> : null}
                <HostStatusBadge connected={host.status === "connected"} />
              </span>
              <Icon name="Check"
                className={cn(
                  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
                  host.id === selectedHostId ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
            );
          })
        ) : (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            No hosts available for this project
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
