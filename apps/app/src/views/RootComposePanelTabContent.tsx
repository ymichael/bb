import { useMemo, type ReactNode } from "react";
import type { OpenInTargetContext } from "@bb/host-daemon-contract";
import type { SidebarProject } from "@/hooks/queries/project-queries";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk";
import type {
  PluginPanelFixedPanelTab,
  SecondaryFileFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import type { SecondaryPanelPaneRenderContext } from "@/components/secondary-panel/ThreadSecondaryPanel";
import {
  LazyFilePreview,
  LazyHostFilePreviewTabContent,
  LazyNewTabPage,
  LazyProjectFilePreviewTabContent,
  LazyThreadStorageFilePreviewTabContent,
  LazyThreadTerminalPanel,
  LazyWorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/lazySecondaryPanelComponents";
import type { FileSearchSelection } from "@/components/secondary-panel/useThreadFileTabs";
import {
  PluginPanelTabContent,
  type PluginPanelActionEntry,
} from "@/components/plugin/PluginPanelActions";
import {
  createFileOpenerOriginalTab,
  parseFileOpenerParams,
  type FileOpenerOriginalTab,
} from "@/components/plugin/file-opener-tabs";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useThreadStorageViewer } from "@/components/secondary-panel/useThreadStorageViewer";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import {
  buildOpenInEditorHandler,
  resolveEnvironmentOpenContext,
} from "./thread-detail/threadWorkspaceOpenPath";
import { getFilePreviewLineRangeStart } from "@bb/client-core";
import { resolveAbsoluteFilePath } from "@/lib/absolute-file-path";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";

export const ROOT_COMPOSE_FIXED_PANEL_STATE_ID = "root-compose";

export type RootComposeTerminalTarget =
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; cwd: string | null; hostId: string };

interface RootComposePanelTabContentProps {
  activeTabId: string | null;
  canCreateTerminal: boolean;
  currentProjectId: string;
  isPanelOpen: boolean;
  isPanelPersistedOpen: boolean;
  isProjectless: boolean;
  onActivateTab: (tabId: string) => void;
  onAutoFocusNewTabHandled: () => void;
  onAutoFocusTerminalHandled: () => void;
  onOpenBrowser: () => void;
  onOpenPanelLink: MarkdownPreviewLinkHandler;
  onSelectFileSearchResult: (selection: FileSearchSelection) => void;
  onSelectionAddToChat: (text: string) => void;
  onStartTerminal: () => void;
  pane: SecondaryPanelPaneRenderContext;
  primaryHostId: string | null;
  pluginActions: readonly PluginPanelActionEntry[];
  projectSources: SidebarProject["sources"];
  projects: readonly SidebarProject[] | undefined;
  rootPanelEnvironmentId: string | null;
  rootPanelThreadId: string | null;
  rootProjectHostId: string | null;
  shouldAutoFocusNewTab: boolean;
  shouldAutoFocusTerminal: boolean;
  tab: SecondaryFileFixedPanelTab;
  terminalTarget: RootComposeTerminalTarget | null;
}

interface RootComposeFilePreviewTabContentProps {
  currentProjectId: string;
  isFocused: boolean;
  isPanelOpen: boolean;
  isProjectless: boolean;
  fileOpenerSource: PluginFileOpenerSource | null;
  onSelectionAddToChat: (text: string) => void;
  pluginPanelTab?: PluginPanelFixedPanelTab;
  primaryHostId: string | null;
  projectSources: SidebarProject["sources"];
  projects: readonly SidebarProject[] | undefined;
  rootPanelEnvironmentId: string | null;
  rootPanelThreadId: string | null;
  rootProjectHostId: string | null;
  tab: FileOpenerOriginalTab;
}

function resolveHostOpenContext(args: {
  hostId: string | null;
  isLocal: boolean;
  serverOrigin: string;
}): OpenInTargetContext | null {
  if (args.hostId === null) return null;
  if (args.isLocal) return { kind: "local" };
  return {
    kind: "remote-ssh",
    serverOrigin: args.serverOrigin,
    hostId: args.hostId,
  };
}

