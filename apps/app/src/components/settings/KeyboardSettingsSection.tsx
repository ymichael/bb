import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  defaultAppSettings,
  type AppCommandId,
  type AppDefaultKeybindings,
  type AppKeybindingOverrides,
  type AppShortcut,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Switch } from "@bb/shared-ui/switch";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  APP_COMMAND_GROUPS,
  getAppCommandMetadata,
} from "@/lib/app-command-metadata";
import {
  areAppShortcutsEqual,
  appShortcutFromInput,
  canAssignAppShortcut,
  getCommandShortcut,
  getShortcutConflicts,
  isAppCommandAvailableForClient,
  resetCommandShortcutOverride,
  setCommandShortcutOverride,
} from "@/lib/keyboard-shortcut-settings";
import {
  formatAppShortcut,
  formatAppShortcutAria,
  type AppShortcutPresentation,
} from "@/lib/app-keybindings";
import {
  useUpdateGeneralSettings,
  useUpdateKeyboardSettings,
} from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  SettingsBadge,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import { AppCommandShortcutPill } from "@/components/commands/AppCommandShortcutHint";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

const EMPTY_KEYBINDINGS: AppDefaultKeybindings = [];
const EMPTY_OVERRIDES: AppKeybindingOverrides = [];
const SETTINGS_SHORTCUT_PILL_CLASS =
  "rounded-none bg-transparent px-0 py-0 text-foreground opacity-100";
const SETTINGS_DEFAULT_SHORTCUT_CLASS =
  "bg-muted/40 px-1.5 py-0.5 text-foreground opacity-100";
const SETTINGS_SEGMENTED_DEFAULT_SHORTCUT_CLASS =
  "rounded-none border-l border-border bg-transparent px-1.5 py-0.5 text-foreground opacity-100";

function browserPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function presentShortcut(
  shortcut: AppShortcut,
  platform: string,
): AppShortcutPresentation {
  return {
    ariaKeyshortcuts: formatAppShortcutAria(shortcut, platform),
    label: formatAppShortcut(shortcut, platform),
  };
}

function areNullableAppShortcutsEqual(
  left: AppShortcut | null,
  right: AppShortcut | null,
): boolean {
  return (
    left === right ||
    (left !== null && right !== null && areAppShortcutsEqual(left, right))
  );
}

interface ShortcutRecorderProps {
  command: AppCommandId;
  disabled: boolean;
  onChange(command: AppCommandId, shortcut: AppShortcut): void;
  onRecordingChange(command: AppCommandId | null): void;
  recording: boolean;
  shortcut: AppShortcut | null;
}

const ShortcutRecorder = memo(
  function ShortcutRecorder({
    command,
    disabled,
    onChange,
    onRecordingChange,
    recording,
    shortcut,
  }: ShortcutRecorderProps) {
    const platform = browserPlatform();
    const [error, setError] = useState<string | null>(null);
    const shortcutPresentation =
      shortcut === null ? null : presentShortcut(shortcut, platform);
    const formattedShortcut = shortcutPresentation?.label ?? "unassigned";

    function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (!recording) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setError(null);
        onRecordingChange(null);
        return;
      }
      const next = appShortcutFromInput(event, platform);
      if (next === null) {
        setError("Press a non-modifier key.");
        return;
      }
      if (!canAssignAppShortcut(command, next)) {
        setError("Use Command, Control, or Alt with a key.");
        return;
      }
      setError(null);
      onChange(command, next);
      onRecordingChange(null);
    }

    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          aria-label={
            recording
              ? `Recording shortcut for ${getAppCommandMetadata(command).label}. Press keys or Escape to cancel.`
              : `Record shortcut for ${getAppCommandMetadata(command).label}, current shortcut ${formattedShortcut}`
          }
          aria-pressed={recording}
          className={cn(
            "h-7 min-w-24 px-2 text-xs",
            recording && "border-ring text-foreground",
          )}
          disabled={disabled}
          onBlur={() => {
            setError(null);
            onRecordingChange(null);
          }}
          onClick={() => {
            if (recording) return;
            setError(null);
            onRecordingChange(command);
          }}
          onKeyDown={handleKeyDown}
          size="sm"
          type="button"
          variant="outline"
        >
          {recording ? (
            "Press keys"
          ) : shortcutPresentation === null ? (
            "Unassigned"
          ) : (
            <AppCommandShortcutPill
              className={SETTINGS_SHORTCUT_PILL_CLASS}
              shortcut={shortcutPresentation}
            />
          )}
        </Button>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
  function areShortcutRecorderPropsEqual(left, right) {
    return (
      left.command === right.command &&
      left.disabled === right.disabled &&
      left.onChange === right.onChange &&
      left.onRecordingChange === right.onRecordingChange &&
      left.recording === right.recording &&
      areNullableAppShortcutsEqual(left.shortcut, right.shortcut)
    );
  },
);

