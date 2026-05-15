import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils";

interface HostStatusDotProps {
  className?: string;
}

/** Small green dot indicating a host is online. */
export function HostStatusDot({ className }: HostStatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full bg-success",
        className,
      )}
      aria-label="Online"
    />
  );
}

interface HostOfflineBadgeProps {
  className?: string;
}

/** Small badge indicating a host is offline. */
export function HostOfflineBadge({ className }: HostOfflineBadgeProps) {
  return (
    <Badge variant="muted" className={cn("shrink-0", className)}>
      offline
    </Badge>
  );
}

interface HostStatusBadgeProps {
  connected: boolean;
  className?: string;
}

/** Renders a green dot when connected, or an "offline" badge when not. */
export function HostStatusBadge({
  connected,
  className,
}: HostStatusBadgeProps) {
  return connected ? (
    <HostStatusDot className={className} />
  ) : (
    <HostOfflineBadge className={className} />
  );
}
