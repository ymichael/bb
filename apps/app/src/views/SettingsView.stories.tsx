import { useEffect, useRef, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import {
  defaultAppTheme,
  defaultExperiments,
  type AppTheme,
  type Experiments,
  type Host,
  defaultAppSettings,
  type AppSettings,
} from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type {
  ProviderUsage,
  WorkspaceOpenTarget,
  WorkspaceOpenTargetId,
} from "@bb/host-daemon-contract";
import { UsageLimitsSettingsSectionContent } from "@/components/settings/UsageLimitsSettingsSection";
import { VoiceInputSettingsSectionContent } from "@/components/settings/VoiceInputSettingsSection";
import { ArchivedThreadsSettingsSection } from "@/components/settings/ArchivedThreadsSettingsSection";
import { CommunitySettingsSection } from "@/components/settings/CommunitySettingsSection";
import { KeyboardSettingsSection } from "@/components/settings/KeyboardSettingsSection";
import { MarketplacesSettingsSection } from "@/components/settings/MarketplacesSettingsSection";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import {
  SettingsStoryChrome,
  type SettingsStoryRoute,
  useSettingsStoryRoute,
} from "../../.ladle/story-settings-chrome";
import {
  SettingsStoryFixtures,
  SettingsUpdatesStory,
} from "../../.ladle/settings-story-fixtures";
import type { ThemePreference } from "@/hooks/useTheme";
import type { AudioInputDeviceOption } from "@/hooks/useAudioInputDevices";
import type { PreferredAudioInputDeviceId } from "@/lib/audio-input-device-preference";
import { SETTINGS_MACHINE_ROUTE_PATH } from "@/lib/route-paths";
import {
  AppearanceSettingsSection,
  DebugSettingsSection,
  ExperimentsSettingsSection,
  GeneralSettingsSection,
  LocalOpenTargetSettingsSection,
  type LocalOpenTargetSettingsSectionProps,
} from "./SettingsView";
import { MachineSettingsView } from "./MachineSettingsView";
import { ProvidersSettingsSection } from "@/components/settings/ProvidersSettingsSection";

export default {
  title: "settings/Settings",
};

type StoredTargetId = LocalOpenTargetSettingsSectionProps["directoryTargetId"];

const audioInputDevices: AudioInputDeviceOption[] = [
  { deviceId: "macbook-mic", label: "MacBook Pro Microphone" },
  { deviceId: "studio-mic", label: "Studio Display Microphone" },
];

const vscodeTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: true,
    openFileAtLine: true,
  },
  id: "vscode",
  label: "VS Code",
};

const finderTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: false,
    openFileAtLine: false,
  },
  id: "finder",
  label: "Finder",
};

const terminalTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: false,
    openFileAtLine: false,
  },
  id: "terminal",
  label: "Terminal",
};

const defaultAppTarget: WorkspaceOpenTarget = {
  capabilities: {
    openDirectory: true,
    openFile: true,
    openFileAtLine: false,
  },
  id: "default-app",
  label: "Default App",
};

const connectedTargets: WorkspaceOpenTarget[] = [
  vscodeTarget,
  finderTarget,
  terminalTarget,
  defaultAppTarget,
];

