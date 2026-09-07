import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { PanelGroup } from "react-resizable-panels";
import {
  ThreadSecondaryPanel,
  type SecondaryPanelFixedTab,
  type SecondaryPanelRenderableTab,
} from "./ThreadSecondaryPanel";
import type { ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import { Icon } from "@bb/shared-ui/icon";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  createGitDiffFixedPanelTab,
  createTerminalFixedPanelTab,
  createThreadInfoFixedPanelTab,
  type HostFilePreviewFixedPanelTab,
  type SecondaryFileFixedPanelTab,
  type SecondaryFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  createSidebarSplitState,
  moveSidebarTab,
  serializeSidebarSplitState,
  sidebarSplitStorageKey,
} from "./sidebarSplitLayout";
import type { WorkspaceFile } from "@bb/server-contract";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  ThreadMetadataContent,
  type ThreadMetadataContentProps,
} from "./ThreadMetadataContent";
import {
  baseProps as baseMetadataProps,
  makePullRequest,
  makeWorkspaceStatus,
} from "./ThreadMetadataContent.fixtures";
import { resolveRightPanelFileVisual } from "./rightPanelFileVisuals";
import { useThreadStorageBrowser } from "./useThreadStorageBrowser";
import { FilePreview } from "./FilePreview";
import { threadListQueryKey } from "@/hooks/queries/query-keys";

export default {
  title: "right-panel/Tabbed shell",
};

const noop = () => {};

function createStoryFixedPanelTab(
  panel: ThreadSecondaryPanelTab,
): SecondaryFixedPanelTab {
  return panel === "git-diff"
    ? createGitDiffFixedPanelTab()
    : createThreadInfoFixedPanelTab();
}

function createStoryFixedTabs(
  onSelectPanel: (panel: ThreadSecondaryPanelTab) => void,
  includeGitDiffTab = true,
): readonly SecondaryPanelFixedTab[] {
  return [
    {
      ariaLabel: "Show thread info panel",
      label: "Info",
      leadingVisual: <Icon name="Info" />,
      onSelect: () => onSelectPanel("thread-info"),
      tab: createThreadInfoFixedPanelTab(),
      title: "Thread info",
    },
    ...(includeGitDiffTab
      ? [
          {
            ariaLabel: "Show diff panel",
            label: "Diff",
            leadingVisual: <Icon name="FileDiff" />,
            onSelect: () => onSelectPanel("git-diff"),
            tab: createGitDiffFixedPanelTab(),
            title: "Diff",
          },
        ]
      : []),
  ];
}

function createStoryFileTab(path: string): HostFilePreviewFixedPanelTab {
  return {
    environmentId: "env_story",
    hostId: "host_story",
    id: `host-file-preview:${encodeURIComponent(path)}:thread%3Athr_story%3Aenvironment%3Aenv_story`,
    kind: "host-file-preview",
    lineRange: null,
    path,
    threadId: "thr_story",
  };
}

function PanelStage({
  children,
  height = "compact",
  width = "wide",
}: {
  children: ReactNode;
  height?: "compact" | "info";
  width?: "wide" | "shelf";
}) {
  return (
    <div
      className={`flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background ${
        width === "shelf" ? "w-[299px]" : "w-full max-w-[640px]"
      } ${height === "info" ? "h-[520px]" : "h-[160px]"}`}
    >
      <PanelGroup direction="horizontal">{children}</PanelGroup>
    </div>
  );
}

interface PanelHarnessProps {
  initialPanel: ThreadSecondaryPanelTab;
  children: (
    panel: ThreadSecondaryPanelTab,
    setPanel: (panel: ThreadSecondaryPanelTab) => void,
  ) => ReactNode;
}

function PanelHarness({ initialPanel, children }: PanelHarnessProps) {
  const [panel, setPanel] = useState(initialPanel);
  useEffect(() => {
    setPanel(initialPanel);
  }, [initialPanel]);
  return children(panel, setPanel);
}

const INFO_STORAGE_FILES: readonly WorkspaceFile[] = [
  { path: "plans/sidebar-surface-qa.md", name: "sidebar-surface-qa.md" },
  { path: "reports/visual-regression.md", name: "visual-regression.md" },
  { path: "screenshots/right-panel-light.png", name: "right-panel-light.png" },
];