interface KeyboardCommandRowProps {
  model: KeyboardCommandRowModel;
  onChange(command: AppCommandId, shortcut: AppShortcut | null): void;
  onReset(command: AppCommandId): void;
  onRecordingChange(command: AppCommandId | null): void;
  pending: boolean;
  platform: string;
  recording: boolean;
}

interface KeyboardCommandRowModel {
  availableOnClient: boolean;
  command: AppCommandId;
  conflicts: readonly AppCommandId[];
  customized: boolean;
  desktopDefaultShortcut: AppShortcut | null;
  desktopOnly: boolean;
  shortcut: AppShortcut | null;
  webDefaultShortcut: AppShortcut | null;
}

interface BuildKeyboardCommandRowModelArgs {
  command: AppCommandId;
  defaults: AppDefaultKeybindings;
  isDesktop: boolean;
  overrides: AppKeybindingOverrides;
  platform: string;
}

function buildKeyboardCommandRowModel({
  command,
  defaults,
  isDesktop,
  overrides,
  platform,
}: BuildKeyboardCommandRowModelArgs): KeyboardCommandRowModel {
  const shortcut = getCommandShortcut(
    defaults,
    overrides,
    command,
    isDesktop,
    platform,
  );
  const customized = overrides.some((override) => override.command === command);
  const commandBindings = defaults.filter(
    (binding) => binding.command === command,
  );
  const webDefaultShortcut = getCommandShortcut(
    defaults,
    [],
    command,
    false,
    platform,
  );
  const desktopDefaultShortcut = getCommandShortcut(
    defaults,
    [],
    command,
    true,
    platform,
  );
  const availableOnClient = isAppCommandAvailableForClient(
    defaults,
    command,
    isDesktop,
    platform,
  );
  const desktopOnly =
    commandBindings.length > 0 &&
    commandBindings.every((binding) => binding.desktopOnly);
  const conflicts = customized
    ? getShortcutConflicts(defaults, overrides, command, isDesktop, platform)
    : [];

  return {
    availableOnClient,
    command,
    conflicts,
    customized,
    desktopDefaultShortcut,
    desktopOnly,
    shortcut,
    webDefaultShortcut,
  };
}

function areCommandListsEqual(
  left: readonly AppCommandId[],
  right: readonly AppCommandId[],
): boolean {
  return (
    left.length === right.length &&
    left.every((command, index) => command === right[index])
  );
}

function areKeyboardCommandRowModelsEqual(
  left: KeyboardCommandRowModel,
  right: KeyboardCommandRowModel,
): boolean {
  return (
    left.command === right.command &&
    left.availableOnClient === right.availableOnClient &&
    left.customized === right.customized &&
    left.desktopOnly === right.desktopOnly &&
    areNullableAppShortcutsEqual(left.shortcut, right.shortcut) &&
    areNullableAppShortcutsEqual(
      left.webDefaultShortcut,
      right.webDefaultShortcut,
    ) &&
    areNullableAppShortcutsEqual(
      left.desktopDefaultShortcut,
      right.desktopDefaultShortcut,
    ) &&
    areCommandListsEqual(left.conflicts, right.conflicts)
  );
}