function futureIso(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

const usageFixture: {
  codex: ProviderUsage;
  "claude-code": ProviderUsage;
  "acp-cursor": ProviderUsage;
} = {
  codex: {
    status: "ok",
    accountEmail: "sawyer@example.com",
    planLabel: "Pro",
    windows: [
      {
        label: "Current session",
        resetsAt: futureIso(136),
        usedPercent: 35,
      },
      {
        label: "Weekly limit",
        resetsAt: futureIso(48),
        usedPercent: 74,
      },
    ],
  },
  "claude-code": {
    status: "ok",
    accountEmail: "sawyer@example.com",
    planLabel: "Max (20x)",
    windows: [
      {
        label: "Current session",
        resetsAt: futureIso(179),
        usedPercent: 3,
      },
      {
        label: "Weekly limit",
        resetsAt: futureIso(4 * 24 * 60),
        usedPercent: 26,
      },
    ],
  },
  "acp-cursor": {
    status: "ok",
    accountEmail: "sawyer@example.com",
    planLabel: "Pro",
    windows: [
      {
        label: "Plan usage",
        resetsAt: futureIso(14 * 24 * 60),
        usedPercent: 72,
      },
      {
        label: "On-demand spend",
        resetsAt: futureIso(14 * 24 * 60),
        usedPercent: 25,
        cost: { usedUsdCents: 1_250, limitUsdCents: 5_000 },
      },
    ],
  },
};

const usageHosts: Host[] = [
  makeHost({
    id: "host-macbook",
    name: "MacBook Pro",
    lastSeenAt: Date.now(),
    createdAt: 1,
    updatedAt: 1,
  }),
  makeHost({
    id: "host-studio",
    name: "Mac Studio",
    lastSeenAt: Date.now(),
    createdAt: 1,
    updatedAt: 1,
  }),
];

function useSettingsStoryState() {
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("system");
  const [appearance, setAppearance] = useState<AppTheme>({
    ...defaultAppTheme,
    faviconColor: "red",
  });
  const [navigateToThreadAfterCreate, setNavigateToThreadAfterCreate] =
    useState(false);
  const [openLinksInAppBrowser, setOpenLinksInAppBrowser] = useState(false);
  const [rewriteLocalhostLinks, setRewriteLocalhostLinks] = useState(true);
  const [richTextEditing, setRichTextEditing] = useState(false);
  const [steerActiveThreadOnEnter, setSteerActiveThreadOnEnter] =
    useState(false);
  const [streamerMode, setStreamerMode] = useState(false);
  const [managedBranchPrefix, setManagedBranchPrefix] = useState(
    defaultAppSettings.managedBranchPrefix,
  );
  const [showUnhandledProviderEvents, setShowUnhandledProviderEvents] =
    useState(false);
  const [preferredAudioInputDeviceId, setPreferredAudioInputDeviceId] =
    useState<PreferredAudioInputDeviceId>("studio-mic");
  const [directoryTargetId, setDirectoryTargetId] =
    useState<StoredTargetId>("finder");
  const [fileTargetId, setFileTargetId] =
    useState<StoredTargetId>("default-app");
  const [experiments, setExperiments] =
    useState<Experiments>(defaultExperiments);

  return {
    appearance,
    directoryTargetId,
    experiments,
    fileTargetId,
    managedBranchPrefix,
    navigateToThreadAfterCreate,
    openLinksInAppBrowser,
    preferredAudioInputDeviceId,
    rewriteLocalhostLinks,
    richTextEditing,
    steerActiveThreadOnEnter,
    streamerMode,
    showUnhandledProviderEvents,
    setAppearance,
    setDirectoryTargetId,
    setExperiments,
    setFileTargetId,
    setManagedBranchPrefix,
    setNavigateToThreadAfterCreate,
    setOpenLinksInAppBrowser,
    setPreferredAudioInputDeviceId,
    setRewriteLocalhostLinks,
    setRichTextEditing,
    setSteerActiveThreadOnEnter,
    setStreamerMode,
    setShowUnhandledProviderEvents,
    setThemePreference,
    themePreference,
  };
}

function VoiceInputStory() {
  const state = useSettingsStoryState();

  return (
    <VoiceInputSettingsSectionContent
      devices={audioInputDevices}
      errorMessage={null}
      isLoading={false}
      isSupported={true}
      onDeviceChange={state.setPreferredAudioInputDeviceId}
      onRefresh={() => undefined}
      preferredDeviceId={state.preferredAudioInputDeviceId}
    />
  );
}

function GeneralSettingsStory({
  desktopBrowserAvailable = false,
}: {
  desktopBrowserAvailable?: boolean;
}) {
  const state = useSettingsStoryState();

  return (
    <>
      <GeneralSettingsSection
        desktopBrowserAvailable={desktopBrowserAvailable}
        managedBranchPrefix={state.managedBranchPrefix}
        managedBranchPrefixDisabled={false}
        onManagedBranchPrefixChange={state.setManagedBranchPrefix}
        navigateToThreadAfterCreate={state.navigateToThreadAfterCreate}
        onNavigateToThreadAfterCreateChange={
          state.setNavigateToThreadAfterCreate
        }
        onOpenLinksInAppBrowserChange={state.setOpenLinksInAppBrowser}
        onRewriteLocalhostLinksChange={state.setRewriteLocalhostLinks}
        onRichTextEditingChange={state.setRichTextEditing}
        onSteerActiveThreadOnEnterChange={state.setSteerActiveThreadOnEnter}
        onStreamerModeChange={state.setStreamerMode}
        openLinksInAppBrowser={state.openLinksInAppBrowser}
        rewriteLocalhostLinks={state.rewriteLocalhostLinks}
        richTextEditing={state.richTextEditing}
        steerActiveThreadOnEnter={state.steerActiveThreadOnEnter}
        steerActiveThreadOnEnterDisabled={false}
        streamerMode={state.streamerMode}
        streamerModeDisabled={false}
      />
      <DebugSettingsSection
        disabled={false}
        enabled={state.showUnhandledProviderEvents}
        onEnabledChange={state.setShowUnhandledProviderEvents}
      />
    </>
  );
}

function AppearanceSettingsStory() {
  const state = useSettingsStoryState();

  return (
    <AppearanceSettingsSection
      appearance={state.appearance}
      appearanceDisabled={false}
      customThemes={["Monochrome Lab", "Low Contrast"]}
      pluginThemes={[]}
      faviconColor={state.appearance.faviconColor}
      onAppearanceThemeChange={(themeId) =>
        state.setAppearance((current) => ({ ...current, themeId }))
      }
      onCreatePalette={() => undefined}
      onFaviconColorChange={(faviconColor) =>
        state.setAppearance((current) => ({ ...current, faviconColor }))
      }
      onThemePreferenceChange={state.setThemePreference}
      themePreference={state.themePreference}
    />
  );
}

function FilePreferencesStory() {
  const state = useSettingsStoryState();

  function handleDirectoryTargetChange(targetId: WorkspaceOpenTargetId): void {
    state.setDirectoryTargetId(targetId);
  }

  function handleFileTargetChange(targetId: WorkspaceOpenTargetId): void {
    state.setFileTargetId(targetId);
  }

  return (
    <LocalOpenTargetSettingsSection
      accessState="available"
      directoryTargetId={state.directoryTargetId}
      fileTargetId={state.fileTargetId}
      hasDaemon={true}
      onDirectoryTargetChange={handleDirectoryTargetChange}
      onFileTargetChange={handleFileTargetChange}
      onRequestAccess={async () => true}
      targets={connectedTargets}
    />
  );
}

function ExperimentsStory() {
  const state = useSettingsStoryState();

  return (
    <ExperimentsSettingsSection
      changelogPreviewEnabled={state.experiments.changelogPreview}
      disabled={false}
      editMessagesEnabled={state.experiments.editMessages}
      mobileAppEnabled={state.experiments.mobileApp}
      sidebarProgressiveDisclosureEnabled={
        state.experiments.sidebarProgressiveDisclosure
      }
      timelineWindowingEnabled={state.experiments.timelineWindowing}
      onChangelogPreviewEnabledChange={(enabled) =>
        state.setExperiments((current) => ({
          ...current,
          changelogPreview: enabled,
        }))
      }
      onEditMessagesEnabledChange={(enabled) =>
        state.setExperiments((current) => ({
          ...current,
          editMessages: enabled,
        }))
      }
      onMobileAppEnabledChange={(enabled) =>
        state.setExperiments((current) => ({
          ...current,
          mobileApp: enabled,
        }))
      }
      onSidebarProgressiveDisclosureEnabledChange={(enabled) =>
        state.setExperiments((current) => ({
          ...current,
          sidebarProgressiveDisclosure: enabled,
        }))
      }
      onTimelineWindowingEnabledChange={(enabled) =>
        state.setExperiments((current) => ({
          ...current,
          timelineWindowing: enabled,
        }))
      }
    />
  );
}

function UsageLimitsStory() {
  const [isFetching, setIsFetching] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState("host-macbook");

  return (
    <UsageLimitsSettingsSectionContent
      usage={usageFixture}
      isLoading={false}
      isError={false}
      isFetching={isFetching}
      onRefresh={() => {
        setIsFetching(true);
        window.setTimeout(() => setIsFetching(false), 500);
      }}
      hosts={usageHosts}
      selectedHostId={selectedHostId}
      onSelectHost={setSelectedHostId}
    />
  );
}

function ProvidersSettingsStory() {
  const [generalSettings, setGeneralSettings] =
    useState<AppSettings>(defaultAppSettings);
  return (
    <ProvidersSettingsSection
      disabled={false}
      generalSettings={generalSettings}
      onGeneralSettingsChange={setGeneralSettings}
    />
  );
}

function SettingsStoryContent({ route }: { route: SettingsStoryRoute }) {
  if (route.kind === "machine") {
    return (
      <Routes>
        <Route
          path={SETTINGS_MACHINE_ROUTE_PATH}
          element={<MachineSettingsView />}
        />
      </Routes>
    );
  }

  switch (route.id) {
    case "providers":
      return <ProvidersSettingsStory />;
    case "appearance":
      return <AppearanceSettingsStory />;
    case "keyboard":
      return <KeyboardSettingsSection />;
    case "usage":
      return <UsageLimitsStory />;
    case "files":
      return <FilePreferencesStory />;
    case "machines":
      return <MachinesSettingsSection />;
    case "updates":
      return <SettingsUpdatesStory />;
    case "experiments":
      return <ExperimentsStory />;
    case "marketplaces":
      return <MarketplacesSettingsSection />;
    case "community":
      return <CommunitySettingsSection />;
    case "archived":
      return <ArchivedThreadsSettingsSection />;
    case "general":
      return (
        <>
          <GeneralSettingsStory desktopBrowserAvailable />
          <VoiceInputStory />
        </>
      );
  }
}

export function FullPage() {
  const navigate = useNavigate();
  const route = useSettingsStoryRoute();
  const initializedFromStoryPath = useRef(false);
  useEffect(() => {
    if (initializedFromStoryPath.current) return;
    initializedFromStoryPath.current = true;
    const storyPath =
      new URLSearchParams(window.location.hash.slice(1)).get("settingsPath") ??
      new URLSearchParams(window.location.search).get("settingsPath");
    if (storyPath?.startsWith("/settings") === true) {
      navigate(storyPath, { replace: true });
    }
  }, [navigate]);

  return (
    <SettingsStoryFixtures>
      <SettingsStoryChrome contentOwnsPageShell={route.kind === "machine"}>
        <SettingsStoryContent route={route} />
      </SettingsStoryChrome>
    </SettingsStoryFixtures>
  );
}
