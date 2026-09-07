import { useEffect, useId, useState, type FocusEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { appToast } from "@/components/ui/app-toast.js";
import { PluginSettingsSections } from "@/components/plugin/PluginSettingsSections";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { Link } from "react-router-dom";
import { SettingsWithControl } from "@/components/ui/settings-section.js";
import { getPluginDetailRoutePath } from "@/lib/route-paths";
import { Switch } from "@bb/shared-ui/switch";
import {
  ResourceDetailConfigurationSection,
  ResourceDetailOverviewSection,
  ResourceDetailPanel,
  ResourceDetailStack,
} from "@bb/shared-ui/resource-detail";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  applyPluginSettingsView,
  invalidatePluginList,
} from "@/hooks/cache-owners/plugin-cache-owner";
import {
  setPluginEnabled,
  updatePluginSettings,
  usePluginList,
  usePluginSettingsView,
  type PluginListItem,
  type PluginSettingFieldDescriptor,
} from "@/hooks/queries/plugin-settings-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

const DROPDOWN_TRIGGER_CLASS =
  "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs sm:w-44";
const DROPDOWN_CONTENT_CLASS =
  "min-w-[var(--radix-dropdown-menu-trigger-width)]";

const MULTILINE_MIN_ROWS = 6;
const MULTILINE_MAX_ROWS = 24;
const INVALID_NUMBER_DRAFT = Symbol();
const MULTILINE_TEXTAREA_CLASS =
  "max-h-96 min-h-32 w-full resize-y overflow-y-auto font-mono text-xs field-sizing-content";
function multilineRows(value: string): number {
  const lines = value.split("\n").length;
  return Math.min(MULTILINE_MAX_ROWS, Math.max(MULTILINE_MIN_ROWS, lines + 1));
}

function isMultilineSetting(descriptor: PluginSettingFieldDescriptor): boolean {
  return (
    descriptor.type === "string" &&
    descriptor.experimental_multiline === true &&
    descriptor.secret !== true
  );
}

interface SettingOptionPickerProps {
  ariaDescribedBy: string | undefined;
  ariaInvalid: boolean;
  ariaLabel: string;
  onSelect: (value: string) => void;
  options: readonly { label: string; value: string }[];
  valueLabel: string;
}

function SettingOptionPicker({
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel,
  onSelect,
  options,
  valueLabel,
}: SettingOptionPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={DROPDOWN_TRIGGER_CLASS}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
        >
          <span className="min-w-0 truncate">{valueLabel}</span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={DROPDOWN_CONTENT_CLASS}>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onSelect(option.value)}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface PluginSettingFieldProps {
  ariaDescribedBy: string | undefined;
  ariaInvalid: boolean;
  descriptor: PluginSettingFieldDescriptor;
  draft: string | boolean;
  onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onChange: (value: string | boolean) => void;
  storedValue: unknown;
}

