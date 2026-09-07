import { useState, type ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createGitDiffFixedPanelTab,
  createThreadInfoFixedPanelTab,
  type HostFilePreviewFixedPanelTab,
  type SecondaryFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  CompactHomePage,
  MOBILE_RECENTS_VISIBILITY_CLASS,
  MobileRecentsVisibilityStyle,
} from "@/views/mobile-home-story-fixtures";
import { CompactSecondaryPanelShelf } from "./CompactSecondaryPanelShelf";
import {
  ThreadSecondaryPanel,
  type SecondaryPanelRenderableTab,
} from "./ThreadSecondaryPanel";
import { ThreadMetadataContent } from "./ThreadMetadataContent";
import { baseProps as baseMetadataProps } from "./ThreadMetadataContent.fixtures";
import { FilePreview } from "./FilePreview";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { threadListQueryKey } from "@/hooks/queries/query-keys";

export default {
  title: "right-panel/Compact shelf",
};

const noop = () => {};

const STORY_FILE_PATH = "apps/app/src/views/RootComposeCompactHome.tsx";
const STORY_FILE_SOURCE = `export function RootComposeCompactHome({
  children,
  composer,
}: RootComposeCompactHomeProps) {
  const { regionRef, composerRef } = useCompactHomeMetrics();
  return (
    <div ref={regionRef} className="relative min-h-0 flex-1">
      {children}
      <div ref={composerRef}>{composer}</div>
    </div>
  );
}`;

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

const fileTab = createStoryFileTab(STORY_FILE_PATH);

const MANY_TAB_PATHS: string[] = [
  STORY_FILE_PATH,
  "apps/app/src/components/secondary-panel/SecondaryPanelTabStrip.tsx",
  "apps/app/src/components/secondary-panel/CompactSecondaryPanelShelf.tsx",
  "apps/app/src/hooks/queries/thread-queries.ts",
  "apps/app/src/components/ui/sidebar.tsx",
  "apps/app/src/components/ui/theme.css",
  "apps/app/src/app.css",
  "package.json",
  "README.md",
  "apps/server/src/services/providers/provider-registry.ts",
  "an-unusually-long-component-filename-that-must-truncate.tsx",
]

function StoryFileContent({ path }: { path: string }) {
  return (
    <FilePreview
      path={path}
      state={{
        kind: "ready",
        lineRange: null,
        textPreviewKind: null,
        file: {
          cacheKey: `compact-shelf-story:${path}`,
          name: path.split("/").at(-1) ?? path,
          contents: STORY_FILE_SOURCE,
        },
      }}
    />
  );
}

interface ShelfPanelProps {
  activeTab: SecondaryFixedPanelTab;
  onSelectTab: (tab: SecondaryFixedPanelTab) => void;
  onClose: () => void;
  filePaths?: string[];
}

function ShelfPanel({
  activeTab,
  onSelectTab,
  onClose,
  filePaths = [STORY_FILE_PATH],
}: ShelfPanelProps) {
  const tabs: SecondaryPanelRenderableTab[] = filePaths.map((path, index) => {
    const tab = path === STORY_FILE_PATH ? fileTab : createStoryFileTab(path);
    return {
      label: path.split("/").at(-1) ?? path,
      isPinned: index === 0 && filePaths.length > 1,
      leadingVisual: <Icon name="File" className="size-3.5" aria-hidden />,
      statusLabel: null,
      onSelect: () => onSelectTab(tab),
      onClose: noop,
      renderContent: () => <StoryFileContent path={path} />,
      tab,
    };
  });
  const infoTab = createThreadInfoFixedPanelTab();
  const diffTab = createGitDiffFixedPanelTab();

  return (
    <ThreadSecondaryPanel
      activeTab={activeTab}
      canUseGitUi
      requestedMergeBaseBranch="main"
      environmentId={undefined}
      isOpen
      metadataContent={<ThreadMetadataContent {...baseMetadataProps} />}
      tabs={tabs}
      fixedTabs={[
        {
          ariaLabel: "Show thread info panel",
          label: "Info",
          leadingVisual: <Icon name="Info" />,
          onSelect: () => onSelectTab(infoTab),
          tab: infoTab,
          title: "Thread info",
        },
        {
          ariaLabel: "Show diff panel",
          label: "Diff",
          leadingVisual: <Icon name="FileDiff" />,
          onSelect: () => onSelectTab(diffTab),
          tab: diffTab,
          title: "Diff",
        },
      ]}
      onPanelFocus={noop}
      onCollapse={noop}
      onClose={onClose}
      onTabReorder={noop}
      onOpenNewTab={noop}
      isConversationCollapsed={false}
      onToggleConversationCollapse={noop}
      renderAsDrawer
      inlinePanelToggle="hidden"
      showConversationCollapseControl={false}
    />
  );
}

function Stage({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      threadListQueryKey({
        projectId: baseMetadataProps.thread.projectId,
        sourceThreadId: baseMetadataProps.thread.id,
        originKind: "fork",
        archived: false,
      }),
      [],
    );
    return client;
  });
  return (
    <QueryClientProvider client={queryClient}>
      <div
        className={`${MOBILE_RECENTS_VISIBILITY_CLASS} fixed inset-0 flex flex-col bg-background`}
      >
        <MobileRecentsVisibilityStyle />
        <SidebarProvider defaultOpen={false} className="min-h-0">
          <SidebarInset className="min-h-0 overflow-hidden">
            <CompactHomePage />
          </SidebarInset>
          {children}
        </SidebarProvider>
      </div>
    </QueryClientProvider>
  );
}

function ShelfStory({
  initialPresentation,
}: {
  initialPresentation: "shelf" | "full";
}) {
  const [activeTab, setActiveTab] = useState<SecondaryFixedPanelTab>(
    initialPresentation === "shelf" ? createThreadInfoFixedPanelTab() : fileTab,
  );
  const [open, setOpen] = useState(true);
  const presentation = activeTab.kind === "thread-info" ? "shelf" : "full";

  return (
    <Stage>
      <CompactSecondaryPanelShelf
        open={open}
        onClose={() => setOpen(false)}
        presentation={presentation}
        srLabel="Right panel"
      >
        <ShelfPanel
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onClose={() => setOpen(false)}
        />
      </CompactSecondaryPanelShelf>
    </Stage>
  );
}

export function Shelf() {
  return <ShelfStory initialPresentation="shelf" />;
}

export function FullPage() {
  return <ShelfStory initialPresentation="full" />;
}

export function ManyTabs() {
  const [activeTab, setActiveTab] = useState<SecondaryFixedPanelTab>(fileTab);
  const presentation = activeTab.kind === "thread-info" ? "shelf" : "full";
  return (
    <Stage>
      <CompactSecondaryPanelShelf
        open
        onClose={noop}
        presentation={presentation}
        srLabel="Right panel"
      >
        <ShelfPanel
          activeTab={activeTab}
          filePaths={MANY_TAB_PATHS}
          onSelectTab={setActiveTab}
          onClose={noop}
        />
      </CompactSecondaryPanelShelf>
    </Stage>
  );
}

export function Closed() {
  return (
    <Stage>
      <CompactSecondaryPanelShelf
        open={false}
        onClose={noop}
        presentation="shelf"
        srLabel="Right panel"
      >
        <ShelfPanel
          activeTab={createThreadInfoFixedPanelTab()}
          onSelectTab={noop}
          onClose={noop}
        />
      </CompactSecondaryPanelShelf>
    </Stage>
  );
}
