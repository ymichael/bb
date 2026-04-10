import type { ReactNode } from "react";

interface SettingsRowProps {
  children: ReactNode;
}

export function SettingsRow({ children }: SettingsRowProps) {
  return (
    <div className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0">
      {children}
    </div>
  );
}

interface SettingsRowListProps {
  children: ReactNode;
}

export function SettingsRowList({ children }: SettingsRowListProps) {
  return (
    <div className="divide-y divide-border">
      {children}
    </div>
  );
}
