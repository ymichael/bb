import { useMemo, useState, type ReactNode } from "react";
import {
  Navigate,
  useNavigate,
  useLocation,
  matchPath,
} from "react-router-dom";
import "@bb/shared-ui/icon-extended";
import {
  builtInThemes,
  defaultAppSettings,
  defaultAppTheme,
  defaultExperiments,
  managedBranchPrefixSchema,
  type AppTheme,
  type FaviconColorPreference,
  type PluginThemeMeta,
} from "@bb/domain";
import type {
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Switch } from "@bb/shared-ui/switch";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import { WorkspaceOpenTargetIcon } from "@/components/workspace-open-target/WorkspaceOpenTargetIcon";
import {
  setPreferredTheme,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/useTheme";
import { useHostDaemon, useLocalHostDaemonAccess } from "@/hooks/useHostDaemon";
import { UsageLimitsSettingsSection } from "@/components/settings/UsageLimitsSettingsSection";
import { ProvidersSettingsSection } from "@/components/settings/ProvidersSettingsSection";
import { CodeRendererSettings } from "@/components/settings/CodeRendererSettings";
import { SidebarThreadListSetting } from "@/components/settings/SidebarThreadListSetting";
import { SidebarNavigationSetting } from "@/components/settings/SidebarNavigationSetting";
import { SplitDimmingSetting } from "@/components/settings/SplitDimmingSetting";
import { useSettingsNavState } from "@/components/settings/settings-nav";
import { PluginsOverview } from "@/components/plugin/PluginsOverview";
import { PluginDetailPaneView } from "@/views/ToolsView";
import { SETTINGS_PLUGIN_ROUTE_PATH } from "@/lib/route-paths";
import { PluginSettingsPage } from "@/components/plugin/PluginSettings";
import { FileOpenersSettingsSection } from "@/components/settings/FileOpenersSettingsSection";
import { VoiceInputSettingsSection } from "@/components/settings/VoiceInputSettingsSection";
import { CommunitySettingsSection } from "@/components/settings/CommunitySettingsSection";
import { UpdatesSettingsSection } from "@/components/settings/UpdatesSettingsSection";
import { KeyboardSettingsSection } from "@/components/settings/KeyboardSettingsSection";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { ArchivedThreadsSettingsSection } from "@/components/settings/ArchivedThreadsSettingsSection";
import { CliSkillsSettingsSection } from "@/components/settings/CliSkillsSettingsSection";
import { MarketplacesSettingsSection } from "@/components/settings/MarketplacesSettingsSection";
import {
  useUpdateGeneralSettings,
  useUpdateAppearance,
  useUpdateExperiments,
} from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useWorkspaceOpenTargets } from "@/hooks/useWorkspaceOpenTargets";
import { isDesktopBrowserAvailable } from "@/lib/bb-desktop";
import {
  FAVICON_COLOR_VALUES,
  getFaviconGlyphHref,
} from "@/lib/favicon-color-preference";
import { useOpenLinksInAppBrowserPreference } from "@/lib/in-app-browser-link-preference";
import { useRewriteLocalhostLinksPreference } from "@/lib/localhost-link-rewrite-preference";
import { useRichTextEditingPreference } from "@/lib/rich-text-editing-preference";
import {
  SETTINGS_ROUTE_PATH,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  resolvePreferredWorkspaceOpenTarget,
  supportsWorkspaceOpenTargetCapability,
  useFileOpenTargetPreference,
  useWorkspaceOpenTargetPreference,
  type StoredWorkspaceOpenTargetPreference,
  type WorkspaceOpenTargetCapability,
} from "@/lib/workspace-open-target-preference";
import { getWorkspaceOpenTargetFallbackLabel } from "@/components/workspace-open-target/workspace-open-target-display";
import type { LocalHostDaemonAccessState } from "@/lib/local-host-daemon-access";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const LOCAL_EDITOR_INTEGRATION_DOCS_URL =
  "https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md#open-bb-from-another-browser";

interface ThemePreferenceOption {
  label: string;
  value: ThemePreference;
}

interface FaviconColorOption {
  label: string;
  value: FaviconColorPreference;
}

interface LocalOpenTargetPreferenceDefinition {
  capability: WorkspaceOpenTargetCapability;
  emptyDescription: string;
  label: string;
}

interface LocalOpenTargetPreferenceControlProps {
  definition: LocalOpenTargetPreferenceDefinition;
  onTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  preferredTargetId: StoredWorkspaceOpenTargetPreference;
  targets: WorkspaceOpenTarget[];
}

export interface LocalOpenTargetSettingsSectionProps {
  accessState: LocalHostDaemonAccessState;
  directoryTargetId: StoredWorkspaceOpenTargetPreference;
  fileTargetId: StoredWorkspaceOpenTargetPreference;
  hasDaemon: boolean;
  onDirectoryTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  onFileTargetChange: (targetId: WorkspaceOpenTargetId) => void;
  onRequestAccess: () => Promise<boolean>;
  targets: WorkspaceOpenTarget[];
}

