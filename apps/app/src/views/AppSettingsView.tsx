import { type ReactNode, useMemo, useRef, useState } from "react";
import { PageShell } from "@/components/layout/PageShell";
import {
  getOpenPathPreferences,
  setOpenPathPreferences,
} from "@/lib/open-path-preferences";
import {
  getAutoArchivePreferences,
  setAutoArchivePreferences,
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
  const initialPreferences = useMemo(() => getOpenPathPreferences(), []);
  const [fileCommand, setFileCommand] = useState(initialPreferences.fileCommand);
  const [directoryCommand, setDirectoryCommand] = useState(initialPreferences.directoryCommand);
  const [autoArchiveThreadOnCommit, setAutoArchiveThreadOnCommit] = useState(
    () => getAutoArchivePreferences().autoArchiveThreadOnCommit,
  );
  const theme = usePreferredTheme();
  const lastSavedRef = useRef({
    fileCommand: initialPreferences.fileCommand.trim(),
    directoryCommand: initialPreferences.directoryCommand.trim(),
  });

  const saveOpenPathSettings = () => {
    const nextFileCommand = fileCommand.trim();
    const nextDirectoryCommand = directoryCommand.trim();
    const unchanged =
      nextFileCommand === lastSavedRef.current.fileCommand &&
      nextDirectoryCommand === lastSavedRef.current.directoryCommand;
    if (unchanged) return;

    setOpenPathPreferences({
      fileCommand: nextFileCommand,
      directoryCommand: nextDirectoryCommand,
    });
    lastSavedRef.current = {
      fileCommand: nextFileCommand,
      directoryCommand: nextDirectoryCommand,
    };
    toast.success("Open-path settings saved");
  };

  const saveAutoArchiveSettings = (checked: boolean) => {
    setAutoArchiveThreadOnCommit(checked);
    setAutoArchivePreferences({ autoArchiveThreadOnCommit: checked });
    toast.success("Auto-archive setting saved");
  };

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2">
        <SettingsWithControl
          label="Folder open command"
          description='Leave blank for system default. Saves on blur.'
        >
          <input
            id="folder-command"
            value={directoryCommand}
            onChange={(event) => {
              setDirectoryCommand(event.target.value);
            }}
            onBlur={saveOpenPathSettings}
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none ring-ring focus-visible:ring-2"
            placeholder='e.g. "code"'
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="File open command"
          description='Leave blank for system default. Saves on blur.'
        >
          <div className="w-full">
            <input
              id="file-command"
              value={fileCommand}
              onChange={(event) => {
                setFileCommand(event.target.value);
              }}
              onBlur={saveOpenPathSettings}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none ring-ring focus-visible:ring-2"
              placeholder='e.g. "code"'
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Use <code className="rounded bg-muted px-1 py-0.5">{`{path}`}</code> to place the
              file/folder path explicitly.
            </p>
          </div>
        </SettingsWithControl>
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
