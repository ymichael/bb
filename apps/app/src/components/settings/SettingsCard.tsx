import type { ReactNode } from "react";

interface SettingsCardProps {
  children: ReactNode;
  description?: string;
  title: string;
}

export function SettingsCard({ children, description, title }: SettingsCardProps) {
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
