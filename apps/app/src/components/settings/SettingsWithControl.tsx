import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsWithControl({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(
      "flex flex-col gap-2 sm:flex-row sm:justify-between sm:gap-4",
      description ? "sm:items-start" : "sm:items-center",
    )}>
      <div className="flex-1">
        <p className="text-sm font-semibold">{label}</p>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="sm:flex sm:min-w-[320px] sm:justify-end">{children}</div>
    </div>
  );
}
