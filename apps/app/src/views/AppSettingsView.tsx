import { type ReactNode } from "react";
import { PageShell } from "@/components/layout/PageShell";
import {
  useAutoArchivePreferences,
} from "@/lib/auto-archive-preferences";
import { setPreferredTheme, usePreferredTheme } from "@/hooks/useTheme";
import { toast } from "sonner";

function SettingsWithControl({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
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

export function AppSettingsView() {
  const [autoArchivePreferences, setAutoArchivePreferences] = useAutoArchivePreferences();
  const autoArchiveThreadOnCommit = autoArchivePreferences.autoArchiveThreadOnCommit;
  const theme = usePreferredTheme();

  const saveAutoArchiveSettings = (checked: boolean) => {
    setAutoArchivePreferences({ autoArchiveThreadOnCommit: checked });
    toast.success("Auto-archive setting saved");
  };

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2">
        <SettingsWithControl
          label="Auto-archive on commit"
          description="Automatically archive local threads after commit and worktree threads after squash merge."
        >
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoArchiveThreadOnCommit}
              onChange={(event) => saveAutoArchiveSettings(event.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span>Enabled</span>
          </label>
        </SettingsWithControl>
        <SettingsWithControl
          label="Theme"
          description="Choose your interface theme."
        >
          <select
            aria-label="Theme"
            value={theme}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "light" || value === "dark") {
                setPreferredTheme(value);
              }
            }}
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none ring-ring focus-visible:ring-2 sm:w-48"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </SettingsWithControl>
      </div>
    </PageShell>
  );
}
