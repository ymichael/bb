import type { ComponentProps, ReactNode } from "react";
import { Icon, type IconName } from "../icon";
import { Textarea } from "../textarea";
import { cn } from "../../../lib/utils";
import { ResourceTabDescription } from "./toolbar";

export type ResourceDetailSurface = "raised" | "recessed" | "flat";

export function ResourceDetailPanel({
  children,
  className,
  surface = "raised",
}: {
  children: ReactNode;
  className?: string;
  surface?: ResourceDetailSurface;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden",
        surface === "raised" &&
          "rounded-md border border-border bg-surface-raised shadow-sm",
        surface === "recessed" &&
          "rounded-md border border-border bg-surface-recessed/70",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ResourcePromptContextItem {
  icon?: IconName;
  label: ReactNode;
}

export function ResourcePromptPreview({
  children,
  className,
  context = [],
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  context?: readonly ResourcePromptContextItem[];
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-background",
        disabled && "bg-surface-recessed/55",
        className,
      )}
    >
      <div
        data-resource-prompt-content=""
        role="textbox"
        aria-label="Saved prompt"
        aria-readonly="true"
        aria-disabled={disabled || undefined}
        className={cn(
          "min-h-[68px] min-w-0 whitespace-pre-wrap px-4 pb-1 pr-14 pt-3 text-sm leading-relaxed text-foreground",
          disabled && "text-muted-foreground",
        )}
      >
        {children}
      </div>
      {context.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1 pb-2 pl-3.5 pr-2 pt-1.5 text-xs text-muted-foreground">
          {context.map((item, index) => (
            <span key={index} className="contents">
              {item.icon ? (
                <Icon
                  name={item.icon}
                  className="size-3.5 shrink-0"
                  aria-hidden
                />
              ) : null}
              <span className="contents">{item.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ResourceDetailList({
  children,
  className,
  surface,
}: {
  children: ReactNode;
  className?: string;
  surface?: ResourceDetailSurface;
}) {
  return (
    <ResourceDetailPanel surface={surface} className={cn("p-1", className)}>
      {children}
    </ResourceDetailPanel>
  );
}

export function ResourceDetailCollection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ResourceDetailList
      surface="flat"
      className={cn(
        "divide-y divide-border overflow-hidden rounded-md border border-border bg-background p-0",
        className,
      )}
    >
      {children}
    </ResourceDetailList>
  );
}

export function ResourceDetailListItem({
  leading,
  children,
  trailing,
  className,
}: {
  leading?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-sm px-2 py-1.5 text-sm",
        className,
      )}
    >
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </div>
  );
}

export function ResourceDetailActionRow({
  label,
  description,
  action,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  action: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start justify-between gap-3 text-sm",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 min-w-0 break-words text-xs leading-snug text-subtle-foreground/75">
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{action}</div>
    </div>
  );
}

export const ResourcePropertyList = ResourceDetailPanel;

export function ResourceDetailStack({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "divide-y divide-border/80 [&>[data-resource-detail-section]]:py-6 [&>[data-resource-detail-section]:first-child]:pt-0 [&>[data-resource-detail-section]:last-child]:pb-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ResourceProperty({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 px-3 py-3 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
      <div className="font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words text-foreground">{children}</div>
    </div>
  );
}

export function ResourcePromptEditor({
  value,
  ariaLabel,
  placeholder,
  hint,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  hint?: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
      <Textarea
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="min-h-52 resize-y rounded-none border-0 bg-transparent px-3.5 py-3 text-sm leading-relaxed shadow-none focus-visible:ring-0"
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <div className="flex items-center gap-1.5 bg-surface-recessed/55 px-3 py-2 text-2xs text-muted-foreground">
          <Icon name="Info" className="size-3.5" aria-hidden />
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function ResourceSection({
  label,
  count,
  leading,
  collapsed,
  onToggle,
  children,
}: {
  label: ReactNode;
  count: number;
  leading?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 bg-surface-recessed px-3 py-1.5 text-xs text-muted-foreground hover:bg-state-hover"
      >
        <Icon
          name="ChevronRight"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            !collapsed && "rotate-90",
          )}
          aria-hidden
        />
        {leading}
        <span className="font-medium">{label}</span>
        <span className="text-subtle-foreground">{count}</span>
      </button>
      {collapsed ? null : <div className="p-1">{children}</div>}
    </section>
  );
}

export function ResourceSectionTitle({
  className,
  ...props
}: ComponentProps<"h2">) {
  return (
    <h2
      className={cn(
        "text-sm font-medium leading-5 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ResourceOverview({
  description,
  browse,
  className,
  children,
}: {
  description: ReactNode;
  browse?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      <ResourceTabDescription>{description}</ResourceTabDescription>
      {browse}
      {children}
    </div>
  );
}
