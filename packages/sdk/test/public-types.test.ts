import { describe, expectTypeOf, it } from "vitest";
import type {
  BbRealtime as RootBbRealtime,
  BbSdk as RootBbSdk,
  BbRealtimeConnectionEvent as RootRealtimeConnection,
  EnvironmentStatusResult as RootEnvironmentStatus,
  FileReadResult as RootFileRead,
  GuideRenderResult as RootGuideRender,
  HostGetResult as RootHostGet,
  PluginListResult as RootPluginList,
  PluginGetSourceResult as RootPluginGetSource,
  PluginApplyUpdateResult as RootPluginApplyUpdate,
  PluginCatalogStatusResult as RootPluginCatalogStatus,
  PermissionMode as RootPermissionMode,
  ProjectAttachmentUploadResult as RootProjectAttachmentUpload,
  ProjectFileContentResult as RootProjectFileContent,
  ProjectGetResult as RootProjectGet,
  ProjectWorkspaceRoutingArgs as RootProjectWorkspaceRoutingArgs,
  ProviderListArgs as RootProviderListArgs,
  ProviderListResult as RootProviderList,
  ProviderModelsArgs as RootProviderModelsArgs,
  StatusResult as RootStatus,
  SystemVersionResult as RootSystemVersion,
  TerminalCreateArgs as RootTerminalCreateArgs,
  TerminalListResult as RootTerminalListResult,
  ThemeCatalogResult as RootThemeCatalog,
  ThemeSetInput as RootThemeSetInput,
  ThreadSectionListResult as RootThreadSectionList,
  ThreadSpawnResult as RootThreadSpawn,
} from "@bb/sdk";
import type {
  BbSdk as BrowserBbSdk,
  BrowserBbSdk as BrowserRuntimeBbSdk,
  BbRealtimeConnectionEvent as BrowserRealtimeConnection,
  EnvironmentStatusResult as BrowserEnvironmentStatus,
  FileReadResult as BrowserFileRead,
  GuideRenderResult as BrowserGuideRender,
  HostGetResult as BrowserHostGet,
  PluginListResult as BrowserPluginList,
  PluginGetSourceResult as BrowserPluginGetSource,
  PluginApplyUpdateResult as BrowserPluginApplyUpdate,
  PluginCatalogStatusResult as BrowserPluginCatalogStatus,
  ProjectAttachmentUploadResult as BrowserProjectAttachmentUpload,
  ProjectFileContentResult as BrowserProjectFileContent,
  ProjectGetResult as BrowserProjectGet,
  ProjectWorkspaceRoutingArgs as BrowserProjectWorkspaceRoutingArgs,
  ProviderListArgs as BrowserProviderListArgs,
  ProviderListResult as BrowserProviderList,
  ProviderModelsArgs as BrowserProviderModelsArgs,
  StatusResult as BrowserStatus,
  SystemVersionResult as BrowserSystemVersion,
  TerminalCreateArgs as BrowserTerminalCreateArgs,
  TerminalListResult as BrowserTerminalListResult,
  ThemeCatalogResult as BrowserThemeCatalog,
  ThemeSetInput as BrowserThemeSetInput,
  ThreadSectionListResult as BrowserThreadSectionList,
  ThreadSpawnResult as BrowserThreadSpawn,
} from "@bb/sdk/browser";
import type {
  BbSdk as CoreBbSdk,
  BbRealtimeConnectionEvent as CoreRealtimeConnection,
  EnvironmentStatusResult as CoreEnvironmentStatus,
  FileReadResult as CoreFileRead,
  GuideRenderResult as CoreGuideRender,
  HostGetResult as CoreHostGet,
  PluginListResult as CorePluginList,
  PluginGetSourceResult as CorePluginGetSource,
  PluginApplyUpdateResult as CorePluginApplyUpdate,
  PluginCatalogStatusResult as CorePluginCatalogStatus,
  ProjectAttachmentUploadResult as CoreProjectAttachmentUpload,
  ProjectFileContentResult as CoreProjectFileContent,
  ProjectGetResult as CoreProjectGet,
  ProjectWorkspaceRoutingArgs as CoreProjectWorkspaceRoutingArgs,
  ProviderListArgs as CoreProviderListArgs,
  ProviderListResult as CoreProviderList,
  ProviderModelsArgs as CoreProviderModelsArgs,
  StatusResult as CoreStatus,
  SystemVersionResult as CoreSystemVersion,
  TerminalCreateArgs as CoreTerminalCreateArgs,
  TerminalListResult as CoreTerminalListResult,
  ThemeCatalogResult as CoreThemeCatalog,
  ThemeSetInput as CoreThemeSetInput,
  ThreadSectionListResult as CoreThreadSectionList,
  ThreadSpawnResult as CoreThreadSpawn,
} from "@bb/sdk/core";
import type {
  BbSdk as NodeBbSdk,
  BbRealtimeConnectionEvent as NodeRealtimeConnection,
  EnvironmentStatusResult as NodeEnvironmentStatus,
  FileReadResult as NodeFileRead,
  GuideRenderResult as NodeGuideRender,
  HostGetResult as NodeHostGet,
  PluginListResult as NodePluginList,
  PluginGetSourceResult as NodePluginGetSource,
  PluginApplyUpdateResult as NodePluginApplyUpdate,
  PluginCatalogStatusResult as NodePluginCatalogStatus,
  ProjectAttachmentUploadResult as NodeProjectAttachmentUpload,
  ProjectFileContentResult as NodeProjectFileContent,
  ProjectGetResult as NodeProjectGet,
  ProjectWorkspaceRoutingArgs as NodeProjectWorkspaceRoutingArgs,
  ProviderListArgs as NodeProviderListArgs,
  ProviderListResult as NodeProviderList,
  ProviderModelsArgs as NodeProviderModelsArgs,
  StatusResult as NodeStatus,
  SystemVersionResult as NodeSystemVersion,
  TerminalCreateArgs as NodeTerminalCreateArgs,
  TerminalListResult as NodeTerminalListResult,
  ThemeCatalogResult as NodeThemeCatalog,
  ThemeSetInput as NodeThemeSetInput,
  ThreadSectionListResult as NodeThreadSectionList,
  ThreadSpawnResult as NodeThreadSpawn,
} from "@bb/sdk/node";
import type { createBrowserBbSdk } from "@bb/sdk/browser";