const INFO_COMMITS = [
  {
    sha: "48a1bd6700000000000000000000000000000000",
    shortSha: "48a1bd67",
    subject: "Match right panel surfaces to the themed sidebar",
    authorName: "Ada Lovelace",
    authoredAt: 1_785_733_200_000,
  },
  {
    sha: "e6cf24b100000000000000000000000000000000",
    shortSha: "e6cf24b1",
    subject: "Keep tab overflow controls visible",
    authorName: "Grace Hopper",
    authoredAt: 1_785_729_600_000,
  },
];

const representativeWorkspaceStatus = makeWorkspaceStatus({
  workingTree: {
    hasUncommittedChanges: true,
    state: "dirty_and_committed_unmerged",
    insertions: 41,
    deletions: 12,
    lineStatsComplete: true,
    files: [
      {
        path: "apps/app/src/components/secondary-panel/ThreadSecondaryPanel.stories.tsx",
        status: "M",
        insertions: 34,
        deletions: 8,
      },
      {
        path: "apps/app/src/components/secondary-panel/SecondaryPanelTabStrip.tsx",
        status: "M",
        insertions: 7,
        deletions: 4,
      },
    ],
  },
  mergeBase: {
    mergeBaseBranch: "main",
    baseRef: "main",
    aheadCount: INFO_COMMITS.length,
    behindCount: 0,
    hasCommittedUnmergedChanges: true,
    commits: INFO_COMMITS,
    insertions: 86,
    deletions: 19,
    lineStatsComplete: true,
    files: [
      {
        path: "apps/app/src/components/secondary-panel/ThreadSecondaryPanel.tsx",
        status: "M",
        insertions: 58,
        deletions: 11,
      },
      {
        path: "apps/app/src/components/secondary-panel/NewTabPage.tsx",
        status: "M",
        insertions: 28,
        deletions: 8,
      },
    ],
  },
});

function RepresentativeInfoContent() {
  const [selectedStoragePath, setSelectedStoragePath] = useState<string | null>(
    null,
  );
  const storageController = useThreadStorageBrowser({
    files: INFO_STORAGE_FILES,
    onSelectPath: setSelectedStoragePath,
    selectedPath: selectedStoragePath,
  });
  const props: ThreadMetadataContentProps = {
    ...baseMetadataProps,
    pullRequest: makePullRequest({
      number: 947,
      title: "Use the sidebar surface throughout the right panel",
    }),
    selectedMergeBaseBranch: "main",
    workspaceStatus: representativeWorkspaceStatus,
    storage: {
      controller: storageController,
      filesError: null,
      isFilesLoading: false,
    },
    onCommitClick: noop,
  };
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      threadListQueryKey({
        projectId: props.thread.projectId,
        sourceThreadId: props.thread.id,
        originKind: "fork",
        archived: false,
      }),
      [],
    );
    return client;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <ThreadMetadataContent {...props} />
    </QueryClientProvider>
  );
}

interface ShellArgs {
  initialPanel: ThreadSecondaryPanelTab;
  includeGitDiffTab?: boolean;
  canUseGitUi?: boolean;
}

function ShellRow({
  initialPanel,
  includeGitDiffTab = true,
  canUseGitUi = true,
}: ShellArgs) {
  return (
    <PanelHarness initialPanel={initialPanel}>
      {(panel, setPanel) => (
        <PanelStage height="info">
          <ThreadSecondaryPanel
            activeTab={createStoryFixedPanelTab(panel)}
            canUseGitUi={canUseGitUi}
            requestedMergeBaseBranch="main"
            environmentId={undefined}
            isOpen
            metadataContent={<RepresentativeInfoContent />}
            fixedTabs={createStoryFixedTabs(setPanel, includeGitDiffTab)}
            tabs={[]}
            onPanelFocus={noop}
            onCollapse={noop}
            onClose={noop}
            onTabReorder={noop}
            onOpenNewTab={noop}
            isConversationCollapsed={false}
            onToggleConversationCollapse={noop}
            renderAsDrawer={false}
            inlinePanelToggle="hidden"
            showConversationCollapseControl={false}
          />
        </PanelStage>
      )}
    </PanelHarness>
  );
}