export function resolveRootComposeProjectFileRouting({
  fileOpenerSource,
  selectedEnvironmentId,
  selectedHostId,
}: {
  fileOpenerSource: PluginFileOpenerSource | null;
  selectedEnvironmentId: string | null;
  selectedHostId: string | null;
}): { environmentId: string | null; hostId: string | null } {
  if (
    fileOpenerSource?.kind === "workspace" &&
    fileOpenerSource.environmentId === null &&
    fileOpenerSource.projectId !== null
  ) {
    return {
      environmentId: null,
      hostId: fileOpenerSource.experimental_hostId ?? null,
    };
  }
  return {
    environmentId: selectedEnvironmentId,
    hostId: selectedHostId,
  };
}

export function RootComposePanelTabContent({
  activeTabId,
  canCreateTerminal,
  currentProjectId,
  isPanelOpen,
  isPanelPersistedOpen,
  isProjectless,
  onActivateTab,
  onAutoFocusNewTabHandled,
  onAutoFocusTerminalHandled,
  onOpenBrowser,
  onOpenPanelLink,
  onSelectFileSearchResult,
  onSelectionAddToChat,
  onStartTerminal,
  pane,
  primaryHostId,
  pluginActions,
  projectSources,
  projects,
  rootPanelEnvironmentId,
  rootPanelThreadId,
  rootProjectHostId,
  shouldAutoFocusNewTab,
  shouldAutoFocusTerminal,
  tab,
  terminalTarget,
}: RootComposePanelTabContentProps) {
  switch (tab.kind) {
    case "browser":
      return null;
    case "terminal":
      return terminalTarget === null ? null : (
        <LazyThreadTerminalPanel
          autoFocus={
            pane.isFocused && tab.id === activeTabId && shouldAutoFocusTerminal
          }
          canCreateTerminal={canCreateTerminal}
          isPanelOpen={isPanelOpen}
          isPanelPersistedOpen={isPanelPersistedOpen}
          onAutoFocusHandled={onAutoFocusTerminalHandled}
          onOpenLink={onOpenPanelLink}
          onSelectionAddToChat={onSelectionAddToChat}
          panelStateId={ROOT_COMPOSE_FIXED_PANEL_STATE_ID}
          syncThreadId={null}
          target={terminalTarget}
          terminalId={tab.terminalId}
        />
      );
    case "new-tab":
      return (
        <LazyNewTabPage
          autoFocus={
            pane.isFocused && tab.id === activeTabId && shouldAutoFocusNewTab
          }
          projectId={isProjectless ? undefined : currentProjectId}
          environmentId={rootPanelEnvironmentId}
          hostId={rootProjectHostId}
          currentThreadId={rootPanelThreadId ?? ""}
          onAutoFocusHandled={onAutoFocusNewTabHandled}
          onSelect={(selection) => {
            onActivateTab(tab.id);
            onSelectFileSearchResult(selection);
          }}
          recentItemsThreadId={ROOT_COMPOSE_FIXED_PANEL_STATE_ID}
          onOpenBrowser={
            rootPanelThreadId
              ? () => {
                  onActivateTab(tab.id);
                  onOpenBrowser();
                }
              : undefined
          }
          onStartTerminal={
            canCreateTerminal
              ? () => {
                  onActivateTab(tab.id);
                  onStartTerminal();
                }
              : undefined
          }
          pluginActions={pluginActions}
          showFileSearch={!isProjectless}
        />
      );
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview":
      return (
        <RootComposeFilePreviewTabContent
          currentProjectId={currentProjectId}
          fileOpenerSource={null}
          isFocused={pane.isFocused}
          isPanelOpen={isPanelOpen}
          isProjectless={isProjectless}
          onSelectionAddToChat={onSelectionAddToChat}
          primaryHostId={primaryHostId}
          projectSources={projectSources}
          projects={projects}
          rootPanelEnvironmentId={rootPanelEnvironmentId}
          rootPanelThreadId={rootPanelThreadId}
          rootProjectHostId={rootProjectHostId}
          tab={tab}
        />
      );
    case "plugin-panel": {
      const fileOpenerFile = parseFileOpenerParams(tab.paramsJson);
      const originalTab = createFileOpenerOriginalTab(tab);
      if (originalTab === null) {
        return (
          <PluginPanelTabContent
            tab={tab}
            context={{
              kind: "new-thread",
              projectId: isProjectless ? null : currentProjectId,
            }}
          />
        );
      }
      return (
        <RootComposeFilePreviewTabContent
          currentProjectId={currentProjectId}
          fileOpenerSource={fileOpenerFile?.source ?? null}
          isFocused={pane.isFocused}
          isPanelOpen={isPanelOpen}
          isProjectless={isProjectless}
          onSelectionAddToChat={onSelectionAddToChat}
          pluginPanelTab={tab}
          primaryHostId={primaryHostId}
          projectSources={projectSources}
          projects={projects}
          rootPanelEnvironmentId={rootPanelEnvironmentId}
          rootPanelThreadId={rootPanelThreadId}
          rootProjectHostId={rootProjectHostId}
          tab={originalTab}
        />
      );
    }
  }
}