interface RootSurface {
  environmentStatus: RootEnvironmentStatus;
  fileRead: RootFileRead;
  guideRender: RootGuideRender;
  hostGet: RootHostGet;
  pluginList: RootPluginList;
  pluginGetSource: RootPluginGetSource;
  pluginApplyUpdate: RootPluginApplyUpdate;
  pluginCatalogStatus: RootPluginCatalogStatus;
  projectAttachmentUpload: RootProjectAttachmentUpload;
  projectFileContent: RootProjectFileContent;
  projectGet: RootProjectGet;
  projectWorkspaceRoutingArgs: RootProjectWorkspaceRoutingArgs;
  providerList: RootProviderList;
  providerListArgs: RootProviderListArgs;
  providerModelsArgs: RootProviderModelsArgs;
  realtimeConnection: RootRealtimeConnection;
  status: RootStatus;
  systemVersion: RootSystemVersion;
  terminalCreateArgs: RootTerminalCreateArgs;
  terminalList: RootTerminalListResult;
  themeCatalog: RootThemeCatalog;
  themeSetInput: RootThemeSetInput;
  threadSectionList: RootThreadSectionList;
  threadSpawn: RootThreadSpawn;
}

interface BrowserSurface {
  environmentStatus: BrowserEnvironmentStatus;
  fileRead: BrowserFileRead;
  guideRender: BrowserGuideRender;
  hostGet: BrowserHostGet;
  pluginList: BrowserPluginList;
  pluginGetSource: BrowserPluginGetSource;
  pluginApplyUpdate: BrowserPluginApplyUpdate;
  pluginCatalogStatus: BrowserPluginCatalogStatus;
  projectAttachmentUpload: BrowserProjectAttachmentUpload;
  projectFileContent: BrowserProjectFileContent;
  projectGet: BrowserProjectGet;
  projectWorkspaceRoutingArgs: BrowserProjectWorkspaceRoutingArgs;
  providerList: BrowserProviderList;
  providerListArgs: BrowserProviderListArgs;
  providerModelsArgs: BrowserProviderModelsArgs;
  realtimeConnection: BrowserRealtimeConnection;
  status: BrowserStatus;
  systemVersion: BrowserSystemVersion;
  terminalCreateArgs: BrowserTerminalCreateArgs;
  terminalList: BrowserTerminalListResult;
  themeCatalog: BrowserThemeCatalog;
  themeSetInput: BrowserThemeSetInput;
  threadSectionList: BrowserThreadSectionList;
  threadSpawn: BrowserThreadSpawn;
}

