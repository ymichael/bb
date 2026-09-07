import type { AriaRole, ReactNode } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

type PluginBannerTone = "destructive" | "warning";

const TONE_ICON: Record<PluginBannerTone, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
};

export function PluginBannerBar({
  tone,
  icon,
  title,
  detail,
  action,
  separator = true,
  role,
}: {
  tone: PluginBannerTone;
  icon: IconName;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  separator?: boolean;
  role?: AriaRole;
}) {
  return (
    <div
      role={role}
      className={cn(
        "bg-surface-recessed/55",
        separator && "border-b border-border",
      )}
    >
      <div className="mx-auto flex w-full min-w-0 max-w-5xl items-start gap-3 px-4 py-2.5 md:px-5">
        <Icon
          name={icon}
          className={cn("mt-0.5 size-4 shrink-0", TONE_ICON[tone])}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {detail === null || detail === undefined ? null : (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
        {action ? (
          <span className="flex shrink-0 items-center pt-0.5">{action}</span>
        ) : null}
      </div>
    </div>
  );
}