const REPRESENTATIVE_FILE_SOURCE = `export function ThreadSecondaryPanel() {
  return <Panel className="bg-sidebar">…</Panel>;
}`;

function RepresentativeFileContent({ path }: { path: string }) {
  return (
    <FilePreview
      path={path}
      state={{
        kind: "ready",
        lineRange: null,
        textPreviewKind: null,
        file: {
          cacheKey: `thread-secondary-panel-story:${path}`,
          name: path.split("/").at(-1) ?? path,
          contents: REPRESENTATIVE_FILE_SOURCE,
        },
      }}
    />
  );
}

interface TerminalTabFixture {
  terminalId: string;
  title: string;
  statusLabel: string | null;
}

interface RepresentativeTerminalContentProps {
  title: string;
}

const TERMINAL_TABS: TerminalTabFixture[] = [
  { terminalId: "term_story_running", title: "pnpm dev", statusLabel: null },
  {
    terminalId: "term_story_starting",
    title: "install",
    statusLabel: "starting",
  },
];

function RepresentativeTerminalContent({
  title,
}: RepresentativeTerminalContentProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950 px-3 py-2 font-mono text-xs text-emerald-100">
      <p>$ {title}</p>
      <p className="pt-1 text-emerald-300">Tests passed in 1.8s.</p>
    </div>
  );
}

const MANY_TAB_FILENAMES: string[] = [
  "ThreadSecondaryPanel.tsx",
  "SecondaryPanelTabStrip.tsx",
  "CompactSecondaryPanelShelf.tsx",
  "useGitDiffPanelState.ts",
  "api.ts",
  "ThreadDetailHeader.tsx",
  "ThreadStorageBrowser.tsx",
  "RootComposeMobileRecents.tsx",
  "sidebar.tsx",
  "theme.css",
  "app.css",
  "package.json",
  "README.md",
  "use-compact-viewport.ts",
  "provider-registry.ts",
  "schema.sql",
  "an-unusually-long-component-filename-that-must-truncate.tsx",
  "index.ts",
];

interface FileTabsShellRowProps {
  filenames: string[];
  initialActiveFilename: string | null;
  pinnedFilename?: string;
  renderAsDrawer?: boolean;
  stage?: "wide" | "shelf";
}

function FileTabsShellInner({
  filenames,
  initialActiveFilename,
  pinnedFilename,
  renderAsDrawer = false,
  stage = "wide",
}: FileTabsShellRowProps) {
  const [activeFixedTab, setActiveFixedTab] = useState<SecondaryFixedPanelTab>(
    createThreadInfoFixedPanelTab(),
  );
  const [openFiles, setOpenFiles] = useState<string[]>(filenames);
  const [activeFilename, setActiveFilename] = useState<string | null>(
    initialActiveFilename,
  );
  const activeTab =
    activeFilename === null
      ? activeFixedTab
      : createStoryFileTab(activeFilename);

  const handleCloseFile = useCallback(
    (filename: string) => {
      if (filename === pinnedFilename) return;
      setOpenFiles((prev) => prev.filter((name) => name !== filename));
      setActiveFilename((prev) => (prev === filename ? null : prev));
    },
    [pinnedFilename],
  );

  const panelTabs = useMemo<SecondaryPanelRenderableTab[]>(
    () =>
      openFiles.map((filename) => {
        const tab = createStoryFileTab(filename);
        const visual = resolveRightPanelFileVisual({ path: filename });
        return {
          label: filename,
          isPinned: filename === pinnedFilename,
          leadingVisual: (
            <Icon name={visual.iconName} className="size-3.5" aria-hidden />
          ),
          statusLabel: null,
          onSelect: () => setActiveFilename(filename),
          onClose: () => handleCloseFile(filename),
          renderContent: () => <RepresentativeFileContent path={filename} />,
          tab,
        };
      }),
    [openFiles, handleCloseFile, pinnedFilename],
  );

  return (
    <PanelStage
      width={stage}
      height={stage === "shelf" ? "info" : "compact"}
    >
      <ThreadSecondaryPanel
        activeTab={activeTab}
        canUseGitUi
        requestedMergeBaseBranch="main"
        environmentId={undefined}
        isOpen
        metadataContent={<RepresentativeInfoContent />}
        tabs={panelTabs}
        fixedTabs={createStoryFixedTabs((panel) => {
          setActiveFilename(null);
          setActiveFixedTab(createStoryFixedPanelTab(panel));
        })}
        onPanelFocus={noop}
        onCollapse={noop}
        onClose={noop}
        onTabReorder={noop}
        onOpenNewTab={noop}
        isConversationCollapsed={false}
        onToggleConversationCollapse={noop}
        renderAsDrawer={renderAsDrawer}
        inlinePanelToggle="hidden"
        showConversationCollapseControl={false}
      />
    </PanelStage>
  );
}