function RootComposeFilePreviewTabContent({
  currentProjectId,
  fileOpenerSource,
  isFocused,
  isPanelOpen,
  isProjectless,
  onSelectionAddToChat,
  pluginPanelTab,
  primaryHostId,
  projectSources,
  projects,
  rootPanelEnvironmentId,
  rootPanelThreadId,
  rootProjectHostId,
  tab,
}: RootComposeFilePreviewTabContentProps) {
  const environmentId =
    fileOpenerSource === null
      ? (tab.environmentId ?? rootPanelEnvironmentId)
      : fileOpenerSource.environmentId;
  const environmentQuery = useEnvironment(environmentId, {
    enabled: environmentId !== null,
    staleTime: 5_000,
  });
  const environment = environmentQuery.data;
  const storageThreadId =
    tab.kind === "thread-storage-file-preview"
      ? fileOpenerSource === null
        ? (tab.threadId ?? rootPanelThreadId)
        : fileOpenerSource.threadId
      : null;
  const { threadStorageRootPath } = useThreadStorageViewer({
    fileListEnabled: storageThreadId !== null,
    threadId: storageThreadId ?? undefined,
  });
  const projectPreviewId =
    tab.kind === "workspace-file-preview" && tab.environmentId === null
      ? fileOpenerSource?.kind === "workspace"
        ? fileOpenerSource.projectId
        : (tab.projectId ?? currentProjectId)
      : null;
  const previewProjectSources =
    projectPreviewId === null
      ? []
      : projectPreviewId === currentProjectId
        ? projectSources
        : (projects?.find((project) => project.id === projectPreviewId)
            ?.sources ?? []);
  const projectFilePreviewRouting = resolveRootComposeProjectFileRouting({
    fileOpenerSource,
    selectedEnvironmentId: rootPanelEnvironmentId,
    selectedHostId: rootProjectHostId,
  });
  const projectSourceRoutingHostId =
    projectFilePreviewRouting.environmentId === null
      ? (projectFilePreviewRouting.hostId ?? primaryHostId)
      : null;
  const projectPreviewRootPath =
    projectPreviewId === null
      ? null
      : projectFilePreviewRouting.environmentId !== null
        ? (environment?.path ?? null)
        : projectSourceRoutingHostId !== null
          ? (findLocalPathProjectSourceForHost(
              previewProjectSources,
              projectSourceRoutingHostId,
            )?.path ?? null)
          : null;
  const projectPreviewHostId =
    projectPreviewRootPath === null
      ? null
      : projectFilePreviewRouting.environmentId !== null
        ? (environment?.hostId ?? null)
        : projectSourceRoutingHostId;
  const { isLocalDaemonHost } = useHostDaemon();
  const serverOrigin = window.location.origin;
  const environmentOpenContext = resolveEnvironmentOpenContext({
    environment,
    threadEnvironmentIsLocal: environment
      ? isLocalDaemonHost(environment.hostId)
      : false,
    serverOrigin,
  });
  const projectOpenContext = resolveHostOpenContext({
    hostId: projectPreviewHostId,
    isLocal: isLocalDaemonHost(projectPreviewHostId),
    serverOrigin,
  });
  const openContext =
    tab.kind === "workspace-file-preview" && tab.environmentId === null
      ? projectOpenContext
      : environmentOpenContext;
  const { canOpenPreferredFileTarget, openPathInPreferredFileTarget } =
    useLocalOpenTargets({
      enabled: openContext !== null,
      ...(openContext ? { openContext } : {}),
    });
  const workspaceRootPath = environment?.path ?? null;
  const relativeFileRootPath =
    tab.kind === "workspace-file-preview"
      ? tab.environmentId === null
        ? projectPreviewRootPath
        : workspaceRootPath
      : tab.kind === "thread-storage-file-preview"
        ? threadStorageRootPath
        : null;
  const openRelativeFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: relativeFileRootPath,
        canOpenPreferredTarget: canOpenPreferredFileTarget,
        openInPreferredTarget: openPathInPreferredFileTarget,
      }),
    [
      canOpenPreferredFileTarget,
      openPathInPreferredFileTarget,
      relativeFileRootPath,
    ],
  );
  const hostFileLineNumber = getFilePreviewLineRangeStart({
    lineRange: tab.kind === "host-file-preview" ? tab.lineRange : null,
  });
  const openHostFileInEditor =
    tab.kind === "host-file-preview" && canOpenPreferredFileTarget
      ? (path: string) => {
          void openPathInPreferredFileTarget({
            lineNumber: hostFileLineNumber,
            path,
          });
        }
      : undefined;
  const onOpenInEditor =
    tab.kind === "host-file-preview"
      ? openHostFileInEditor
      : openRelativeFileInEditor;

  useAppCommandHandler("workspace.openPreferred", () => {
    if (!isFocused || onOpenInEditor === undefined) return false;
    onOpenInEditor(tab.path);
    return true;
  });

  let original: ReactNode;
  switch (tab.kind) {
    case "workspace-file-preview": {
      const copyPath = resolveAbsoluteFilePath({
        path: tab.path,
        rootPath:
          tab.environmentId === null
            ? projectPreviewRootPath
            : workspaceRootPath,
      });
      original =
        tab.environmentId !== null ? (
          <LazyWorkspaceFilePreviewTabContent
            activePath={tab.path}
            copyPath={copyPath}
            environmentId={tab.environmentId}
            isPanelOpen={isPanelOpen}
            lineRange={tab.lineRange}
            onOpenInEditor={onOpenInEditor}
            onSelectionAddToChat={onSelectionAddToChat}
            source={tab.source}
            statusLabel={tab.statusLabel}
            threadId={rootPanelThreadId}
          />
        ) : projectPreviewId !== null ? (
          <LazyProjectFilePreviewTabContent
            activePath={tab.path}
            copyPath={copyPath}
            environmentId={projectFilePreviewRouting.environmentId}
            hostId={projectFilePreviewRouting.hostId}
            isPanelOpen={isPanelOpen}
            lineRange={tab.lineRange}
            onOpenInEditor={onOpenInEditor}
            onSelectionAddToChat={onSelectionAddToChat}
            projectId={projectPreviewId}
          />
        ) : (
          <LazyFilePreview
            path={tab.path}
            copyPath={copyPath}
            onOpenInEditor={onOpenInEditor}
            state={{ kind: "loading" }}
          />
        );
      break;
    }
    case "host-file-preview": {
      const threadId =
        fileOpenerSource === null
          ? (tab.threadId ?? rootPanelThreadId)
          : fileOpenerSource.threadId;
      original =
        threadId && environmentId ? (
          <LazyHostFilePreviewTabContent
            activePath={tab.path}
            copyPath={tab.path}
            environmentId={environmentId}
            isPanelOpen={isPanelOpen}
            lineRange={tab.lineRange}
            onOpenInEditor={onOpenInEditor}
            onSelectionAddToChat={onSelectionAddToChat}
            threadId={threadId}
          />
        ) : (
          <LazyFilePreview
            path={tab.path}
            copyPath={tab.path}
            onOpenInEditor={onOpenInEditor}
            state={{ kind: "loading" }}
          />
        );
      break;
    }
    case "thread-storage-file-preview": {
      const copyPath = resolveAbsoluteFilePath({
        path: tab.path,
        rootPath: threadStorageRootPath,
      });
      original = storageThreadId ? (
        <LazyThreadStorageFilePreviewTabContent
          activePath={tab.path}
          copyPath={copyPath}
          isPanelOpen={isPanelOpen}
          lineRange={tab.lineRange}
          onOpenInEditor={onOpenInEditor}
          onSelectionAddToChat={onSelectionAddToChat}
          threadId={storageThreadId}
        />
      ) : (
        <LazyFilePreview
          path={tab.path}
          copyPath={copyPath}
          onOpenInEditor={onOpenInEditor}
          state={{ kind: "loading" }}
        />
      );
      break;
    }
  }

  return pluginPanelTab === undefined ? (
    original
  ) : (
    <PluginPanelTabContent
      tab={pluginPanelTab}
      context={{
        kind: "new-thread",
        projectId: isProjectless ? null : currentProjectId,
      }}
      fileOpenerOriginal={original}
    />
  );
}