interface FaviconColorSettingsControlProps {
  disabled: boolean;
  faviconColor: FaviconColorPreference;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
}

interface AppearanceSettingsSectionProps {
  appearance: AppTheme;
  appearanceDisabled: boolean;
  customThemes: readonly string[];
  pluginThemes: readonly PluginThemeMeta[];
  faviconColor: FaviconColorPreference;
  onAppearanceThemeChange: (themeId: string) => void;
  onCreatePalette: () => void;
  onFaviconColorChange: (faviconColor: FaviconColorPreference) => void;
  onThemePreferenceChange: (themePreference: ThemePreference) => void;
  themePreference: ThemePreference;
}

interface GeneralSettingsSectionProps {
  desktopBrowserAvailable: boolean;
  managedBranchPrefix: string;
  managedBranchPrefixDisabled: boolean;
  navigateToThreadAfterCreate: boolean;
  onManagedBranchPrefixChange: (prefix: string) => Promise<void> | void;
  onNavigateToThreadAfterCreateChange: (enabled: boolean) => void;
  onOpenLinksInAppBrowserChange: (enabled: boolean) => void;
  onRewriteLocalhostLinksChange: (enabled: boolean) => void;
  onRichTextEditingChange: (enabled: boolean) => void;
  onSteerActiveThreadOnEnterChange: (enabled: boolean) => void;
  onStreamerModeChange: (enabled: boolean) => void;
  openLinksInAppBrowser: boolean;
  rewriteLocalhostLinks: boolean;
  richTextEditing: boolean;
  steerActiveThreadOnEnter: boolean;
  steerActiveThreadOnEnterDisabled: boolean;
  streamerMode: boolean;
  streamerModeDisabled: boolean;
}