function FileTabsShellRow(props: FileTabsShellRowProps) {
  return <FileTabsShellInner {...props} />;
}

interface TerminalTabsShellRowProps {
  initialActiveTerminalId: string;
  terminals: readonly TerminalTabFixture[];
}

function TerminalTabsShellInner({
  initialActiveTerminalId,
  terminals,
}: TerminalTabsShellRowProps) {
  const [openTerminals, setOpenTerminals] =
    useState<readonly TerminalTabFixture[]>(terminals);
  const [activeFixedTab, setActiveFixedTab] = useState<SecondaryFixedPanelTab>(
    createThreadInfoFixedPanelTab(),
  );
  const [activeTerminalId, setActiveTerminalId] = useState(
    initialActiveTerminalId,
  );
  useEffect(() => {
    setOpenTerminals(terminals);
    setActiveTerminalId(initialActiveTerminalId);
  }, [initialActiveTerminalId, terminals]);
  const activeTerminal =
    openTerminals.find(
      (terminal) => terminal.terminalId === activeTerminalId,
    ) ?? null;
  const activeTab =
    activeTerminal === null
      ? activeFixedTab
      : createTerminalFixedPanelTab({
          terminalId: activeTerminal.terminalId,
        });

  const handleCloseTerminal = useCallback(
    (terminalId: string) => {
      setOpenTerminals((prev) =>
        prev.filter((terminal) => terminal.terminalId !== terminalId),
      );
      setActiveTerminalId((prev) => {
        if (prev !== terminalId) {
          return prev;
        }
        return (
          openTerminals.find((terminal) => terminal.terminalId !== terminalId)
            ?.terminalId ?? ""
        );
      });
    },
    [openTerminals],
  );

  const panelTabs = useMemo<SecondaryPanelRenderableTab[]>(
    () =>
      openTerminals.map((terminal) => {
        const tab = createTerminalFixedPanelTab({
          terminalId: terminal.terminalId,
        });
        return {
          contentFillsRegion: true,
          label: terminal.title,
          leadingVisual: (
            <Icon name="Terminal" className="size-3.5" aria-hidden />
          ),
          statusLabel: terminal.statusLabel,
          onSelect: () => setActiveTerminalId(terminal.terminalId),
          onClose: () => handleCloseTerminal(terminal.terminalId),
          renderContent: () => (
            <RepresentativeTerminalContent title={terminal.title} />
          ),
          tab,
        };
      }),
    [handleCloseTerminal, openTerminals],
  );

  return (
    <PanelStage>
      <ThreadSecondaryPanel
        activeTab={activeTab}
        canUseGitUi
        requestedMergeBaseBranch="main"
        environmentId={undefined}
        isOpen
        metadataContent={<RepresentativeInfoContent />}
        tabs={panelTabs}
        fixedTabs={createStoryFixedTabs((panel) => {
          setActiveTerminalId("");
          setActiveFixedTab(createStoryFixedPanelTab(panel));
        })}
        onPanelFocus={noop}
        onCollapse={noop}
        onClose={noop}
        onTabReorder={noop}
        onOpenNewTab={noop}
        isConversationCollapsed={false}
        onToggleConversationCollapse={noop}
        renderAsDrawer={false}
        inlinePanelToggle="hidden"
        showConversationCollapseControl={false}
      />
    </PanelStage>
  );
}

function TerminalTabsShellRow(props: TerminalTabsShellRowProps) {
  return <TerminalTabsShellInner {...props} />;
}

