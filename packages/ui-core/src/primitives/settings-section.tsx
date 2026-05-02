import type { ReactNode } from "react";

export interface SettingsSectionProps {
  title: string;
  children: ReactNode;
}

export function SettingsSection({
  title,
  children,
}: SettingsSectionProps) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="rounded-lg border border-border bg-card px-3 py-2.5">
        {children}
      </div>
    </section>
  );
}
