import { Check, ChevronDown, Monitor } from "lucide-react";
import type { Host } from "@bb/domain";
import { LocalhostBadge } from "@bb/ui-core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import { cn } from "@/lib/utils";
import {
  PROMPT_OPTION_BASE_CLASS_NAME,
  PROMPT_OPTION_CONTENT_CLASS_NAME,
  PROMPT_OPTION_INTERACTIVE_CLASS_NAME,
} from "./PromptOptionPicker";

interface HostPickerProps {
  hosts: Host[];
  eligibleHosts: Host[];
  selectedHostId: string;
  onChange: (hostId: string) => void;
  isLocalHost: (hostId: string | null | undefined) => boolean;
}

export function HostPicker({
  hosts,
  eligibleHosts,
  selectedHostId,
  onChange,
  isLocalHost,
}: HostPickerProps) {
  const selectedHost = hosts.find((h) => h.id === selectedHostId);
  const isLocal = selectedHost ? isLocalHost(selectedHost.id) : false;
  const label = selectedHost?.name ?? "Select host";
  const isConnected = selectedHost?.status === "connected";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Host"
          title={`Host: ${label}`}
          className={cn(
            PROMPT_OPTION_BASE_CLASS_NAME,
            PROMPT_OPTION_INTERACTIVE_CLASS_NAME,
            "text-foreground",
          )}
        >
          <span className={PROMPT_OPTION_CONTENT_CLASS_NAME}>
            <Monitor className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
            {isLocal ? <LocalhostBadge /> : null}
            {selectedHost ? (
              <HostStatusBadge connected={isConnected} />
            ) : null}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44 max-w-80">
        {eligibleHosts.length > 0 ? (
          eligibleHosts.map((host) => (
            <DropdownMenuItem
              key={host.id}
              onSelect={() => onChange(host.id)}
              className="flex items-center justify-between gap-3"
            >
              <span className="flex min-w-0 items-center gap-2 text-xs">
                <Monitor className="size-3.5 shrink-0" />
                <span className="truncate">{host.name}</span>
                {isLocalHost(host.id) ? <LocalhostBadge /> : null}
                <HostStatusBadge connected={host.status === "connected"} />
              </span>
              <Check
                className={cn(
                  "size-5 shrink-0 md:size-4",
                  host.id === selectedHostId ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            No hosts available for this project
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