const SPLIT_STORY_PANEL_STATE_ID = "ladle-production-split-panes";
const SPLIT_STORY_FILE = createStoryFileTab("ThreadSecondaryPanel.tsx");
const SPLIT_STORY_TERMINAL = createTerminalFixedPanelTab({
  terminalId: "term_story_running",
});
const SPLIT_STORY_FILE_TABS: readonly SecondaryFileFixedPanelTab[] = [
  SPLIT_STORY_FILE,
  SPLIT_STORY_TERMINAL,
];
const SPLIT_STORY_TABS: readonly SecondaryFixedPanelTab[] = [
  createThreadInfoFixedPanelTab(),
  createGitDiffFixedPanelTab(),
  ...SPLIT_STORY_FILE_TABS,
];

function createSplitStoryState() {
  let state = createSidebarSplitState(
    SPLIT_STORY_TABS.map((tab) => tab.id),
    createThreadInfoFixedPanelTab().id,
  );
  state = moveSidebarTab(
    state,
    "pane-primary",
    SPLIT_STORY_FILE.id,
    { paneId: "pane-primary", zone: "bottom" },
    { groupId: "group-file" },
  );
  return moveSidebarTab(
    state,
    "pane-primary",
    SPLIT_STORY_TERMINAL.id,
    { paneId: "pane-primary", zone: "right" },
    { groupId: "group-terminal" },
  );
}

