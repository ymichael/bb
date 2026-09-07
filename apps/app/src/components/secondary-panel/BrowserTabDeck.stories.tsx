import type { ReactNode } from "react";
import type { BbDesktopBrowserState } from "@bb/desktop-contract";
import {
  getBrowserHistoryStorageKey,
  type BrowserHistoryEntry,
} from "@/lib/browser-history";
import type { BrowserFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { WithDesktopBrowser } from "../../../.ladle/story-desktop";
import { Icon } from "@bb/shared-ui/icon";
import { BrowserTabDeck } from "./BrowserTabDeck";
import {
  ThreadSecondaryPanel,
  type SecondaryPanelRenderableTab,
} from "./ThreadSecondaryPanel";

export default {
  title: "right-panel/Browser tab",
};

const noop = () => {};

const EMPTY_TAB_THREAD_ID = "thr_browser_tab_empty_story";
const NARROW_TAB_THREAD_ID = "thr_browser_tab_narrow_story";
const RECENTS_TAB_THREAD_ID = "thr_browser_tab_recents_story";
const LOADING_TAB_THREAD_ID = "thr_browser_tab_loading_story";

function makeBrowserTab(id: string): BrowserFixedPanelTab {
  return { environmentId: null, id, kind: "browser", title: null, url: "" };
}

const EMPTY_TAB = makeBrowserTab("browser:empty");
const NARROW_TAB = makeBrowserTab("browser:narrow");
const RECENTS_TAB = makeBrowserTab("browser:recents");
const LOADING_TAB: BrowserFixedPanelTab = {
  environmentId: null,
  id: "browser:loading",
  kind: "browser",
  title: "Example Docs",
  url: "https://example.com/docs",
};
const LOADING_BROWSER_STATE: BbDesktopBrowserState = {
  tabId: LOADING_TAB.id,
  url: LOADING_TAB.url,
  title: LOADING_TAB.title,
  isLoading: true,
  canGoBack: true,
  canGoForward: false,
  errorText: null,
};

const RECENT_VISITS: readonly BrowserHistoryEntry[] = [
  {
    url: "https://react.dev/reference/react/useLayoutEffect",
    title: "useLayoutEffect – React",
    visitedAt: Date.now() - 4 * 60 * 1000,
  },
  {
    url: "https://github.com/anthropics/anthropic-sdk-typescript",
    title: "anthropics/anthropic-sdk-typescript",
    visitedAt: Date.now() - 90 * 60 * 1000,
  },
  {
    url: "https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver",
    title: "ResizeObserver - Web APIs | MDN",
    visitedAt: Date.now() - 6 * 60 * 60 * 1000,
  },
  {
    url: "https://localhost:38886/",
    title: null,
    visitedAt: Date.now() - 26 * 60 * 60 * 1000,
  },
];

function seedBrowserHistory(
  threadId: string,
  entries: readonly BrowserHistoryEntry[],
): void {
  if (typeof window === "undefined") {
    return;
  }
  const storageKey = getBrowserHistoryStorageKey(threadId);
  if (entries.length === 0) {
    window.localStorage.removeItem(storageKey);
    return;
  }
  window.localStorage.setItem(storageKey, JSON.stringify(entries));
}

function PanelStage({
  children,
  width = "wide",
}: {
  children: ReactNode;
  width?: "narrow" | "wide";
}) {
  return (
    <div
      className={
        width === "narrow"
          ? "flex h-[520px] w-[360px] max-w-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background"
          : "flex h-[520px] w-full max-w-[760px] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background"
      }
    >
      {children}
    </div>
  );
}

interface BrowserTabStageProps {
  tab: BrowserFixedPanelTab;
  threadId: string;
  width?: "narrow" | "wide";
}

function BrowserTabStage({ tab, threadId, width }: BrowserTabStageProps) {
  const label = tab.title ?? "Browser";
  const panelTabs: SecondaryPanelRenderableTab[] = [
    {
      label: label,
      leadingVisual: <Icon name="Globe" className="size-3.5" aria-hidden />,
      statusLabel: null,
      onSelect: noop,
      onClose: noop,
      renderContent: () => null,
      tab,
    },
  ];

  return (
    <PanelStage width={width}>
      <ThreadSecondaryPanel
        activeTab={tab}
        canUseGitUi={false}
        requestedMergeBaseBranch="main"
        environmentId={undefined}
        tabs={panelTabs}
        fixedTabs={[]}
        renderBrowserDeck={(activeBrowserTabId) => (
          <BrowserTabDeck
            browserTabs={[tab]}
            activeBrowserTabId={activeBrowserTabId}
            canShowNativeBrowserView
            threadId={threadId}
            environmentId={null}
            onUpdate={noop}
          />
        )}
        isConversationCollapsed={false}
        isOpen
        metadataContent={null}
        onClose={noop}
        onCollapse={noop}
        onTabReorder={noop}
        onOpenNewTab={noop}
        onPanelFocus={noop}
        onToggleConversationCollapse={noop}
        renderAsDrawer
      />
    </PanelStage>
  );
}

export function Overview() {
  seedBrowserHistory(EMPTY_TAB_THREAD_ID, []);
  seedBrowserHistory(NARROW_TAB_THREAD_ID, []);
  seedBrowserHistory(RECENTS_TAB_THREAD_ID, RECENT_VISITS);
  return (
    <WithDesktopBrowser browserState={LOADING_BROWSER_STATE}>
      <StoryCard>
        <StoryRow
          label="new tab"
          hint="fresh browser tab — the toolbar address bar is the only input, above an empty start page"
        >
          <BrowserTabStage tab={EMPTY_TAB} threadId={EMPTY_TAB_THREAD_ID} />
        </StoryRow>
        <StoryRow
          label="narrow panel"
          hint="360px browser panel; the complete navigation toolbar stays visible and usable without hover"
        >
          <BrowserTabStage
            tab={NARROW_TAB}
            threadId={NARROW_TAB_THREAD_ID}
            width="narrow"
          />
        </StoryRow>
        <StoryRow
          label="recently visited"
          hint="start page with seeded per-thread history, styled like the New tab page rows"
        >
          <BrowserTabStage tab={RECENTS_TAB} threadId={RECENTS_TAB_THREAD_ID} />
        </StoryRow>
        <StoryRow
          label="loading page"
          hint="the persistent navigation toolbar replaces Reload with Stop while the page is loading"
        >
          <BrowserTabStage tab={LOADING_TAB} threadId={LOADING_TAB_THREAD_ID} />
        </StoryRow>
      </StoryCard>
    </WithDesktopBrowser>
  );
}
