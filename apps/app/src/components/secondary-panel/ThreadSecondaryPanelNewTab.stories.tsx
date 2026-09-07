import { useCallback, useMemo, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type {
  ThreadStoragePathListResponse,
  WorkspacePathEntry,
  WorkspacePathListResponse,
} from "@bb/server-contract";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { WithDesktopBrowser } from "../../../.ladle/story-desktop";
import { createAppQueryClient } from "@/lib/query-client";
import {
  environmentPathsQueryKey,
  threadStoragePathsQueryKey,
} from "@/hooks/queries/query-keys";
import { ThreadSecondaryPanel } from "./ThreadSecondaryPanel";
import type { SecondaryPanelRenderableTab } from "./ThreadSecondaryPanel";
import { NewTabPage } from "./NewTabPage";
import type { FileSearchSelection } from "./useThreadFileTabs";
import { Icon } from "@bb/shared-ui/icon";
import {
  getThreadRecentItemsStorageKey,
  type ThreadRecentItem,
} from "./threadRecentItems";
import {
  createNewTabFixedPanelTab,
  createTerminalFixedPanelTab,
  type SecondaryFileFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  getFileNameFromPath,
  resolveRightPanelFileVisual,
} from "./rightPanelFileVisuals";
import {
  resolveTerminalHost,
  TerminalHostSelector,
} from "./TerminalHostSelector";

export default {
  title: "right-panel/New tab",
};

const PROJECT_ID = "proj_bb";
const ENVIRONMENT_ID = "env_open_file_story";
const STORY_SOURCE_LIMIT = 40;
const BLANK_THREAD_ID = "thr_new_tab_blank_story";
const SINGLE_HOST_THREAD_ID = "thr_new_tab_single_host_story";
const MULTIPLE_HOSTS_THREAD_ID = "thr_new_tab_multiple_hosts_story";
const RECENTS_THREAD_ID = "thr_new_tab_recents_story";
const LONG_RECENTS_THREAD_ID = "thr_new_tab_long_recents_story";
const SEARCH_THREAD_ID = "thr_new_tab_search_story";
const STORY_TERMINAL_ID = "term_new_tab_story";

const MAC_STUDIO = makeHost({
  id: "host_mac_studio",
  name: "Mac Studio",
});
const MACBOOK_PRO = makeHost({
  ...MAC_STUDIO,
  id: "host_macbook_pro",
  name: "MacBook Pro",
});
const BUILD_SERVER = makeHost({
  ...MAC_STUDIO,
  id: "host_build_server",
  name: "Build server",
  status: "disconnected",
});

const noop = () => {};

const WORKSPACE_PATH_RESULTS: WorkspacePathEntry[] = [
  {
    kind: "file",
    path: "apps/app/src/views/thread-detail/ThreadDetailView.tsx",
    name: "ThreadDetailView.tsx",
    score: 94,
    positions: [18, 19, 20, 21, 22, 23],
  },
  {
    kind: "file",
    path: "apps/app/src/components/right-panel/ThreadSecondaryPanel.stories.tsx",
    name: "ThreadSecondaryPanel.stories.tsx",
    score: 88,
    positions: [40, 41, 42, 43, 44, 45],
  },
  {
    kind: "file",
    path: "apps/app/src/components/right-panel/ThreadSecondaryPanelNewTab.stories.tsx",
    name: "ThreadSecondaryPanelNewTab.stories.tsx",
    score: 72,
    positions: [43, 44, 45, 46, 47, 48],
  },
];

const THREAD_STORAGE_PATH_RESULTS: WorkspacePathEntry[] = [
  {
    kind: "file",
    path: "notes/thread-handoff.md",
    name: "thread-handoff.md",
    score: 91,
    positions: [6, 7, 8, 9, 10, 11],
  },
  {
    kind: "file",
    path: "artifacts/thread-summary.json",
    name: "thread-summary.json",
    score: 83,
    positions: [10, 11, 12, 13, 14, 15],
  },
];

const RECENT_ROW_ITEMS: ThreadRecentItem[] = [
  {
    source: "thread-storage",
    path: "plans/story-launch-plan.md",
    openedAt: Date.now() - 2 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "plans/story-dashboard-mockup.html",
    openedAt: Date.now() - 45 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "reports/story-adoption-report.html",
    openedAt: Date.now() - 3 * 60 * 60 * 1000,
  },
  {
    source: "workspace",
    path: "apps/app/src/components/right-panel/story-source.tsx",
    openedAt: Date.now() - 25 * 60 * 60 * 1000,
  },
];

const LONG_RECENT_ROW_ITEMS: ThreadRecentItem[] = [
  {
    source: "thread-storage",
    path: "plans/launch-readiness.md",
    openedAt: Date.now() - 2 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "plans/ux-research-synthesis.md",
    openedAt: Date.now() - 18 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "mockups/new-tab-overflow.html",
    openedAt: Date.now() - 42 * 60 * 1000,
  },
  {
    source: "workspace",
    path: "apps/app/src/components/secondary-panel/NewTabPage.tsx",
    openedAt: Date.now() - 2 * 60 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "reports/search-behavior-review.md",
    openedAt: Date.now() - 4 * 60 * 60 * 1000,
  },
  {
    source: "workspace",
    path: "apps/app/src/components/secondary-panel/NewTabFileSearch.tsx",
    openedAt: Date.now() - 6 * 60 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "artifacts/browser-entrypoint-demo.html",
    openedAt: Date.now() - 9 * 60 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "plans/app-launcher-taxonomy.md",
    openedAt: Date.now() - 12 * 60 * 60 * 1000,
  },
  {
    source: "workspace",
    path: "apps/app/src/views/thread-detail/ThreadDetailView.tsx",
    openedAt: Date.now() - 23 * 60 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "reports/right-panel-qa-notes.md",
    openedAt: Date.now() - 30 * 60 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "mockups/terminal-action-state.html",
    openedAt: Date.now() - 40 * 60 * 60 * 1000,
  },
  {
    source: "workspace",
    path: "apps/app/src/components/right-panel/ThreadSecondaryPanelNewTab.stories.tsx",
    openedAt: Date.now() - 52 * 60 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "plans/browser-default-page.md",
    openedAt: Date.now() - 64 * 60 * 60 * 1000,
  },
  {
    source: "thread-storage",
    path: "reports/new-tab-metrics.md",
    openedAt: Date.now() - 80 * 60 * 60 * 1000,
  },
];

interface PanelStageProps {
  children: ReactNode;
  presentation?: "card" | "sidebar";
}

interface NewTabPanelStoryProps {
  currentThreadId: string;
  initialQuery: string;
  projectId: string | undefined;
  recentItems: readonly ThreadRecentItem[];
  showOpenBrowser: boolean;
  threadStoragePaths: readonly WorkspacePathEntry[];
  workspacePaths: readonly WorkspacePathEntry[];
  presentation?: "card" | "sidebar";
  terminalHosts?: readonly Host[];
}

type NewTabStoryOutcome =
  | { kind: "file"; selection: FileSearchSelection }
  | { kind: "browser" }
  | { kind: "terminal"; hostName: string | null };

function createStoryActiveTab(
  outcome: NewTabStoryOutcome | null,
  currentThreadId: string,
): SecondaryFileFixedPanelTab {
  if (outcome === null) {
    return createNewTabFixedPanelTab();
  }

  if (outcome.kind === "browser") {
    return {
      environmentId: null,
      id: "browser:story:none",
      kind: "browser",
      title: null,
      url: "",
    };
  }

  if (outcome.kind === "terminal") {
    return createTerminalFixedPanelTab({ terminalId: STORY_TERMINAL_ID });
  }

  const { selection } = outcome;
  if (selection.source === "workspace") {
    return {
      environmentId: ENVIRONMENT_ID,
      id: `workspace:${selection.path}`,
      kind: "workspace-file-preview",
      lineRange: null,
      path: selection.path,
      projectId: null,
      source: { kind: "working-tree" },
      statusLabel: null,
    };
  }

  return {
    environmentId: ENVIRONMENT_ID,
    id: `thread-storage:${selection.path}`,
    isPinned: false,
    kind: "thread-storage-file-preview",
    lineRange: null,
    path: selection.path,
    threadId: currentThreadId,
  };
}

interface StoryQueryClientArgs {
  currentThreadId: string;
  initialQuery: string;
  threadStoragePaths: readonly WorkspacePathEntry[];
  workspacePaths: readonly WorkspacePathEntry[];
}

interface SeedThreadRecentItemsArgs {
  currentThreadId: string;
  recentItems: readonly ThreadRecentItem[];
}

interface SeededNewTabPageProps {
  currentThreadId: string;
  initialQuery: string;
  onOpenBrowser?: () => void;
  onSelect: (selection: FileSearchSelection) => void;
  onStartTerminal: () => void;
  projectId: string | undefined;
  recentItems: readonly ThreadRecentItem[];
  startTerminalDisabled?: boolean;
  startTerminalTrailing?: ReactNode;
}

function PanelStage({ children, presentation = "card" }: PanelStageProps) {
  return (
    <div
      className={
        presentation === "sidebar"
          ? "flex h-screen min-h-[640px] w-full max-w-[480px] min-w-0 flex-col overflow-hidden border-l border-border bg-sidebar"
          : "flex h-[380px] w-full max-w-[720px] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background"
      }
    >
      {children}
    </div>
  );
}

function makeWorkspacePathResponse(
  paths: readonly WorkspacePathEntry[],
): WorkspacePathListResponse {
  return {
    paths: [...paths],
    truncated: false,
  };
}

function makeThreadStoragePathResponse(
  paths: readonly WorkspacePathEntry[],
): ThreadStoragePathListResponse {
  return {
    paths: [...paths],
    storageRootPath: "/Users/michael/.bb-dev/thread-storage/thr_demo",
    truncated: false,
  };
}

function seedThreadRecentItems({
  currentThreadId,
  recentItems,
}: SeedThreadRecentItemsArgs): void {
  if (typeof window === "undefined" || currentThreadId.length === 0) {
    return;
  }

  const storageKey = getThreadRecentItemsStorageKey({
    threadId: currentThreadId,
  });
  if (recentItems.length === 0) {
    window.localStorage.removeItem(storageKey);
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(recentItems));
}

function useStoryQueryClient({
  currentThreadId,
  initialQuery,
  threadStoragePaths,
  workspacePaths,
}: StoryQueryClientArgs) {
  return useMemo(() => {
    const queryClient = createAppQueryClient({
      showMutationErrorToasts: false,
      defaultOptions: {
        mutations: {
          retry: false,
        },
        queries: {
          gcTime: Infinity,
          retry: false,
        },
      },
    });
    const query = initialQuery.trim();
    queryClient.setQueryData(
      environmentPathsQueryKey(
        ENVIRONMENT_ID,
        query,
        STORY_SOURCE_LIMIT,
        true,
        false,
      ),
      makeWorkspacePathResponse(workspacePaths),
    );
    queryClient.setQueryData(
      threadStoragePathsQueryKey(currentThreadId, {
        limit: STORY_SOURCE_LIMIT,
        query,
        includeFiles: true,
        includeDirectories: false,
      }),
      makeThreadStoragePathResponse(threadStoragePaths),
    );
    return queryClient;
  }, [currentThreadId, initialQuery, threadStoragePaths, workspacePaths]);
}

function SeededNewTabPage({
  currentThreadId,
  initialQuery,
  onOpenBrowser,
  onSelect,
  onStartTerminal,
  projectId,
  recentItems,
  startTerminalDisabled,
  startTerminalTrailing,
}: SeededNewTabPageProps) {
  seedThreadRecentItems({ currentThreadId, recentItems });

  return (
    <NewTabPage
      autoFocus={false}
      projectId={projectId}
      environmentId={ENVIRONMENT_ID}
      currentThreadId={currentThreadId}
      initialQuery={initialQuery}
      onAutoFocusHandled={() => undefined}
      onSelect={onSelect}
      onOpenBrowser={onOpenBrowser}
      onStartTerminal={onStartTerminal}
      startTerminalDisabled={startTerminalDisabled}
      startTerminalTrailing={startTerminalTrailing}
    />
  );
}

function NewTabPanelStory({
  currentThreadId,
  initialQuery,
  projectId,
  recentItems,
  showOpenBrowser,
  threadStoragePaths,
  workspacePaths,
  presentation,
  terminalHosts,
}: NewTabPanelStoryProps) {
  const [outcome, setOutcome] = useState<NewTabStoryOutcome | null>(null);
  const [preferredTerminalHostId, setPreferredTerminalHostId] = useState<
    string | null
  >(null);
  const selectedTerminalHost = resolveTerminalHost({
    hosts: terminalHosts ?? [],
    preferredHostId: preferredTerminalHostId,
    primaryHostId: terminalHosts?.[0]?.id ?? null,
  });
  const queryClient = useStoryQueryClient({
    currentThreadId,
    initialQuery,
    threadStoragePaths,
    workspacePaths,
  });
  const handleSelect = useCallback((selection: FileSearchSelection) => {
    setOutcome({ kind: "file", selection });
  }, []);
  const handleOpenBrowser = useCallback(() => {
    setOutcome({ kind: "browser" });
  }, []);
  const handleStartTerminal = useCallback(() => {
    setOutcome({
      kind: "terminal",
      hostName: selectedTerminalHost?.name ?? null,
    });
  }, [selectedTerminalHost]);
  const handleOpenNewTab = useCallback(() => {
    setOutcome(null);
  }, []);
  const activeTab = createStoryActiveTab(outcome, currentThreadId);
  const content =
    outcome === null ? (
      <QueryClientProvider client={queryClient}>
        <SeededNewTabPage
          currentThreadId={currentThreadId}
          initialQuery={initialQuery}
          projectId={projectId}
          recentItems={recentItems}
          onOpenBrowser={showOpenBrowser ? handleOpenBrowser : undefined}
          onSelect={handleSelect}
          onStartTerminal={handleStartTerminal}
          startTerminalDisabled={
            terminalHosts !== undefined &&
            selectedTerminalHost?.status !== "connected"
          }
          startTerminalTrailing={
            terminalHosts === undefined ? undefined : (
              <TerminalHostSelector
                disabled={false}
                hosts={terminalHosts}
                isLoading={false}
                onChange={setPreferredTerminalHostId}
                selectedHostId={selectedTerminalHost?.id ?? null}
              />
            )
          }
        />
      </QueryClientProvider>
    ) : outcome.kind === "browser" ? (
      <div className="flex min-h-full flex-col justify-center px-4 text-sm">
        <p className="font-medium text-foreground">Opened browser tab</p>
        <p className="pt-1 text-xs text-muted-foreground">
          A new in-panel web browser tab opens here (see the
          &ldquo;right-panel/Browser tab&rdquo; story).
        </p>
      </div>
    ) : outcome.kind === "terminal" ? (
      <div className="flex min-h-full flex-col justify-center bg-neutral-950 px-4 font-mono text-xs text-emerald-100">
        <p>$ bb terminal start</p>
        <p className="pt-1 text-emerald-300">
          Terminal tab opened from the New tab page
          {outcome.hostName === null ? "." : ` on ${outcome.hostName}.`}
        </p>
      </div>
    ) : (
      <div className="flex min-h-full flex-col justify-center px-4 text-sm">
        <p className="font-medium text-foreground">
          Selected{" "}
          {outcome.selection.source === "workspace"
            ? "workspace file"
            : "thread storage file"}
        </p>
        <p className="pt-1 font-mono text-xs text-muted-foreground">
          {outcome.selection.path}
        </p>
      </div>
    );
  const panelTab: SecondaryPanelRenderableTab = {
    contentFillsRegion: outcome?.kind === "terminal",
    label:
      outcome === null
        ? "New tab"
        : outcome.kind === "browser"
          ? "Browser"
          : outcome.kind === "terminal"
            ? "Terminal"
            : getFileNameFromPath({ path: outcome.selection.path }),
    leadingVisual:
      outcome === null ? (
        <Icon name="NewTab" className="size-3.5" aria-hidden />
      ) : outcome.kind === "browser" ? (
        <Icon name="Globe" className="size-3.5" aria-hidden />
      ) : outcome.kind === "terminal" ? (
        <Icon name="Terminal" className="size-3.5" aria-hidden />
      ) : (
        <Icon
          name={
            resolveRightPanelFileVisual({ path: outcome.selection.path })
              .iconName
          }
          className="size-3.5"
          aria-hidden
        />
      ),
    onClose: outcome === null ? noop : () => setOutcome(null),
    onSelect: noop,
    renderContent: () => content,
    statusLabel: null,
    tab: activeTab,
  };

  return (
    <PanelStage presentation={presentation}>
      <ThreadSecondaryPanel
        activeTab={activeTab}
        canUseGitUi
        requestedMergeBaseBranch="main"
        environmentId={ENVIRONMENT_ID}
        tabs={[panelTab]}
        fixedTabs={[]}
        isOpen
        metadataContent={null}
        onCollapse={noop}
        onClose={noop}
        onTabReorder={noop}
        onOpenNewTab={handleOpenNewTab}
        onPanelFocus={noop}
        isConversationCollapsed={false}
        onToggleConversationCollapse={noop}
        renderAsDrawer
      />
    </PanelStage>
  );
}

export function CollapseControl() {
  return (
    <WithDesktopBrowser>
      <div className="flex min-h-screen w-full justify-end bg-background">
        <NewTabPanelStory
          currentThreadId={BLANK_THREAD_ID}
          initialQuery=""
          projectId={PROJECT_ID}
          recentItems={[]}
          showOpenBrowser
          threadStoragePaths={[]}
          workspacePaths={[]}
          presentation="sidebar"
        />
      </div>
    </WithDesktopBrowser>
  );
}

export function NewTab() {
  return (
    <WithDesktopBrowser>
      <StoryCard>
        <StoryRow
          label="default"
          hint="stable launcher: empty Recent and Actions"
        >
          <NewTabPanelStory
            currentThreadId={BLANK_THREAD_ID}
            initialQuery=""
            projectId={PROJECT_ID}
            recentItems={[]}
            showOpenBrowser
            threadStoragePaths={[]}
            workspacePaths={[]}
          />
        </StoryRow>
        <StoryRow
          label="one machine"
          hint="the terminal action shows its only machine as a quiet value"
        >
          <NewTabPanelStory
            currentThreadId={SINGLE_HOST_THREAD_ID}
            initialQuery=""
            projectId={PROJECT_ID}
            recentItems={[]}
            showOpenBrowser
            terminalHosts={[MAC_STUDIO]}
            threadStoragePaths={[]}
            workspacePaths={[]}
          />
        </StoryRow>
        <StoryRow
          label="multiple machines"
          hint="the terminal action includes a compact machine selector"
        >
          <NewTabPanelStory
            currentThreadId={MULTIPLE_HOSTS_THREAD_ID}
            initialQuery=""
            projectId={PROJECT_ID}
            recentItems={[]}
            showOpenBrowser
            terminalHosts={[MAC_STUDIO, MACBOOK_PRO, BUILD_SERVER]}
            threadStoragePaths={[]}
            workspacePaths={[]}
          />
        </StoryRow>
        <StoryRow
          label="recents"
          hint="recent rows with browser and terminal actions"
        >
          <NewTabPanelStory
            currentThreadId={RECENTS_THREAD_ID}
            initialQuery=""
            projectId={PROJECT_ID}
            recentItems={RECENT_ROW_ITEMS}
            showOpenBrowser
            threadStoragePaths={[]}
            workspacePaths={[]}
          />
        </StoryRow>
        <StoryRow
          label="long recents"
          hint="fourteen recent entries; expand with Show 8 more"
        >
          <NewTabPanelStory
            currentThreadId={LONG_RECENTS_THREAD_ID}
            initialQuery=""
            projectId={PROJECT_ID}
            recentItems={LONG_RECENT_ROW_ITEMS}
            showOpenBrowser
            threadStoragePaths={[]}
            workspacePaths={[]}
          />
        </StoryRow>
        <StoryRow label="search results" hint="typed search shows file results">
          <NewTabPanelStory
            currentThreadId={SEARCH_THREAD_ID}
            initialQuery="review"
            projectId={PROJECT_ID}
            recentItems={RECENT_ROW_ITEMS}
            showOpenBrowser
            threadStoragePaths={THREAD_STORAGE_PATH_RESULTS}
            workspacePaths={WORKSPACE_PATH_RESULTS}
          />
        </StoryRow>
      </StoryCard>
    </WithDesktopBrowser>
  );
}
