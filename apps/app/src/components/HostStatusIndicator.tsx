import { cn } from "@/lib/utils";

interface HostStatusDotProps {
  className?: string;
}

/** Small green dot indicating a host is online. */
export function HostStatusDot({ className }: HostStatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full bg-emerald-500",
        className,
      )}
      aria-label="Online"
    />
  );
}

interface HostOfflinePillProps {
  className?: string;
}

/** Small pill indicating a host is offline. */
export function HostOfflinePill({ className }: HostOfflinePillProps) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full bg-amber-400/15 px-1.5 py-px ui-text-2xs font-medium text-amber-500",
        className,
      )}
    >
      offline
    </span>
  );
}

interface HostStatusBadgeProps {
  connected: boolean;
  className?: string;
}

/** Renders a green dot when connected, or an "offline" pill when not. */
export function HostStatusBadge({ connected, className }: HostStatusBadgeProps) {
  return connected
    ? <HostStatusDot className={className} />
    : <HostOfflinePill className={className} />;
}