interface CoreSurface {
  environmentStatus: CoreEnvironmentStatus;
  fileRead: CoreFileRead;
  guideRender: CoreGuideRender;
  hostGet: CoreHostGet;
  pluginList: CorePluginList;
  pluginGetSource: CorePluginGetSource;
  pluginApplyUpdate: CorePluginApplyUpdate;
  pluginCatalogStatus: CorePluginCatalogStatus;
  projectAttachmentUpload: CoreProjectAttachmentUpload;
  projectFileContent: CoreProjectFileContent;
  projectGet: CoreProjectGet;
  projectWorkspaceRoutingArgs: CoreProjectWorkspaceRoutingArgs;
  providerList: CoreProviderList;
  providerListArgs: CoreProviderListArgs;
  providerModelsArgs: CoreProviderModelsArgs;
  realtimeConnection: CoreRealtimeConnection;
  status: CoreStatus;
  systemVersion: CoreSystemVersion;
  terminalCreateArgs: CoreTerminalCreateArgs;
  terminalList: CoreTerminalListResult;
  themeCatalog: CoreThemeCatalog;
  themeSetInput: CoreThemeSetInput;
  threadSectionList: CoreThreadSectionList;
  threadSpawn: CoreThreadSpawn;
}

interface NodeSurface {
  environmentStatus: NodeEnvironmentStatus;
  fileRead: NodeFileRead;
  guideRender: NodeGuideRender;
  hostGet: NodeHostGet;
  pluginList: NodePluginList;
  pluginGetSource: NodePluginGetSource;
  pluginApplyUpdate: NodePluginApplyUpdate;
  pluginCatalogStatus: NodePluginCatalogStatus;
  projectAttachmentUpload: NodeProjectAttachmentUpload;
  projectFileContent: NodeProjectFileContent;
  projectGet: NodeProjectGet;
  projectWorkspaceRoutingArgs: NodeProjectWorkspaceRoutingArgs;
  providerList: NodeProviderList;
  providerListArgs: NodeProviderListArgs;
  providerModelsArgs: NodeProviderModelsArgs;
  realtimeConnection: NodeRealtimeConnection;
  status: NodeStatus;
  systemVersion: NodeSystemVersion;
  terminalCreateArgs: NodeTerminalCreateArgs;
  terminalList: NodeTerminalListResult;
  themeCatalog: NodeThemeCatalog;
  themeSetInput: NodeThemeSetInput;
  threadSectionList: NodeThreadSectionList;
  threadSpawn: NodeThreadSpawn;
}

type ExpectedBbSdkKey =
  | "experimental_desktopBrowsers"
  | "environments"
  | "files"
  | "guide"
  | "hosts"
  | "plugins"
  | "projects"
  | "providers"
  | "skills"
  | "status"
  | "subscribe"
  | "system"
  | "terminals"
  | "theme"
  | "threadSections"
  | "threads";

type ExpectedRealtimeKey = "subscribe";

type ExpectedEnvironmentsKey =
  | "archiveThreads"
  | "commit"
  | "diff"
  | "diffBranches"
  | "diffFile"
  | "diffFiles"
  | "diffPatch"
  | "get"
  | "markPullRequestDraft"
  | "markPullRequestReady"
  | "mergePullRequest"
  | "paths"
  | "pullRequest"
  | "status"
  | "update";

type ExpectedFilesKey =
  | "createPreview"
  | "list"
  | "listPaths"
  | "mkdir"
  | "move"
  | "read"
  | "remove"
  | "write";

type ExpectedGuideKey = "render";

type ExpectedHostsKey =
  | "cloneDefaultPath"
  | "createJoinCode"
  | "delete"
  | "directory"
  | "get"
  | "installProviderCli"
  | "list"
  | "pathsExist"
  | "pickFolder"
  | "providerCliStatus"
  | "retryUpdate"
  | "update";

type ExpectedPluginsKey =
  | "applyUpdate"
  | "callRpc"
  | "catalog"
  | "checkUpdates"
  | "disable"
  | "enable"
  | "getSettings"
  | "getSource"
  | "install"
  | "list"
  | "listUpdateResults"
  | "marketplaces"
  | "reload"
  | "remove"
  | "token"
  | "updateSettings";

type ExpectedPluginCatalogKey = "install" | "installPlan" | "search" | "status";

type ExpectedPluginMarketplacesKey = "add" | "list" | "refresh" | "remove";

