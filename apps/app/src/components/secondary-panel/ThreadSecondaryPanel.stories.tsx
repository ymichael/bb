import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Provider as JotaiProvider, createStore, useSetAtom } from "jotai";
import {
  ThreadSecondaryPanel,
  type SecondaryPanelFileTab,
} from "./ThreadSecondaryPanel";
import { activeSecondaryPanelAtom } from "@/lib/thread-secondary-panel";
import type { ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "secondary-panel/Tabbed shell",
};

const noop = () => {};

// The panel renders inside a flex column; give it explicit height so the inner
// scroll regions get something to fill.
function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[160px] w-full max-w-[640px] min-w-0 flex-col overflow-hidden rounded-md border border-border/70 bg-background">
      {children}
    </div>
  );
}

// Each story instance gets its own jotai store so the active-panel atom is
// isolated from every other instance on the page.
function PanelHarness({
  initialPanel,
  children,
}: {
  initialPanel: ThreadSecondaryPanelTab;
  children: ReactNode;
}) {
  const store = useMemo(() => {
    const next = createStore();
    next.set(activeSecondaryPanelAtom, initialPanel);
    return next;
  }, [initialPanel]);
  return (
    <JotaiProvider store={store}>
      <ActivePanelSetter panel={initialPanel} />
      {children}
    </JotaiProvider>
  );
}

function ActivePanelSetter({ panel }: { panel: ThreadSecondaryPanelTab }) {
  const setActive = useSetAtom(activeSecondaryPanelAtom);
  useEffect(() => {
    setActive(panel);
  }, [panel, setActive]);
  return null;
}

const placeholderInfoContent = (
  <div className="space-y-2 pt-1 text-sm text-muted-foreground">
    <p>Info tab content (see "secondary-panel/Info" story for variants).</p>
  </div>
);

interface ShellArgs {
  initialPanel: ThreadSecondaryPanelTab;
  showGitDiffTab?: boolean;
  canUseGitUi?: boolean;
}

function ShellRow({
  initialPanel,
  showGitDiffTab = true,
  canUseGitUi = true,
}: ShellArgs) {
  return (
    <PanelHarness initialPanel={initialPanel}>
      <PanelStage>
        <ThreadSecondaryPanel
          canUseGitUi={canUseGitUi}
          defaultMergeBaseBranch="main"
          environmentId={undefined}
          metadataContent={placeholderInfoContent}
          showGitDiffTab={showGitDiffTab}
          onPanelChange={noop}
          onCollapse={noop}
          onClose={noop}
          renderAsDrawer
        />
      </PanelStage>
    </PanelHarness>
  );
}

const placeholderFileContent = (
  <div className="space-y-2 pt-1 text-sm text-muted-foreground">
    <p>File tab content placeholder.</p>
  </div>
);

interface FileTabsShellRowProps {
  filenames: string[];
  initialActiveFilename: string | null;
  pinnedFilename?: string;
}

function FileTabsShellInner({
  filenames,
  initialActiveFilename,
  pinnedFilename,
}: FileTabsShellRowProps) {
  const setActiveStaticPanel = useSetAtom(activeSecondaryPanelAtom);
  const [openFiles, setOpenFiles] = useState<string[]>(filenames);
  const [activeFilename, setActiveFilename] = useState<string | null>(
    initialActiveFilename,
  );

  const handleCloseFile = useCallback(
    (filename: string) => {
      if (filename === pinnedFilename) return;
      setOpenFiles((prev) => prev.filter((name) => name !== filename));
      setActiveFilename((prev) => (prev === filename ? null : prev));
    },
    [pinnedFilename],
  );

  const fileTabs = useMemo<SecondaryPanelFileTab[]>(
    () =>
      openFiles.map((filename) => ({
        id: filename,
        filename,
        isActive: filename === activeFilename,
        isPinned: filename === pinnedFilename,
        statusLabel: null,
        onSelect: () => setActiveFilename(filename),
        onClose: () => handleCloseFile(filename),
      })),
    [openFiles, activeFilename, handleCloseFile, pinnedFilename],
  );

  return (
    <PanelStage>
      <ThreadSecondaryPanel
        canUseGitUi
        defaultMergeBaseBranch="main"
        environmentId={undefined}
        metadataContent={placeholderInfoContent}
        fileTabs={fileTabs}
        fileTabContent={activeFilename ? placeholderFileContent : null}
        showGitDiffTab
        onPanelChange={(panel) => {
          setActiveFilename(null);
          setActiveStaticPanel(panel);
        }}
        onCollapse={noop}
        onClose={noop}
        renderAsDrawer
      />
    </PanelStage>
  );
}

function FileTabsShellRow(props: FileTabsShellRowProps) {
  return (
    <PanelHarness initialPanel="thread-info">
      <FileTabsShellInner {...props} />
    </PanelHarness>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="standard thread"
        hint="tab strip shows Info + Diff (Diff is exercised in the secondary-panel/Diff story)"
      >
        <ShellRow initialPanel="thread-info" />
      </StoryRow>
      <StoryRow
        label="manager thread, info tab"
        hint="no Diff for managers; workspace tree is rendered inside the info tab body"
      >
        <ShellRow initialPanel="thread-info" showGitDiffTab={false} />
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
          filenames={["STATUS.md", "useGitDiffPanelState.ts"]}
          pinnedFilename="STATUS.md"
          initialActiveFilename="STATUS.md"
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
            "ManagerThreadStorageBrowser.tsx",
          ]}
          initialActiveFilename="ManagerThreadStorageBrowser.tsx"
        />
      </StoryRow>
    </StoryCard>
  );
}