const KeyboardCommandRow = memo(
  function KeyboardCommandRow({
    model,
    onChange,
    onReset,
    onRecordingChange,
    pending,
    platform,
    recording,
  }: KeyboardCommandRowProps) {
    const {
      availableOnClient,
      command,
      conflicts,
      customized,
      desktopDefaultShortcut,
      desktopOnly,
      shortcut,
      webDefaultShortcut,
    } = model;
    const metadata = getAppCommandMetadata(command);
    const splitDefaults =
      webDefaultShortcut !== null &&
      desktopDefaultShortcut !== null &&
      !areAppShortcutsEqual(webDefaultShortcut, desktopDefaultShortcut)
        ? [
            { label: "Web", shortcut: webDefaultShortcut },
            { label: "Desktop", shortcut: desktopDefaultShortcut },
          ]
        : null;
    const sharedDefaultShortcut =
      splitDefaults === null
        ? (webDefaultShortcut ?? desktopDefaultShortcut)
        : null;

    return (
      <div
        aria-busy={pending || undefined}
        className={cn(
          "flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-5",
          pending && "opacity-50",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm text-foreground">{metadata.label}</p>
            {desktopOnly ? <SettingsBadge>Desktop</SettingsBadge> : null}
            {customized ? <SettingsBadge>Custom</SettingsBadge> : null}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {metadata.description}
          </p>
          {splitDefaults !== null || sharedDefaultShortcut !== null ? (
            <div
              aria-label={`${splitDefaults === null ? "Default shortcut" : "Default shortcuts"} for ${metadata.label}`}
              className="mt-1.5 flex flex-wrap items-center gap-1.5"
            >
              <span className="text-xs text-subtle-foreground/75">
                {splitDefaults === null ? "Default:" : "Defaults:"}
              </span>
              {sharedDefaultShortcut !== null ? (
                <AppCommandShortcutPill
                  ariaHidden={false}
                  className={SETTINGS_DEFAULT_SHORTCUT_CLASS}
                  shortcut={presentShortcut(sharedDefaultShortcut, platform)}
                />
              ) : (
                splitDefaults?.map((entry) => (
                  <span
                    className="inline-flex items-stretch overflow-hidden rounded border border-border text-foreground"
                    key={entry.label}
                  >
                    <span className="inline-flex items-center bg-muted/40 px-1.5 text-2xs leading-none text-subtle-foreground">
                      {entry.label}
                    </span>
                    <AppCommandShortcutPill
                      ariaHidden={false}
                      className={SETTINGS_SEGMENTED_DEFAULT_SHORTCUT_CLASS}
                      shortcut={presentShortcut(entry.shortcut, platform)}
                    />
                  </span>
                ))
              )}
            </div>
          ) : null}
          {conflicts.length > 0 ? (
            <p className="mt-1 text-xs text-warning-text">
              Also used by{" "}
              {conflicts
                .map((candidate) => getAppCommandMetadata(candidate).label)
                .join(", ")}
              . Context determines which command runs.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-start justify-end gap-1">
          <ShortcutRecorder
            command={command}
            disabled={!availableOnClient}
            onChange={onChange}
            onRecordingChange={onRecordingChange}
            recording={recording}
            shortcut={shortcut}
          />
          <Button
            aria-label={`Clear shortcut for ${metadata.label}`}
            className="size-7"
            disabled={!availableOnClient || shortcut === null}
            onClick={() => onChange(command, null)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Icon name="X" className="size-3.5" />
          </Button>
          <Button
            aria-label={`Reset shortcut for ${metadata.label}`}
            className="size-7"
            disabled={!availableOnClient || !customized}
            onClick={() => onReset(command)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Icon name="RotateCcw" className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  },
  function areKeyboardCommandRowPropsEqual(left, right) {
    return (
      left.onChange === right.onChange &&
      left.onReset === right.onReset &&
      left.onRecordingChange === right.onRecordingChange &&
      left.pending === right.pending &&
      left.platform === right.platform &&
      left.recording === right.recording &&
      areKeyboardCommandRowModelsEqual(left.model, right.model)
    );
  },
);

export function KeyboardSettingsSection() {
  const systemConfig = useSystemConfig();
  const updateGeneralSettings = useUpdateGeneralSettings();
  const {
    isPending: isKeyboardSettingsPending,
    mutate: mutateKeyboardSettings,
  } = useUpdateKeyboardSettings();
  const isDesktop = getBbDesktopInfo() !== null;
  const platform = browserPlatform();
  const generalSettings =
    systemConfig.data?.generalSettings ?? defaultAppSettings;
  const defaults = systemConfig.data?.defaultKeybindings ?? EMPTY_KEYBINDINGS;
  const serverOverrides =
    systemConfig.data?.keybindingOverrides ?? EMPTY_OVERRIDES;
  const serverOverridesKey = JSON.stringify(serverOverrides);
  const [draft, setDraft] = useState<{
    sourceKey: string;
    value: AppKeybindingOverrides;
  }>(() => ({ sourceKey: serverOverridesKey, value: serverOverrides }));
  const overrides =
    draft.sourceKey === serverOverridesKey ? draft.value : serverOverrides;
  const [recordingCommand, setRecordingCommand] = useState<AppCommandId | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const pendingCommandRef = useRef<AppCommandId | null>(null);

  const commandRowModels = useMemo(
    () =>
      new Map(
        APP_COMMAND_GROUPS.flatMap((group) =>
          group.commands.map(
            ({ command }) =>
              [
                command,
                buildKeyboardCommandRowModel({
                  command,
                  defaults,
                  isDesktop,
                  overrides,
                  platform,
                }),
              ] as const,
          ),
        ),
      ),
    [defaults, isDesktop, overrides, platform],
  );

  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return APP_COMMAND_GROUPS;
    return APP_COMMAND_GROUPS.flatMap((group) => {
      const commands = group.commands.filter(
        (metadata) =>
          metadata.label.toLowerCase().includes(query) ||
          metadata.description.toLowerCase().includes(query) ||
          metadata.command.toLowerCase().includes(query),
      );
      return commands.length === 0 ? [] : [{ ...group, commands }];
    });
  }, [search]);

  const latestSettingsRef = useRef({
    defaults,
    isDesktop,
    overrides,
    platform,
    serverOverridesKey,
  });
  useLayoutEffect(() => {
    latestSettingsRef.current = {
      defaults,
      isDesktop,
      overrides,
      platform,
      serverOverridesKey,
    };
  }, [defaults, isDesktop, overrides, platform, serverOverridesKey]);

  const updateCommand = useCallback(
    (command: AppCommandId, shortcut: AppShortcut | null) => {
      const current = latestSettingsRef.current;
      const previous = current.overrides;
      const next = setCommandShortcutOverride(
        current.defaults,
        current.overrides,
        command,
        shortcut,
        current.isDesktop,
        current.platform,
      );
      pendingCommandRef.current = command;
      setDraft({ sourceKey: current.serverOverridesKey, value: next });
      mutateKeyboardSettings(next, {
        onError: () =>
          setDraft({
            sourceKey: current.serverOverridesKey,
            value: previous,
          }),
      });
    },
    [mutateKeyboardSettings],
  );

  const resetCommand = useCallback(
    (command: AppCommandId) => {
      const current = latestSettingsRef.current;
      const previous = current.overrides;
      const next = resetCommandShortcutOverride(current.overrides, command);
      pendingCommandRef.current = command;
      setDraft({ sourceKey: current.serverOverridesKey, value: next });
      mutateKeyboardSettings(next, {
        onError: () =>
          setDraft({
            sourceKey: current.serverOverridesKey,
            value: previous,
          }),
      });
    },
    [mutateKeyboardSettings],
  );

  const pendingCommand = isKeyboardSettingsPending
    ? pendingCommandRef.current
    : null;
  const disabled = systemConfig.data === undefined || isKeyboardSettingsPending;
  const hasOverrides = overrides.length > 0;

  return (
    <SettingsSection
      action={
        <Button
          disabled={disabled || !hasOverrides}
          onClick={() => {
            const previous = overrides;
            pendingCommandRef.current = null;
            setDraft({ sourceKey: serverOverridesKey, value: [] });
            mutateKeyboardSettings([], {
              onError: () =>
                setDraft({ sourceKey: serverOverridesKey, value: previous }),
            });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Reset all
        </Button>
      }
      description="Click a shortcut, then press its new keys. Changes sync to every bb window."
      title="Keyboard shortcuts"
    >
      <div className="space-y-5">
        <SettingsWithControl
          description="Show shortcut badges after holding Command or Control."
          label="Show keyboard hints when holding CMD / Control"
        >
          <Switch
            aria-label="Show keyboard hints when holding CMD / Control"
            checked={generalSettings.showKeyboardHints}
            disabled={
              systemConfig.data === undefined || updateGeneralSettings.isPending
            }
            onCheckedChange={(showKeyboardHints) =>
              updateGeneralSettings.mutate({
                ...generalSettings,
                showKeyboardHints,
              })
            }
          />
        </SettingsWithControl>
        <Input
          aria-label="Search keyboard shortcuts"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search shortcuts"
          value={search}
        />
        {}
        <fieldset
          className={cn(
            "m-0 min-w-0 space-y-5 border-0 p-0",
            isKeyboardSettingsPending &&
              "[&:disabled_button:not([disabled])]:opacity-100",
          )}
          disabled={disabled}
        >
          {visibleGroups.map((group) => (
            <section key={group.label}>
              <h3 className="mb-2 text-xs font-medium text-subtle-foreground">
                {group.label}
              </h3>
              <div className="divide-y divide-border">
                {group.commands.map((metadata) => {
                  const model = commandRowModels.get(metadata.command);
                  if (model === undefined) return null;
                  return (
                    <KeyboardCommandRow
                      key={metadata.command}
                      model={model}
                      onChange={updateCommand}
                      onReset={resetCommand}
                      onRecordingChange={setRecordingCommand}
                      pending={pendingCommand === metadata.command}
                      platform={platform}
                      recording={recordingCommand === metadata.command}
                    />
                  );
                })}
              </div>
            </section>
          ))}
          {visibleGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-subtle-foreground">
              No shortcuts match “{search}”.
            </p>
          ) : null}
        </fieldset>
      </div>
    </SettingsSection>
  );
}