function PluginSettingField({
  ariaDescribedBy,
  ariaInvalid,
  descriptor,
  draft,
  onBlur,
  onChange,
  storedValue,
}: PluginSettingFieldProps) {
  const projects = useSidebarNavigation({
    enabled: descriptor.type === "project",
  });

  if (descriptor.type === "boolean") {
    const checked =
      typeof draft === "boolean"
        ? draft
        : typeof storedValue === "boolean"
          ? storedValue
          : false;
    return (
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={descriptor.label}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
      />
    );
  }

  if (descriptor.type === "select") {
    const value =
      typeof draft === "string"
        ? draft
        : typeof storedValue === "string"
          ? storedValue
          : "";
    return (
      <SettingOptionPicker
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={ariaInvalid}
        ariaLabel={descriptor.label}
        valueLabel={value.length > 0 ? value : "Select…"}
        options={descriptor.options.map((option) => ({
          label: option,
          value: option,
        }))}
        onSelect={onChange}
      />
    );
  }

  if (descriptor.type === "project") {
    const value =
      typeof draft === "string"
        ? draft
        : typeof storedValue === "string"
          ? storedValue
          : "";
    const navigation = projects.data;
    const options = navigation
      ? [
          {
            label: navigation.personalProject.name,
            value: navigation.personalProject.id,
          },
          ...navigation.projects.map((project) => ({
            label: project.name,
            value: project.id,
          })),
        ]
      : [];
    const valueLabel =
      options.find((option) => option.value === value)?.label ??
      (value.length > 0 ? value : "Select a project…");
    return (
      <SettingOptionPicker
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={ariaInvalid}
        ariaLabel={descriptor.label}
        valueLabel={valueLabel}
        options={options}
        onSelect={onChange}
      />
    );
  }

  if (descriptor.type === "number") {
    const value =
      typeof draft === "string"
        ? draft
        : typeof storedValue === "number"
          ? String(storedValue)
          : "";
    return (
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        aria-label={descriptor.label}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className="h-7 w-full text-xs sm:w-64"
      />
    );
  }

  const isSecret = descriptor.secret === true;
  const secretIsSet =
    isSecret &&
    typeof storedValue === "object" &&
    storedValue !== null &&
    "set" in storedValue &&
    storedValue.set === true;
  const value =
    typeof draft === "string"
      ? draft
      : !isSecret && typeof storedValue === "string"
        ? storedValue
        : "";
  if (isMultilineSetting(descriptor)) {
    return (
      <Textarea
        value={value}
        aria-label={descriptor.label}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        rows={multilineRows(value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={MULTILINE_TEXTAREA_CLASS}
      />
    );
  }
  return (
    <Input
      type={isSecret ? "password" : "text"}
      value={value}
      aria-label={descriptor.label}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      placeholder={isSecret ? (secretIsSet ? "[set]" : "[not set]") : undefined}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      className="h-7 w-full text-xs sm:w-64"
    />
  );
}

function initialSettingDraft(
  descriptor: PluginSettingFieldDescriptor,
  storedValue: unknown,
): string | boolean {
  if (descriptor.type === "boolean") {
    return typeof storedValue === "boolean" ? storedValue : false;
  }
  if (descriptor.type === "number") {
    return typeof storedValue === "number" ? String(storedValue) : "";
  }
  if (descriptor.type === "string" && descriptor.secret === true) return "";
  return typeof storedValue === "string" ? storedValue : "";
}

interface AutosavingPluginSettingProps {
  descriptor: PluginSettingFieldDescriptor;
  pluginId: string;
  settingKey: string;
  storedValue: unknown;
}

function AutosavingPluginSetting({
  descriptor,
  pluginId,
  settingKey,
  storedValue,
}: AutosavingPluginSettingProps) {
  const queryClient = useQueryClient();
  const messageId = useId();
  const initialDraft = initialSettingDraft(descriptor, storedValue);
  const [draftState, setDraftState] = useState({
    value: initialDraft,
    hasNewerDraft: false,
  });
  const draft = draftState.value;
  const save = useMutation({
    scope: { id: `plugin-setting:${pluginId}:${settingKey}` },
    mutationFn: (value: string | boolean | typeof INVALID_NUMBER_DRAFT) => {
      if (value === INVALID_NUMBER_DRAFT)
        throw new Error("Enter a finite number");
      let settingValue: string | number | boolean | null = value;
      if (descriptor.type === "number") {
        const trimmed = typeof value === "string" ? value.trim() : "";
        const parsed = Number(trimmed);
        if (trimmed.length > 0 && !Number.isFinite(parsed)) {
          throw new Error("Enter a finite number");
        }
        settingValue = trimmed.length === 0 ? null : parsed;
      }
      return updatePluginSettings(fetch, pluginId, {
        [settingKey]: settingValue,
      });
    },
    onSuccess: (view) => {
      applyPluginSettingsView({ queryClient, pluginId, view });
    },
  });

  useEffect(() => {
    if (!draftState.hasNewerDraft && !save.isPending && !save.isError) {
      setDraftState({ value: initialDraft, hasNewerDraft: false });
    }
  }, [draftState.hasNewerDraft, initialDraft, save.isError, save.isPending]);

  function changeDraft(value: string | boolean): void {
    setDraftState({
      value,
      hasNewerDraft:
        descriptor.type === "string" || descriptor.type === "number",
    });
    if (!save.isPending) save.reset();
    if (descriptor.type !== "string" && descriptor.type !== "number") {
      save.mutate(value);
    }
  }

  function saveDraft(
    event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    if (descriptor.type !== "string" && descriptor.type !== "number") return;
    if (descriptor.type === "number" && event.currentTarget.validity.badInput) {
      setDraftState({ value: initialDraft, hasNewerDraft: false });
      save.mutate(INVALID_NUMBER_DRAFT);
      return;
    }
    if (descriptor.type === "number") {
      const trimmed = typeof draft === "string" ? draft.trim() : "";
      const parsed = Number(trimmed);
      if (
        (trimmed.length === 0 && storedValue === undefined) ||
        (trimmed.length > 0 && parsed === storedValue && !save.isPending)
      ) {
        setDraftState({ value: draft, hasNewerDraft: false });
        return;
      }
    }
    if (
      (draft === storedValue && !save.isPending) ||
      (descriptor.type === "string" &&
        descriptor.secret === true &&
        draft === "")
    ) {
      setDraftState({ value: draft, hasNewerDraft: false });
      return;
    }
    setDraftState({ value: draft, hasNewerDraft: false });
    save.mutate(draft);
  }

  const saveError = save.isError
    ? getMutationErrorMessage({
        error: save.error,
        fallbackMessage: "Could not save this setting",
      })
    : null;
  return (
    <SettingsWithControl
      label={descriptor.label}
      labelBadge={
        descriptor.type === "string" && descriptor.secret === true
          ? "secret"
          : undefined
      }
      controlPlacement={isMultilineSetting(descriptor) ? "below" : "inline"}
      {...(descriptor.description !== undefined
        ? { description: descriptor.description }
        : {})}
    >
      <div className="space-y-1">
        <PluginSettingField
          ariaDescribedBy={saveError !== null ? messageId : undefined}
          ariaInvalid={saveError !== null}
          descriptor={descriptor}
          storedValue={storedValue}
          draft={draft}
          onBlur={saveDraft}
          onChange={changeDraft}
        />
        {saveError !== null ? (
          <p id={messageId} className="text-xs text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}
      </div>
    </SettingsWithControl>
  );
}

export function PluginSettingsForm({ pluginId }: { pluginId: string }) {
  const viewQuery = usePluginSettingsView(pluginId, { enabled: true });
  const view = viewQuery.data ?? null;
  if (view === null || Object.keys(view.schema).length === 0) return null;

  return (
    <div className="space-y-4">
      {Object.entries(view.schema).map(([key, descriptor]) => (
        <AutosavingPluginSetting
          key={key}
          descriptor={descriptor}
          pluginId={pluginId}
          settingKey={key}
          storedValue={view.values[key]}
        />
      ))}
    </div>
  );
}

const PLUGIN_STATUSES_WITH_SETTINGS = [
  "running",
  "needs-configuration",
  "degraded",
];

export function PluginSettingsPage({ pluginId }: { pluginId: string }) {
  const listQuery = usePluginList({ enabled: true });
  const plugin =
    listQuery.data?.plugins.find(
      (entry: PluginListItem) => entry.id === pluginId,
    ) ?? null;
  if (listQuery.isFetching && listQuery.data === undefined) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading plugin settings…
      </p>
    );
  }
  if (plugin === null) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        This plugin is not installed.
      </p>
    );
  }
  return <PluginSettingsContent key={plugin.id} plugin={plugin} />;
}