type ExpectedProjectsKey =
  | "attachments"
  | "branches"
  | "commands"
  | "create"
  | "defaultExecutionOptions"
  | "delete"
  | "fileContent"
  | "files"
  | "get"
  | "list"
  | "paths"
  | "promptHistory"
  | "reorder"
  | "sidebarBootstrap"
  | "sources"
  | "update";

type ExpectedProjectSourcesKey = "add" | "delete" | "update";
type ExpectedProjectAttachmentsKey = "copy" | "read" | "upload";

type ExpectedProvidersKey = "list" | "models";

type ExpectedStatusKey = "get";

type ExpectedSystemKey =
  | "attention"
  | "cliSkillsStatus"
  | "config"
  | "executionOptions"
  | "installCliSkills"
  | "reloadConfig"
  | "transcribeVoice"
  | "updateExperiments"
  | "updateGeneralSettings"
  | "updateKeyboardSettings"
  | "providerStates"
  | "usageLimits"
  | "version";

type ExpectedThemeKey = "catalog" | "get" | "set";

type ExpectedThreadSectionsKey = "create" | "delete" | "list" | "update";

type ExpectedThreadsKey =
  | "archive"
  | "archiveAll"
  | "cancelPlan"
  | "childSummary"
  | "clearContext"
  | "clearGoal"
  | "compact"
  | "conversationOutline"
  | "count"
  | "defaultExecutionOptions"
  | "delete"
  | "editMessage"
  | "events"
  | "fork"
  | "get"
  | "interactions"
  | "list"
  | "listRunning"
  | "markRead"
  | "markUnread"
  | "open"
  | "output"
  | "paneAction"
  | "pin"
  | "promptHistory"
  | "queue"
  | "queuedMessages"
  | "reorderPinned"
  | "resolveMentions"
  | "retry"
  | "search"
  | "send"
  | "spawn"
  | "stop"
  | "storageFiles"
  | "storageLocation"
  | "storagePaths"
  | "tabs"
  | "timeline"
  | "timelineTurnSummaryDetails"
  | "unarchive"
  | "unpin"
  | "update"
  | "wait";

type ExpectedThreadEventsKey = "list" | "wait";
/**
 * The cross-thread queue area answers exactly one question — what is queued
 * right now — so it has exactly one method. A row's own operations (send-now,
 * edit, reorder, delete) live on `queuedMessages`.
 */
type ExpectedThreadQueueKey = "list";
type ExpectedThreadInteractionsKey =
  | "cancel"
  | "get"
  | "list"
  | "resolve"
  | "respond";
type ExpectedThreadQueuedMessagesKey =
  | "create"
  | "delete"
  | "list"
  | "reorder"
  | "send"
  | "setGroupBoundary"
  | "update";
type ExpectedThreadTabsKey = "get" | "update";
type ExpectedTerminalsKey =
  | "close"
  | "create"
  | "get"
  | "input"
  | "list"
  | "output"
  | "rename"
  | "restart"
  | "resize";