interface DebugSettingsSectionProps {
  disabled: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

function appPaletteLabel(
  appearance: AppTheme,
  pluginThemes: readonly PluginThemeMeta[],
): string {
  const meta = builtInThemes.find((entry) => entry.id === appearance.themeId);
  return (
    meta?.name ??
    pluginThemes.find((entry) => entry.id === appearance.themeId)?.name ??
    appearance.themeId
  );
}

interface ExperimentsSettingsSectionProps {
  disabled: boolean;
  changelogPreviewEnabled: boolean;
  editMessagesEnabled: boolean;
  mobileAppEnabled: boolean;
  sidebarProgressiveDisclosureEnabled: boolean;
  timelineWindowingEnabled: boolean;
  onChangelogPreviewEnabledChange: (enabled: boolean) => void;
  onEditMessagesEnabledChange: (enabled: boolean) => void;
  onMobileAppEnabledChange: (enabled: boolean) => void;
  onSidebarProgressiveDisclosureEnabledChange: (enabled: boolean) => void;
  onTimelineWindowingEnabledChange: (enabled: boolean) => void;
}

const THEME_PREFERENCE_OPTIONS: ReadonlyArray<ThemePreferenceOption> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

const FAVICON_COLOR_OPTIONS: ReadonlyArray<FaviconColorOption> = [
  { label: "Default", value: "default" },
  { label: "Red", value: "red" },
  { label: "Orange", value: "orange" },
  { label: "Yellow", value: "yellow" },
  { label: "Green", value: "green" },
  { label: "Teal", value: "teal" },
  { label: "Blue", value: "blue" },
  { label: "Purple", value: "purple" },
  { label: "Pink", value: "pink" },
];

const FAVICON_COLOR_LABELS: Record<FaviconColorPreference, string> = {
  blue: "Blue",
  default: "Default",
  green: "Green",
  orange: "Orange",
  pink: "Pink",
  purple: "Purple",
  red: "Red",
  teal: "Teal",
  yellow: "Yellow",
};

const SETTINGS_DROPDOWN_TRIGGER_CLASS =
  "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs sm:w-36";
const SETTINGS_DROPDOWN_CONTENT_CLASS =
  "min-w-[var(--radix-dropdown-menu-trigger-width)]";

const CREATE_CUSTOM_PALETTE_PROMPT =
  "Create a custom bb palette. First run `bb theme dir` to find the custom theme directory. Ask me for the palette name and visual direction, then create `<theme-dir>/<name>/theme.css` with light and dark theme variables compatible with bb's theme tokens.";
const PALETTE_SETTING_DESCRIPTION =
  "Palettes change bb's colors, including syntax colors in diffs and file previews. Choose a built-in palette or create one from a prompt.";

function FaviconColorPreview({ value }: { value: FaviconColorPreference }) {
  return (
    <span
      aria-hidden
      className={cn("size-4 shrink-0", value === "default" && "bg-foreground")}
      style={{
        mask: `url("${getFaviconGlyphHref()}") center / contain no-repeat`,
        ...(value === "default"
          ? undefined
          : { backgroundColor: FAVICON_COLOR_VALUES[value] }),
      }}
    />
  );
}

function FaviconColorSettingsControl({
  disabled,
  faviconColor,
  onFaviconColorChange,
}: FaviconColorSettingsControlProps) {
  return (
    <SettingsWithControl
      label="Favicon color"
      description="Tint browser tabs to tell instances apart."
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label="Favicon color"
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FaviconColorPreview value={faviconColor} />
              <span className="min-w-0 truncate">
                {FAVICON_COLOR_LABELS[faviconColor]}
              </span>
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {FAVICON_COLOR_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onFaviconColorChange(option.value)}
            >
              <FaviconColorPreview value={option.value} />
              {option.label}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  faviconColor !== option.value && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

const DIRECTORY_TARGET_PREFERENCE: LocalOpenTargetPreferenceDefinition = {
  capability: "openDirectory",
  emptyDescription: "No local app can open directories.",
  label: "Directory default",
};

const FILE_TARGET_PREFERENCE: LocalOpenTargetPreferenceDefinition = {
  capability: "openFile",
  emptyDescription: "No local app can open files.",
  label: "File default",
};

function LocalOpenTargetPreferenceControl({
  definition,
  onTargetChange,
  preferredTargetId,
  targets,
}: LocalOpenTargetPreferenceControlProps) {
  const compatibleTargets = useMemo(
    () =>
      targets.filter((target) =>
        supportsWorkspaceOpenTargetCapability({
          capability: definition.capability,
          target,
        }),
      ),
    [definition.capability, targets],
  );
  const resolvedTarget = useMemo(
    () =>
      resolvePreferredWorkspaceOpenTarget({
        capability: definition.capability,
        preferredTargetId,
        targets,
      }),
    [definition.capability, preferredTargetId, targets],
  );
  const unavailableMessage =
    compatibleTargets.length === 0 ? definition.emptyDescription : null;
  const selectedTargetId = resolvedTarget?.id ?? preferredTargetId;
  const buttonLabel =
    resolvedTarget?.label ??
    (preferredTargetId
      ? getWorkspaceOpenTargetFallbackLabel(preferredTargetId)
      : "Unavailable");

  return (
    <SettingsWithControl label={definition.label}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            aria-label={definition.label}
          >
            <span className="flex min-w-0 items-center gap-2">
              {selectedTargetId ? (
                <WorkspaceOpenTargetIcon
                  {...(resolvedTarget
                    ? { target: resolvedTarget }
                    : { targetId: selectedTargetId })}
                  className="size-5"
                />
              ) : null}
              <span className="min-w-0 truncate">{buttonLabel}</span>
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={SETTINGS_DROPDOWN_CONTENT_CLASS}
        >
          {unavailableMessage ? (
            <div
              role="note"
              className="px-2 py-[0.3125rem] text-xs leading-snug text-foreground"
            >
              {unavailableMessage}
            </div>
          ) : (
            compatibleTargets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                onSelect={() => onTargetChange(target.id)}
              >
                <WorkspaceOpenTargetIcon target={target} className="size-5" />
                <span className="min-w-0 truncate">{target.label}</span>
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto",
                    resolvedTarget?.id !== target.id && "opacity-0",
                    COARSE_POINTER_ICON_SIZE_CLASS,
                  )}
                />
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsWithControl>
  );
}

export function LocalOpenTargetSettingsSection({
  accessState,
  directoryTargetId,
  fileTargetId,
  hasDaemon,
  onDirectoryTargetChange,
  onFileTargetChange,
  onRequestAccess,
  targets,
}: LocalOpenTargetSettingsSectionProps) {
  const [accessRequestPending, setAccessRequestPending] = useState(false);

  if (accessState === "unavailable") {
    return null;
  }

  const handleRequestAccess = async () => {
    setAccessRequestPending(true);
    try {
      await onRequestAccess();
    } finally {
      setAccessRequestPending(false);
    }
  };

  if (!hasDaemon) {
    const accessDenied = accessState === "denied";
    const accessAvailable = accessState === "available";
    const descriptionText = accessDenied
      ? "Your browser blocked access to bb on this device. Allow local network access for this site in browser settings, then reload bb."
      : accessAvailable
        ? "bb couldn’t connect to its local editor helper. Make sure the bb desktop app or CLI is running on this device, then retry. If it is already running, a remote browser origin may need to be configured."
        : "Connect this browser to bb on this device so it can discover installed editors. bb only contacts the local helper after you choose Enable; your browser may ask for local network access.";
    const buttonLabel = accessRequestPending
      ? accessAvailable
        ? "Retrying…"
        : "Enabling…"
      : accessDenied
        ? "Blocked"
        : accessAvailable
          ? "Retry"
          : "Enable";

    return (
      <SettingsSection title="File Preferences">
        <SettingsWithControl
          label="Local editor integration"
          description={
            <>
              {descriptionText}{" "}
              <a
                href={LOCAL_EDITOR_INTEGRATION_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={(event) => {
                  event.preventDefault();
                  openUrlInExternalBrowser(LOCAL_EDITOR_INTEGRATION_DOCS_URL);
                }}
              >
                Setup guide
                <Icon
                  name="ExternalLink"
                  className="size-3 shrink-0"
                  aria-hidden
                />
              </a>
            </>
          }
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={accessRequestPending || accessDenied}
            onClick={handleRequestAccess}
          >
            {buttonLabel}
          </Button>
        </SettingsWithControl>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="File Preferences">
      <div className="space-y-5">
        <LocalOpenTargetPreferenceControl
          definition={DIRECTORY_TARGET_PREFERENCE}
          onTargetChange={onDirectoryTargetChange}
          preferredTargetId={directoryTargetId}
          targets={targets}
        />
        <LocalOpenTargetPreferenceControl
          definition={FILE_TARGET_PREFERENCE}
          onTargetChange={onFileTargetChange}
          preferredTargetId={fileTargetId}
          targets={targets}
        />
      </div>
    </SettingsSection>
  );
}

const IN_APP_BROWSER_LINK_SETTING_LABEL = "Open links in the in-app browser";
const REWRITE_LOCALHOST_LINKS_SETTING_LABEL = "Rewrite localhost links";
const NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL =
  "Navigate to threads on creation";
const RICH_TEXT_EDITING_SETTING_LABEL = "Markdown formatting in prompt box";
const UNHANDLED_PROVIDER_EVENTS_SETTING_LABEL =
  "Show unhandled provider events";
const FOLLOW_UP_BEHAVIOR_SETTING_LABEL = "Default thread followup behavior";
const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  {
    steerOnEnter: false,
    label: "Queue",
    description:
      "Enter adds a follow-up. It runs when the agent stops. Command+Enter steers the run.",
  },
  {
    steerOnEnter: true,
    label: "Steer",
    description:
      "Enter steers the run now. Command+Enter adds a follow-up for later.",
  },
] as const;
const STREAMER_MODE_SETTING_LABEL = "Streamer mode";
const MANAGED_BRANCH_PREFIX_SETTING_LABEL = "Worktree branch prefix";
const MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG = "fix-login-flow-thr_ab12cd34ef";

interface ManagedBranchPrefixSettingProps {
  disabled: boolean;
  onChange: (prefix: string) => Promise<void> | void;
  value: string;
}

function ManagedBranchPrefixSetting({
  disabled,
  onChange,
  value,
}: ManagedBranchPrefixSettingProps) {
  const [draft, setDraft] = useState(value);
  const [committedValue, setCommittedValue] = useState(value);
  if (value !== committedValue) {
    setCommittedValue(value);
    setDraft(value);
  }

  const valid = managedBranchPrefixSchema.safeParse(draft).success;
  const commit = () => {
    if (!valid) {
      setDraft(value);
      return;
    }
    if (draft !== value) {
      void Promise.resolve(onChange(draft)).catch(() => setDraft(value));
    }
  };

  return (
    <SettingsWithControl
      label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
      description={
        valid ? (
          `bb puts this in front of every branch it creates for a worktree, such as ${draft}${MANAGED_BRANCH_PREFIX_EXAMPLE_SLUG}. Leave it empty for no prefix.`
        ) : (
          <span className="text-destructive" role="alert">
            This prefix cannot start a valid git branch name.
          </span>
        )
      }
      controlPlacement="below"
    >
      <Input
        value={draft}
        aria-label={MANAGED_BRANCH_PREFIX_SETTING_LABEL}
        aria-invalid={!valid}
        disabled={disabled}
        placeholder="No prefix"
        className={cn(
          "h-8 font-mono text-xs",
          !valid && "border-destructive focus-visible:ring-destructive",
        )}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
          }
        }}
      />
    </SettingsWithControl>
  );
}

export function AppearanceSettingsSection({
  appearance,
  appearanceDisabled,
  customThemes,
  pluginThemes,
  faviconColor,
  onAppearanceThemeChange,
  onFaviconColorChange,
  onCreatePalette,
  onThemePreferenceChange,
  themePreference,
}: AppearanceSettingsSectionProps) {
  return (
    <SettingsSection title="Appearance">
      <div className="space-y-5">
        <SidebarThreadListSetting />
        <SidebarNavigationSetting />
        <CodeRendererSettings />
        <SettingsWithControl label="Theme">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                aria-label="Theme"
              >
                {THEME_PREFERENCE_LABELS[themePreference]}
                <Icon
                  name="ChevronDown"
                  className="size-3.5 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={SETTINGS_DROPDOWN_CONTENT_CLASS}
            >
              {THEME_PREFERENCE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={() => onThemePreferenceChange(option.value)}
                >
                  {option.label}
                  <Icon
                    name="Check"
                    className={cn(
                      "ml-auto",
                      themePreference !== option.value && "opacity-0",
                      COARSE_POINTER_ICON_SIZE_CLASS,
                    )}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsWithControl>

        <SettingsWithControl
          label="Palette"
          description={PALETTE_SETTING_DESCRIPTION}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                aria-label="Palette"
                disabled={appearanceDisabled}
              >
                <span className="min-w-0 truncate">
                  {appPaletteLabel(appearance, pluginThemes)}
                </span>
                <Icon
                  name="ChevronDown"
                  className="size-3.5 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={SETTINGS_DROPDOWN_CONTENT_CLASS}
            >
              {builtInThemes.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => onAppearanceThemeChange(entry.id)}
                >
                  {entry.name}
                  <Icon
                    name="Check"
                    className={cn(
                      "ml-auto",
                      appearance.themeId !== entry.id && "opacity-0",
                      COARSE_POINTER_ICON_SIZE_CLASS,
                    )}
                  />
                </DropdownMenuItem>
              ))}
              {customThemes.map((name) => (
                <DropdownMenuItem
                  key={`custom:${name}`}
                  onSelect={() => onAppearanceThemeChange(name)}
                >
                  {name}
                  <Icon
                    name="Check"
                    className={cn(
                      "ml-auto",
                      appearance.themeId !== name && "opacity-0",
                      COARSE_POINTER_ICON_SIZE_CLASS,
                    )}
                  />
                </DropdownMenuItem>
              ))}
              {pluginThemes.map((theme) => (
                <DropdownMenuItem
                  key={theme.id}
                  onSelect={() => onAppearanceThemeChange(theme.id)}
                >
                  {theme.name}
                  <span className="text-muted-foreground">
                    ({theme.pluginId})
                  </span>
                  <Icon
                    name="Check"
                    className={cn(
                      "ml-auto",
                      appearance.themeId !== theme.id && "opacity-0",
                      COARSE_POINTER_ICON_SIZE_CLASS,
                    )}
                  />
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onCreatePalette}>
                <Icon name="Plus" className={COARSE_POINTER_ICON_SIZE_CLASS} />
                Create
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsWithControl>

        <FaviconColorSettingsControl
          disabled={appearanceDisabled}
          faviconColor={faviconColor}
          onFaviconColorChange={onFaviconColorChange}
        />
        <SplitDimmingSetting />
      </div>
    </SettingsSection>
  );
}

export function GeneralSettingsSection({
  desktopBrowserAvailable,
  managedBranchPrefix,
  managedBranchPrefixDisabled,
  navigateToThreadAfterCreate,
  onManagedBranchPrefixChange,
  onNavigateToThreadAfterCreateChange,
  onOpenLinksInAppBrowserChange,
  onRewriteLocalhostLinksChange,
  onRichTextEditingChange,
  onSteerActiveThreadOnEnterChange,
  onStreamerModeChange,
  openLinksInAppBrowser,
  rewriteLocalhostLinks,
  richTextEditing,
  steerActiveThreadOnEnter,
  steerActiveThreadOnEnterDisabled,
  streamerMode,
  streamerModeDisabled,
}: GeneralSettingsSectionProps) {
  return (
    <SettingsSection title="General">
      <div className="space-y-5">
        <SettingsWithControl
          label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
        >
          <Switch
            checked={navigateToThreadAfterCreate}
            onCheckedChange={onNavigateToThreadAfterCreateChange}
            aria-label={NAVIGATE_TO_THREAD_AFTER_CREATE_SETTING_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl label={RICH_TEXT_EDITING_SETTING_LABEL}>
          <Switch
            checked={richTextEditing}
            onCheckedChange={onRichTextEditingChange}
            aria-label={RICH_TEXT_EDITING_SETTING_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
          description="What Enter does in the prompt box while the thread runs."
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
                disabled={steerActiveThreadOnEnterDisabled}
                aria-label={FOLLOW_UP_BEHAVIOR_SETTING_LABEL}
              >
                {steerActiveThreadOnEnter ? "Steer" : "Queue"}
                <Icon
                  name="ChevronDown"
                  className="size-3.5 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={cn(SETTINGS_DROPDOWN_CONTENT_CLASS, "max-w-72")}
            >
              {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.label}
                  className="items-start"
                  onSelect={() =>
                    onSteerActiveThreadOnEnterChange(option.steerOnEnter)
                  }
                >
                  <span className="min-w-0">
                    <span className="block">{option.label}</span>
                    <span className="block text-2xs leading-snug text-subtle-foreground">
                      {option.description}
                    </span>
                  </span>
                  <Icon
                    name="Check"
                    className={cn(
                      "ml-auto",
                      steerActiveThreadOnEnter !== option.steerOnEnter &&
                        "opacity-0",
                      COARSE_POINTER_ICON_SIZE_CLASS,
                    )}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsWithControl>

        {desktopBrowserAvailable ? (
          <SettingsWithControl
            label={IN_APP_BROWSER_LINK_SETTING_LABEL}
            description="Open web links inside bb."
          >
            <Switch
              checked={openLinksInAppBrowser}
              onCheckedChange={onOpenLinksInAppBrowserChange}
              aria-label={IN_APP_BROWSER_LINK_SETTING_LABEL}
            />
          </SettingsWithControl>
        ) : null}

        <SettingsWithControl
          label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
          description="Point localhost links at this host."
        >
          <Switch
            checked={rewriteLocalhostLinks}
            onCheckedChange={onRewriteLocalhostLinksChange}
            aria-label={REWRITE_LOCALHOST_LINKS_SETTING_LABEL}
          />
        </SettingsWithControl>

        <ManagedBranchPrefixSetting
          value={managedBranchPrefix}
          disabled={managedBranchPrefixDisabled}
          onChange={onManagedBranchPrefixChange}
        />

        <SettingsWithControl
          label={STREAMER_MODE_SETTING_LABEL}
          description="Hide the custom models from config.json in every model picker, so a screen share does not show them."
        >
          <Switch
            checked={streamerMode}
            disabled={streamerModeDisabled}
            onCheckedChange={onStreamerModeChange}
            aria-label={STREAMER_MODE_SETTING_LABEL}
          />
        </SettingsWithControl>
      </div>
    </SettingsSection>
  );
}

export function DebugSettingsSection({
  disabled,
  enabled,
  onEnabledChange,
}: DebugSettingsSectionProps) {
  return (
    <SettingsSection title="Debug">
      <SettingsWithControl
        label={UNHANDLED_PROVIDER_EVENTS_SETTING_LABEL}
        description="Show raw provider events bb does not recognize. Development builds always show these events."
      >
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
          aria-label={UNHANDLED_PROVIDER_EVENTS_SETTING_LABEL}
        />
      </SettingsWithControl>
    </SettingsSection>
  );
}

const CHANGELOG_PREVIEW_EXPERIMENT_LABEL = "Changelog preview";
const EDIT_MESSAGES_EXPERIMENT_LABEL = "Edit messages";
const MOBILE_APP_EXPERIMENT_LABEL = "Mobile app";
const SIDEBAR_PROGRESSIVE_DISCLOSURE_EXPERIMENT_LABEL =
  "Sidebar progressive disclosure";
const TIMELINE_WINDOWING_EXPERIMENT_LABEL = "Timeline windowing";
export function ExperimentsSettingsSection({
  changelogPreviewEnabled,
  disabled,
  editMessagesEnabled,
  mobileAppEnabled,
  sidebarProgressiveDisclosureEnabled,
  timelineWindowingEnabled,
  onChangelogPreviewEnabledChange,
  onEditMessagesEnabledChange,
  onMobileAppEnabledChange,
  onSidebarProgressiveDisclosureEnabledChange,
  onTimelineWindowingEnabledChange,
}: ExperimentsSettingsSectionProps) {
  return (
    <SettingsSection
      title="Experiments"
      description="Early features that are off by default. Opt in to try them."
    >
      <div className="space-y-5">
        <SettingsWithControl
          label={CHANGELOG_PREVIEW_EXPERIMENT_LABEL}
          description="Show the latest release notes as a compact preview on the Updates page."
        >
          <Switch
            checked={changelogPreviewEnabled}
            disabled={disabled}
            onCheckedChange={onChangelogPreviewEnabledChange}
            aria-label={CHANGELOG_PREVIEW_EXPERIMENT_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={EDIT_MESSAGES_EXPERIMENT_LABEL}
          description="Edit a sent message and replace the conversation from that point. Workspace changes are kept."
        >
          <Switch
            checked={editMessagesEnabled}
            disabled={disabled}
            onCheckedChange={onEditMessagesEnabledChange}
            aria-label={EDIT_MESSAGES_EXPERIMENT_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={MOBILE_APP_EXPERIMENT_LABEL}
          description="Pair the bb mobile app over bb connect: shows Add mobile device under Remote access and enables bb connect machine-code."
        >
          <Switch
            checked={mobileAppEnabled}
            disabled={disabled}
            onCheckedChange={onMobileAppEnabledChange}
            aria-label={MOBILE_APP_EXPERIMENT_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={SIDEBAR_PROGRESSIVE_DISCLOSURE_EXPERIMENT_LABEL}
          description="In By project and By machine, show the first five groups in the current sort order, keep attention groups visible, and reveal ten more per click. Manually is unchanged."
        >
          <Switch
            checked={sidebarProgressiveDisclosureEnabled}
            disabled={disabled}
            onCheckedChange={onSidebarProgressiveDisclosureEnabledChange}
            aria-label={SIDEBAR_PROGRESSIVE_DISCLOSURE_EXPERIMENT_LABEL}
          />
        </SettingsWithControl>

        <SettingsWithControl
          label={TIMELINE_WINDOWING_EXPERIMENT_LABEL}
          description="Mount only nearby rows in long timelines and expanded timeline details."
        >
          <Switch
            checked={timelineWindowingEnabled}
            disabled={disabled}
            onCheckedChange={onTimelineWindowingEnabledChange}
            aria-label={TIMELINE_WINDOWING_EXPERIMENT_LABEL}
          />
        </SettingsWithControl>
      </div>
    </SettingsSection>
  );
}

export function SettingsView() {
  const navigate = useNavigate();
  const themePreference = useThemePreference();
  const systemConfigQuery = useSystemConfig();
  const { hasDaemon } = useHostDaemon();
  const { accessState, requestAccess } = useLocalHostDaemonAccess();
  const { workspaceOpenTargets } = useWorkspaceOpenTargets({
    enabled: hasDaemon,
  });
  const [directoryTargetId, setDirectoryTargetId] =
    useWorkspaceOpenTargetPreference(workspaceOpenTargets);
  const [fileTargetId, setFileTargetId] =
    useFileOpenTargetPreference(workspaceOpenTargets);
  const [openLinksInAppBrowser, setOpenLinksInAppBrowser] =
    useOpenLinksInAppBrowserPreference();
  const [rewriteLocalhostLinks, setRewriteLocalhostLinks] =
    useRewriteLocalhostLinksPreference();
  const [navigateToThreadAfterCreate, setNavigateToThreadAfterCreate] =
    useNavigateToThreadAfterCreatePreference();
  const [richTextEditing, setRichTextEditing] = useRichTextEditingPreference();
  const [desktopBrowserAvailable] = useState(isDesktopBrowserAvailable);
  const experiments = systemConfigQuery.data?.experiments ?? defaultExperiments;
  const updateExperimentsMutation = useUpdateExperiments();
  const generalSettings =
    systemConfigQuery.data?.generalSettings ?? defaultAppSettings;
  const updateGeneralSettingsMutation = useUpdateGeneralSettings();
  const appearance = systemConfigQuery.data?.appearance ?? defaultAppTheme;
  const updateAppearanceMutation = useUpdateAppearance();
  const location = useLocation();
  const { activePluginId, activeSection, hasUnknownSection } =
    useSettingsNavState();
  if (hasUnknownSection) {
    return <Navigate to={SETTINGS_ROUTE_PATH} replace />;
  }

  if (activeSection === "plugins") {
    const pluginId = matchPath(SETTINGS_PLUGIN_ROUTE_PATH, location.pathname)
      ?.params.pluginId;
    return (
      <div className="-mx-4 -mt-4 flex min-h-0 flex-1 flex-col overflow-hidden pt-4 md:-mx-5 md:-mt-5 md:pt-5">
        {pluginId ? (
          <PluginDetailPaneView pluginId={pluginId} />
        ) : (
          <PluginsOverview />
        )}
      </div>
    );
  }

  let content: ReactNode = null;
  if (activePluginId !== null) {
    content = <PluginSettingsPage pluginId={activePluginId} />;
  } else if (activeSection === "providers") {
    content = (
      <ProvidersSettingsSection
        disabled={
          systemConfigQuery.data === undefined ||
          updateGeneralSettingsMutation.isPending
        }
        generalSettings={generalSettings}
        onGeneralSettingsChange={(next) =>
          updateGeneralSettingsMutation.mutateAsync(next)
        }
      />
    );
  } else if (activeSection === "appearance") {
    content = (
      <AppearanceSettingsSection
        appearance={appearance}
        appearanceDisabled={
          systemConfigQuery.data === undefined ||
          updateAppearanceMutation.isPending
        }
        customThemes={systemConfigQuery.data?.customThemes ?? []}
        pluginThemes={systemConfigQuery.data?.pluginThemes ?? []}
        faviconColor={appearance.faviconColor}
        themePreference={themePreference}
        onAppearanceThemeChange={(themeId) =>
          updateAppearanceMutation.mutate({
            themeId,
            faviconColor: appearance.faviconColor,
          })
        }
        onCreatePalette={() =>
          navigate(getRootComposeRoutePath(), {
            state: {
              focusPrompt: true,
              initialPrompt: CREATE_CUSTOM_PALETTE_PROMPT,
            },
          })
        }
        onFaviconColorChange={(faviconColor) =>
          updateAppearanceMutation.mutate({
            themeId: appearance.themeId,
            faviconColor,
          })
        }
        onThemePreferenceChange={setPreferredTheme}
      />
    );
  } else if (activeSection === "usage") {
    content = <UsageLimitsSettingsSection />;
  } else if (activeSection === "keyboard") {
    content = <KeyboardSettingsSection />;
  } else if (activeSection === "files") {
    content = (
      <>
        <LocalOpenTargetSettingsSection
          accessState={accessState}
          directoryTargetId={directoryTargetId}
          fileTargetId={fileTargetId}
          hasDaemon={hasDaemon}
          onDirectoryTargetChange={setDirectoryTargetId}
          onFileTargetChange={setFileTargetId}
          onRequestAccess={requestAccess}
          targets={workspaceOpenTargets}
        />
        <FileOpenersSettingsSection />
      </>
    );
  } else if (activeSection === "machines") {
    content = <MachinesSettingsSection />;
  } else if (activeSection === "updates") {
    content = (
      <UpdatesSettingsSection
        showChangelogPreview={experiments.changelogPreview}
      />
    );
  } else if (activeSection === "experiments") {
    content = (
      <ExperimentsSettingsSection
        changelogPreviewEnabled={experiments.changelogPreview}
        disabled={
          systemConfigQuery.data === undefined ||
          updateExperimentsMutation.isPending
        }
        onChangelogPreviewEnabledChange={(enabled) =>
          updateExperimentsMutation.mutate({
            ...experiments,
            changelogPreview: enabled,
          })
        }
        editMessagesEnabled={experiments.editMessages}
        onEditMessagesEnabledChange={(enabled) =>
          updateExperimentsMutation.mutate({
            ...experiments,
            editMessages: enabled,
          })
        }
        mobileAppEnabled={experiments.mobileApp}
        onMobileAppEnabledChange={(enabled) =>
          updateExperimentsMutation.mutate({
            ...experiments,
            mobileApp: enabled,
          })
        }
        sidebarProgressiveDisclosureEnabled={
          experiments.sidebarProgressiveDisclosure
        }
        onSidebarProgressiveDisclosureEnabledChange={(enabled) =>
          updateExperimentsMutation.mutate({
            ...experiments,
            sidebarProgressiveDisclosure: enabled,
          })
        }
        timelineWindowingEnabled={experiments.timelineWindowing}
        onTimelineWindowingEnabledChange={(enabled) =>
          updateExperimentsMutation.mutate({
            ...experiments,
            timelineWindowing: enabled,
          })
        }
      />
    );
  } else if (activeSection === "marketplaces") {
    content = <MarketplacesSettingsSection />;
  } else if (activeSection === "community") {
    content = <CommunitySettingsSection />;
  } else if (activeSection === "archived") {
    content = <ArchivedThreadsSettingsSection />;
  } else {
    content = (
      <>
        <GeneralSettingsSection
          desktopBrowserAvailable={desktopBrowserAvailable}
          managedBranchPrefix={generalSettings.managedBranchPrefix}
          managedBranchPrefixDisabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          onManagedBranchPrefixChange={async (prefix) => {
            await updateGeneralSettingsMutation.mutateAsync({
              ...generalSettings,
              managedBranchPrefix: prefix,
            });
          }}
          navigateToThreadAfterCreate={navigateToThreadAfterCreate}
          openLinksInAppBrowser={openLinksInAppBrowser}
          rewriteLocalhostLinks={rewriteLocalhostLinks}
          richTextEditing={richTextEditing}
          steerActiveThreadOnEnter={generalSettings.steerActiveThreadOnEnter}
          steerActiveThreadOnEnterDisabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          onNavigateToThreadAfterCreateChange={setNavigateToThreadAfterCreate}
          onOpenLinksInAppBrowserChange={setOpenLinksInAppBrowser}
          onRewriteLocalhostLinksChange={setRewriteLocalhostLinks}
          onRichTextEditingChange={setRichTextEditing}
          onSteerActiveThreadOnEnterChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              steerActiveThreadOnEnter: enabled,
            })
          }
          streamerMode={generalSettings.streamerMode}
          streamerModeDisabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          onStreamerModeChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              streamerMode: enabled,
            })
          }
        />
        <CliSkillsSettingsSection />
        <VoiceInputSettingsSection />
        <DebugSettingsSection
          enabled={generalSettings.showUnhandledProviderEvents}
          disabled={
            systemConfigQuery.data === undefined ||
            updateGeneralSettingsMutation.isPending
          }
          onEnabledChange={(enabled) =>
            updateGeneralSettingsMutation.mutate({
              ...generalSettings,
              showUnhandledProviderEvents: enabled,
            })
          }
        />
      </>
    );
  }

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-10">{content}</div>
    </PageShell>
  );
}