function ProductionSplitPanesStory() {
  const [activeTab, setActiveTab] = useState<SecondaryFixedPanelTab>(() => {
    window.localStorage.setItem(
      sidebarSplitStorageKey(SPLIT_STORY_PANEL_STATE_ID),
      serializeSidebarSplitState(createSplitStoryState()),
    );
    return SPLIT_STORY_TERMINAL;
  });

  const panelTabs = useMemo<SecondaryPanelRenderableTab[]>(
    () =>
      [SPLIT_STORY_FILE, SPLIT_STORY_TERMINAL].map((tab) => ({
        contentFillsRegion: tab.kind === "terminal",
        label:
          tab.kind === "terminal" ? "pnpm dev" : "ThreadSecondaryPanel.tsx",
        leadingVisual: (
          <Icon
            name={tab.kind === "terminal" ? "Terminal" : "Code"}
            className="size-3.5"
            aria-hidden
          />
        ),
        statusLabel: null,
        onSelect: () => setActiveTab(tab),
        onClose: noop,
        renderContent: () =>
          tab.kind === "terminal" ? (
            <RepresentativeTerminalContent title="pnpm dev" />
          ) : (
            <RepresentativeFileContent path="ThreadSecondaryPanel.tsx" />
          ),
        tab,
      })),
    [],
  );

  return (
    <TooltipProvider>
      <SidebarProvider>
        <PanelStage height="info">
          <ThreadSecondaryPanel
            activeTab={activeTab}
            canUseGitUi
            requestedMergeBaseBranch="main"
            environmentId={undefined}
            isOpen
            metadataContent={<RepresentativeInfoContent />}
            tabs={panelTabs}
            fixedTabs={createStoryFixedTabs((panel) =>
              setActiveTab(createStoryFixedPanelTab(panel)),
            )}
            splitPanelStateId={SPLIT_STORY_PANEL_STATE_ID}
            onPanelFocus={noop}
            onCollapse={noop}
            onClose={noop}
            onTabReorder={noop}
            onOpenNewTab={noop}
            isConversationCollapsed={false}
            onToggleConversationCollapse={noop}
            renderAsDrawer={false}
            inlinePanelToggle="hidden"
            showConversationCollapseControl={false}
          />
        </PanelStage>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export function SplitPanes() {
  return (
    <StoryCard>
      <StoryRow
        label="production split panes"
        hint="real right-panel tabs, pane focus, arrangement, maximize, close, and inner divider behavior"
      >
        <ProductionSplitPanesStory />
      </StoryRow>
    </StoryCard>
  );
}

export function PhoneWidthTabs() {
  return (
    <StoryCard>
      <StoryRow
        label="phone-width panel — many tabs"
        hint="the panel body at 299px, the --secondary-panel-width-mobile value at a 393px viewport. Shelf and full-page geometry live in right-panel/Compact shelf; this row isolates the tab strip, which scrolls horizontally while Info and Diff stay fixed"
      >
        <FileTabsShellRow
          filenames={MANY_TAB_FILENAMES}
          initialActiveFilename="ThreadSecondaryPanel.tsx"
          renderAsDrawer
          stage="shelf"
        />
      </StoryRow>
      <StoryRow
        label="phone-width panel — active tab far down the row"
        hint="the strip should scroll the selected tab into view rather than leaving it offscreen"
      >
        <FileTabsShellRow
          filenames={MANY_TAB_FILENAMES}
          initialActiveFilename="an-unusually-long-component-filename-that-must-truncate.tsx"
          renderAsDrawer
          stage="shelf"
        />
      </StoryRow>
      <StoryRow
        label="phone-width panel — pinned first tab"
        hint="pinned tab keeps its slot with no close affordance while the rest scroll past it"
      >
        <FileTabsShellRow
          filenames={MANY_TAB_FILENAMES}
          pinnedFilename="ThreadSecondaryPanel.tsx"
          initialActiveFilename="theme.css"
          renderAsDrawer
          stage="shelf"
        />
      </StoryRow>
      <StoryRow
        label="phone-width panel — no file tab selected"
        hint="Info stays active while the file tabs sit alongside as inactive pills"
      >
        <FileTabsShellRow
          filenames={MANY_TAB_FILENAMES}
          initialActiveFilename={null}
          renderAsDrawer
          stage="shelf"
        />
      </StoryRow>
      <StoryRow
        label="wide — the same tabs for comparison"
        hint="same fixture at desktop width, so shelf-only truncation and scroll behavior is obvious"
      >
        <FileTabsShellRow
          filenames={MANY_TAB_FILENAMES}
          initialActiveFilename="ThreadSecondaryPanel.tsx"
        />
      </StoryRow>
    </StoryCard>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="thread"
        hint="tab strip shows Info + Diff (Diff is exercised in the right-panel/Diff story)"
      >
        <ShellRow initialPanel="thread-info" />
      </StoryRow>
      <StoryRow
        label="parent thread, info tab"
        hint="no Diff for this parent thread; workspace tree is rendered inside the info tab body"
      >
        <ShellRow initialPanel="thread-info" includeGitDiffTab={false} />
      </StoryRow>
      <StoryRow
        label="git UI disabled"
        hint="canUseGitUi=false hides the Diff tab and falls back to Info"
      >
        <ShellRow initialPanel="thread-info" canUseGitUi={false} />
      </StoryRow>
      <StoryRow
        label="file tab selected"
        hint="active file tab renders its content; static tabs are unpressed"
      >
        <FileTabsShellRow
          filenames={[
            "ThreadSecondaryPanel.tsx",
            "useGitDiffPanelState.ts",
            "api.ts",
          ]}
          initialActiveFilename="ThreadSecondaryPanel.tsx"
        />
      </StoryRow>
      <StoryRow
        label="terminal tab selected"
        hint="Terminal is a right-panel tab; Info and Diff stay unpressed while terminal content fills the body"
      >
        <TerminalTabsShellRow
          terminals={TERMINAL_TABS}
          initialActiveTerminalId="term_story_running"
        />
      </StoryRow>
      <StoryRow
        label="file tabs open, none selected"
        hint="Info tab stays active while file tabs sit alongside as inactive pills"
      >
        <FileTabsShellRow
          filenames={["ThreadSecondaryPanel.tsx", "useGitDiffPanelState.ts"]}
          initialActiveFilename={null}
        />
      </StoryRow>
      <StoryRow
        label="pinned tab"
        hint="leftmost tab is pinned (no close X); other tabs render the close affordance as usual"
      >
        <FileTabsShellRow
          filenames={["Status", "useGitDiffPanelState.ts"]}
          pinnedFilename="Status"
          initialActiveFilename="Status"
        />
      </StoryRow>
      <StoryRow
        label="overflow — many tabs"
        hint="long filenames truncate; row scrolls horizontally"
      >
        <FileTabsShellRow
          filenames={[
            "ThreadSecondaryPanel.tsx",
            "useGitDiffPanelState.ts",
            "api.ts",
            "ThreadDetailHeader.tsx",
            "ThreadStorageBrowser.tsx",
          ]}
          initialActiveFilename="ThreadStorageBrowser.tsx"
        />
      </StoryRow>
    </StoryCard>
  );
}
