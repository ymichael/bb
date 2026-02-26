import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusPillVariant = "default" | "secondary" | "destructive" | "outline";

export function StatusPill({
  variant,
  className,
  children,
}: {
  variant: StatusPillVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge
      variant={variant}
      className={cn("rounded-sm px-1.5 py-0 ui-text-xs", className)}
    >
      {children}
    </Badge>
  );
}