describe("SDK public type entrypoints", () => {
  it("export the same transport-independent DTO surface", () => {
    expectTypeOf<BrowserSurface>().toEqualTypeOf<RootSurface>();
    expectTypeOf<CoreSurface>().toEqualTypeOf<RootSurface>();
    expectTypeOf<NodeSurface>().toEqualTypeOf<RootSurface>();
  });

  it("preserves the complete SDK surface at every entrypoint", () => {
    expectTypeOf<keyof RootBbSdk>().toEqualTypeOf<ExpectedBbSdkKey>();
    expectTypeOf<BrowserBbSdk>().toEqualTypeOf<RootBbSdk>();
    expectTypeOf<CoreBbSdk>().toEqualTypeOf<RootBbSdk>();
    expectTypeOf<NodeBbSdk>().toEqualTypeOf<RootBbSdk>();
  });

  it("keeps the local guide area off the browser SDK instance", () => {
    expectTypeOf<keyof BrowserRuntimeBbSdk>().toEqualTypeOf<
      Exclude<ExpectedBbSdkKey, "guide">
    >();
    expectTypeOf<
      ReturnType<typeof createBrowserBbSdk>
    >().toEqualTypeOf<BrowserRuntimeBbSdk>();
  });

  it("exports only the public permission presets", () => {
    expectTypeOf<RootPermissionMode>().toEqualTypeOf<
      "accept-edits" | "auto" | "full"
    >();
  });

  it("makes provider host selectors mutually exclusive", () => {
    expectTypeOf<{
      environmentId: string;
      hostId: string;
    }>().not.toMatchTypeOf<RootProviderListArgs>();
    expectTypeOf<{ hostId: string }>().toMatchTypeOf<RootProviderModelsArgs>();
    expectTypeOf<{
      environmentId: string;
    }>().toMatchTypeOf<RootProviderModelsArgs>();
  });

  it("makes project workspace selectors mutually exclusive", () => {
    expectTypeOf<{
      environmentId: string;
      hostId: string;
    }>().not.toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
    expectTypeOf<{
      hostId: string;
    }>().toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
    expectTypeOf<{
      environmentId: string;
    }>().toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
  });

  it("uses explicit mutually exclusive terminal scopes", () => {
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: {
        kind: "thread";
        threadId: string;
        environmentId: string;
      };
    }>().not.toMatchTypeOf<RootTerminalCreateArgs>();
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: { kind: "environment"; environmentId: string };
    }>().toMatchTypeOf<RootTerminalCreateArgs>();
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: { kind: "host_path"; hostId: string; cwd: null };
    }>().toMatchTypeOf<RootTerminalCreateArgs>();
  });

  it("snapshots every SDK area and nested method group", () => {
    expectTypeOf<keyof RootBbRealtime>().toEqualTypeOf<ExpectedRealtimeKey>();
    expectTypeOf<
      keyof RootBbSdk["environments"]
    >().toEqualTypeOf<ExpectedEnvironmentsKey>();
    expectTypeOf<keyof RootBbSdk["files"]>().toEqualTypeOf<ExpectedFilesKey>();
    expectTypeOf<keyof RootBbSdk["guide"]>().toEqualTypeOf<ExpectedGuideKey>();
    expectTypeOf<keyof RootBbSdk["hosts"]>().toEqualTypeOf<ExpectedHostsKey>();
    expectTypeOf<
      keyof RootBbSdk["plugins"]
    >().toEqualTypeOf<ExpectedPluginsKey>();
    expectTypeOf<
      keyof RootBbSdk["plugins"]["catalog"]
    >().toEqualTypeOf<ExpectedPluginCatalogKey>();
    expectTypeOf<
      keyof RootBbSdk["plugins"]["marketplaces"]
    >().toEqualTypeOf<ExpectedPluginMarketplacesKey>();
    expectTypeOf<
      keyof RootBbSdk["projects"]
    >().toEqualTypeOf<ExpectedProjectsKey>();
    expectTypeOf<
      keyof RootBbSdk["projects"]["attachments"]
    >().toEqualTypeOf<ExpectedProjectAttachmentsKey>();
    expectTypeOf<
      keyof RootBbSdk["projects"]["sources"]
    >().toEqualTypeOf<ExpectedProjectSourcesKey>();
    expectTypeOf<
      keyof RootBbSdk["providers"]
    >().toEqualTypeOf<ExpectedProvidersKey>();
    expectTypeOf<
      keyof RootBbSdk["status"]
    >().toEqualTypeOf<ExpectedStatusKey>();
    expectTypeOf<
      keyof RootBbSdk["system"]
    >().toEqualTypeOf<ExpectedSystemKey>();
    expectTypeOf<
      keyof RootBbSdk["terminals"]
    >().toEqualTypeOf<ExpectedTerminalsKey>();
    expectTypeOf<keyof RootBbSdk["theme"]>().toEqualTypeOf<ExpectedThemeKey>();
    expectTypeOf<
      keyof RootBbSdk["threadSections"]
    >().toEqualTypeOf<ExpectedThreadSectionsKey>();
    expectTypeOf<
      keyof RootBbSdk["threads"]
    >().toEqualTypeOf<ExpectedThreadsKey>();
    expectTypeOf<
      keyof RootBbSdk["threads"]["events"]
    >().toEqualTypeOf<ExpectedThreadEventsKey>();
    expectTypeOf<
      keyof RootBbSdk["threads"]["queue"]
    >().toEqualTypeOf<ExpectedThreadQueueKey>();
    expectTypeOf<
      keyof RootBbSdk["threads"]["interactions"]
    >().toEqualTypeOf<ExpectedThreadInteractionsKey>();
    expectTypeOf<
      keyof RootBbSdk["threads"]["queuedMessages"]
    >().toEqualTypeOf<ExpectedThreadQueuedMessagesKey>();
    expectTypeOf<
      keyof RootBbSdk["threads"]["tabs"]
    >().toEqualTypeOf<ExpectedThreadTabsKey>();
  });
});
