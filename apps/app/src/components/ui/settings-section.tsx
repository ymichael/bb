import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsSectionProps {
  action?: ReactNode;
  children: ReactNode;
  description?: string;
  title: string;
}

export function SettingsSection({
  action,
  children,
  description,
  title,
}: SettingsSectionProps) {
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="rounded-lg border border-border bg-card px-3 py-2.5">
        {children}
      </div>
    </section>
  );
}

export interface SettingsCardProps {
  children: ReactNode;
  description?: string;
  title: string;
}

export function SettingsCard({
  children,
  description,
  title,
}: SettingsCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="mb-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export interface SettingsRowListProps {
  children: ReactNode;
}

export function SettingsRowList({ children }: SettingsRowListProps) {
  return <div className="divide-y divide-border">{children}</div>;
}

export interface SettingsRowProps {
  children: ReactNode;
}

export function SettingsRow({ children }: SettingsRowProps) {
  return (
    <div className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0">
      {children}
    </div>
  );
}

export interface SettingsWithControlProps {
  label: string;
  description?: string;
  children: ReactNode;
}

export function SettingsWithControl({
  label,
  description,
  children,
}: SettingsWithControlProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 sm:flex-row sm:justify-between sm:gap-4",
        description ? "sm:items-start" : "sm:items-center",
      )}
    >
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
