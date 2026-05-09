import { useEffect, useMemo, type ReactNode } from "react";
import {
  Provider as JotaiProvider,
  createStore,
  useSetAtom,
} from "jotai";
import { ThreadSecondaryPanel } from "./ThreadSecondaryPanel";
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
    <div className="flex h-[160px] w-full max-w-[480px] min-w-0 flex-col overflow-hidden rounded-md border border-border/70 bg-background">
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

const placeholderStorageContent = (
  <div className="space-y-2 pt-1 text-sm text-muted-foreground">
    <p>
      Workspace tab content (see "secondary-panel/Workspace" story for
      variants).
    </p>
  </div>
);

interface ShellArgs {
  initialPanel: ThreadSecondaryPanelTab;
  isManagerThread?: boolean;
  showThreadStorageTab?: boolean;
  showGitDiffTab?: boolean;
  canUseGitUi?: boolean;
}

function ShellRow({
  initialPanel,
  isManagerThread = false,
  showThreadStorageTab = false,
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
          isManagerThread={isManagerThread}
          metadataContent={placeholderInfoContent}
          threadStorageContent={
            showThreadStorageTab ? placeholderStorageContent : undefined
          }
          showThreadStorageTab={showThreadStorageTab}
          showGitDiffTab={showGitDiffTab}
          onPanelChange={noop}
          threadId="thr_demo"
          onCollapse={noop}
          onClose={noop}
          isMobile
        />
      </PanelStage>
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
        hint="tab strip shows Info + Workspace (no Diff for managers)"
      >
        <ShellRow
          initialPanel="thread-info"
          isManagerThread
          showThreadStorageTab
          showGitDiffTab={false}
        />
      </StoryRow>
      <StoryRow
        label="manager thread, workspace tab"
        hint="Workspace tab active (content is exercised in secondary-panel/Workspace)"
      >
        <ShellRow
          initialPanel="thread-storage"
          isManagerThread
          showThreadStorageTab
          showGitDiffTab={false}
        />
      </StoryRow>
      <StoryRow
        label="git UI disabled"
        hint="canUseGitUi=false hides the Diff tab and falls back to Info"
      >
        <ShellRow initialPanel="thread-info" canUseGitUi={false} />
      </StoryRow>
    </StoryCard>
  );
}