function PluginSettingsContent({ plugin }: { plugin: PluginListItem }) {
  const queryClient = useQueryClient();
  const { settingsSections } = usePluginSlots();
  const toggle = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (enabled: boolean) =>
      setPluginEnabled(fetch, plugin.id, enabled),
    onError: (error, enabled) => {
      appToast.error(
        `${enabled ? "Enabling" : "Disabling"} ${plugin.id} failed`,
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    },
    onSettled: () => invalidatePluginList({ queryClient }),
  });
  const enabled = toggle.isPending ? toggle.variables : plugin.enabled;
  const hasAvailableSettings =
    plugin.hasSettings ||
    settingsSections.some((section) => section.pluginId === plugin.id);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-9 shrink-0">
            <PluginIcon
              pluginId={plugin.id}
              icon={plugin.icon}
              className="size-full"
            />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-foreground">
              {plugin.name ?? plugin.id}
            </h1>
            {plugin.description ? (
              <p className="truncate text-xs text-subtle-foreground">
                {plugin.description}
              </p>
            ) : null}
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={toggle.isPending}
          onCheckedChange={(next) => toggle.mutate(next)}
          aria-label={`${enabled ? "Disable" : "Enable"} ${plugin.id}`}
        />
      </header>
      <ResourceDetailStack className="mt-6">
        {enabled && plugin.enabled && hasAvailableSettings ? (
          <ResourceDetailConfigurationSection label="Configuration">
            <PluginSettingsDetail plugin={plugin} />
          </ResourceDetailConfigurationSection>
        ) : null}
        <ResourceDetailOverviewSection label="Plugin details">
          <p className="max-w-none text-sm leading-relaxed text-muted-foreground">
            Release, capabilities, and health live on{" "}
            <Link
              to={getPluginDetailRoutePath({
                pluginId: plugin.id,
                view: "installed",
              })}
              className="inline-flex items-center gap-0.5 rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              its plugin page
              <Icon
                name="ChevronRight"
                className="size-3.5 no-underline"
                aria-hidden
              />
            </Link>
          </p>
        </ResourceDetailOverviewSection>
      </ResourceDetailStack>
    </div>
  );
}

export function PluginSettingsDetail({ plugin }: { plugin: PluginListItem }) {
  const { settingsSections } = usePluginSlots();
  const hasSettingsSections = settingsSections.some(
    (section) => section.pluginId === plugin.id,
  );
  const settingsAvailable =
    plugin.enabled && PLUGIN_STATUSES_WITH_SETTINGS.includes(plugin.status);
  if (!plugin.hasSettings && !hasSettingsSections) return null;

  return (
    <div className="space-y-6" data-testid={`plugin-detail-${plugin.id}`}>
      {plugin.hasSettings || !settingsAvailable ? (
        <ResourceDetailPanel surface="recessed" className="px-3 py-3">
          {settingsAvailable ? (
            <PluginSettingsForm key={plugin.id} pluginId={plugin.id} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {plugin.enabled
                ? `Settings are unavailable while the plugin is ${plugin.status}.`
                : "Enable this plugin to edit its settings."}
            </p>
          )}
        </ResourceDetailPanel>
      ) : null}
      {settingsAvailable ? (
        <PluginSettingsSections pluginId={plugin.id} />
      ) : null}
    </div>
  );
}
