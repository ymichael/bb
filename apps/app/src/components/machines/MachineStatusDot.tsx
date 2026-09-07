import { cn } from "@bb/shared-ui/lib/utils";

export function MachineStatusDot({
  connected,
  className,
}: {
  connected: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        connected ? "bg-success" : "border border-muted-foreground",
        className,
      )}
    />
  );
}
