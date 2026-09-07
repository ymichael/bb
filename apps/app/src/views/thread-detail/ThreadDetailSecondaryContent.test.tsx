// @vitest-environment jsdom

import { useMemo, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  usePluginComposerHost,
  usePluginComposerHostDraft,
  usePublishPluginComposerHost,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  getPromptDraftAccessor,
  usePromptDraftStorage,
} from "@/hooks/usePromptDraftStorage";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import {
  DefaultPaneContextProvider,
  PaneContext,
  type PaneContextValue,
  type PaneSecondaryPanelViewModel,
} from "./PaneContext";

type ThreadDetailSecondaryContentProps = ComponentProps<
  typeof ThreadDetailSecondaryContent
>;

const secondaryPanelMockState = vi.hoisted(() => ({
  renderBrowserDeck: undefined as
    | ((
        activeBrowserTabId: string,
        pane: {
          isFocused: boolean;
          onFocusPane: () => void;
        },
      ) => ReactNode)
    | undefined,
}));

vi.mock("@/lib/bb-desktop", () => ({
  DEFAULT_DESKTOP_WINDOW_STATE: { isFullScreen: false },
  getBbDesktopInfo: () => null,
  shouldReserveMacosTrafficLights: () => false,
  shouldUseMacosDesktopChrome: () => false,
}));

vi.mock("@/components/ui/sidebar.js", () => ({
  useOptionalIsSidebarShowing: () => true,
}));

const { useThreadsMock } = vi.hoisted(() => ({
  useThreadsMock: vi.fn((..._args: unknown[]) => ({ data: [] })),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreads: useThreadsMock,
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => 50,
}));

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");

  const PanelGroup = React.forwardRef<
    {
      getLayout: () => number[];
      setLayout: (layout: number[]) => void;
    },
    { children?: ReactNode }
  >(({ children }, ref) => {
    React.useImperativeHandle(
      ref,
      () => ({ getLayout: () => [50, 50], setLayout: () => {} }),
      [],
    );
    return React.createElement(
      "div",
      { "data-testid": "panel-group" },
      children,
    );
  });
  PanelGroup.displayName = "MockPanelGroup";

  const Panel = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", { "data-testid": "panel" }, children);

  return { Panel, PanelGroup };
});

vi.mock(
  "@/components/secondary-panel/ThreadMetadataContent",
  async (importOriginal) => {
    const React = await import("react");
    const actual =
      await importOriginal<
        typeof import("@/components/secondary-panel/ThreadMetadataContent")
      >();

    return {
      ...actual,
      ThreadMetadataCard: ({
        children,
      }: ComponentProps<typeof actual.ThreadMetadataCard>) =>
        React.createElement(
          "div",
          { "data-testid": "metadata-card" },
          children,
        ),
      ThreadMetadataContent: (
        _props: ComponentProps<typeof actual.ThreadMetadataContent>,
      ) => React.createElement("div", { "data-testid": "metadata-content" }),
      hasAnyThreadMetadata: () => false,
    };
  },
);

vi.mock(
  "@/components/secondary-panel/ThreadSecondaryPanel",
  async (importOriginal) => {
    const React = await import("react");
    const actual =
      await importOriginal<
        typeof import("@/components/secondary-panel/ThreadSecondaryPanel")
      >();

    const ThreadSecondaryPanel = ({
      renderBrowserDeck,
      inlinePanelToggle,
      metadataContent,
      renderAsDrawer,
    }: ComponentProps<typeof actual.ThreadSecondaryPanel>) => {
      secondaryPanelMockState.renderBrowserDeck = renderBrowserDeck;
      return React.createElement(
        "section",
        {
          "data-inline-panel-toggle": inlinePanelToggle,
          "data-testid": renderAsDrawer
            ? "drawer-secondary-panel"
            : "inline-secondary-panel",
        },
        metadataContent,
      );
    };

    return { ...actual, ThreadSecondaryPanel };
  },
);

const { timelinePaneRenders } = vi.hoisted(() => ({
  timelinePaneRenders: vi.fn(),
}));

vi.mock("./ThreadTimelinePane", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("./ThreadTimelinePane")>();

  const ThreadTimelinePane = ({
    footer,
    threadId,
  }: ComponentProps<typeof actual.ThreadTimelinePane>) => {
    timelinePaneRenders();
    return React.createElement(
      "div",
      {
        "data-testid": "thread-timeline-pane",
        "data-thread-id": threadId,
      },
      footer,
    );
  };

  return { ...actual, ThreadTimelinePane };
});

const noop = () => {};
let publishedHostedPanel: PaneSecondaryPanelViewModel | null = null;
const hostedPaneRegistration = {
  clear: () => {
    publishedHostedPanel = null;
  },
  publish: (model: PaneSecondaryPanelViewModel) => {
    publishedHostedPanel = model;
  },
};

function FooterComposerHostPublisher({ threadId }: { threadId: string }) {
  const promptDraft = usePromptDraftStorage({
    kind: "thread",
    projectId: "proj-test",
    threadId,
  });
  const host = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId },
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      setDraft: promptDraft.setDraft,
      focus: () => {},
    }),
    [
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      threadId,
    ],
  );
  usePublishPluginComposerHost(host);
  return <FooterComposerDraftProbe />;
}

function FooterComposerDraftProbe() {
  const draft = usePluginComposerHostDraft(usePluginComposerHost());
  return <div data-testid="footer-composer-draft">{draft?.text ?? ""}</div>;
}

function makeThread(): ThreadDetailSecondaryContentProps["metadata"]["thread"] {
  return {
    archivedAt: null,
    createdAt: 0,
    deletedAt: null,
    environmentId: null,
    id: "thread-1",
    lastReadAt: null,
    latestAttentionAt: 0,
    parentThreadId: null,
    pinnedAt: null,
    projectId: "proj-test",
    providerId: "codex",
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    status: "idle",
    stopRequestedAt: null,
    title: null,
    titleFallback: "Test thread",
    sectionId: null,
    updatedAt: 0,
  } as ThreadDetailSecondaryContentProps["metadata"]["thread"];
}

function createProps(
  isMetadataLoading = false,
  isConversationCollapsed = false,
): ThreadDetailSecondaryContentProps {
  return {
    footer: <div data-testid="footer" />,
    header: <div data-testid="header" />,
    isBoundedPane: false,
    isConversationCollapsed,
    isMetadataLoading,
    isSecondaryPanelOpen: true,
    metadata: {
      canAssignToParent: false,
      canTakeOverThread: false,
      environment: null,
      environmentDisplayHost: { locality: "local", identity: null },
      isLoadingMergeBaseBranchOptions: false,
      mergeBaseBranchOptions: undefined,
      onAssignParent: noop,
      onParentSelectorOpenChange: noop,
      onRetryParentThreads: noop,
      onMergeBaseBranchChange: noop,
      parentThreadProjectId: null,
      parentThreadDisplayName: null,
      parentThreads: [],
      isLoadingParentThreads: false,
      isParentThreadsError: false,
      projectId: "proj-test",
      pullRequest: null,
      selectedMergeBaseBranch: undefined,
      thread: makeThread(),
      threadSchedules: [],
      updateThreadPending: false,
      workspaceStatus: undefined,
      workspaceStatusError: null,
    } as ThreadDetailSecondaryContentProps["metadata"],
    onToggleConversationCollapse: noop,
    onToggleSecondaryPanel: noop,
    renderHostedPanel: (panel) => panel,
    secondaryPanel: {
      activeTab: null,
      canUseGitUi: false,
      tabs: [],
      fixedTabs: [],
      isOpen: true,
      onCollapse: noop,
      onClose: noop,
      onTabReorder: noop,
      onOpenNewTab: noop,
      onPanelFocus: noop,
      renderBrowserDeck: () => null,
    },
    timeline: {
      activeThinking: null,
      hasOlderTimelineRows: false,
      isLoadingOlderTimelineRows: false,
      isThreadTimelinePending: false,
      onLoadOlderRows: noop,
      resolveMentionLink: () => null,
      showOngoingIndicator: false,
      stopRequestedAt: null,
      threadId: "thread-1",
      threadRuntimeDisplayStatus: "idle",
      timelineError: false,
      timelineRows: [],
      unreadDividerAutoScroll: false,
      unreadDividerPlacement: null,
      workspaceRootPath: undefined,
    } as unknown as ThreadDetailSecondaryContentProps["timeline"],
  };
}

function renderThreadDetail(
  hosted: boolean,
  isMetadataLoading = false,
  isConversationCollapsed = false,
) {
  const content = (
    <CompactViewportOverrideProvider isCompactViewport={false}>
      <ThreadDetailSecondaryContent
        {...createProps(isMetadataLoading, isConversationCollapsed)}
      />
    </CompactViewportOverrideProvider>
  );
  if (!hosted) {
    return render(
      <MemoryRouter>
        <DefaultPaneContextProvider>{content}</DefaultPaneContextProvider>
      </MemoryRouter>,
    );
  }

  const value: PaneContextValue = {
    paneId: "pane-test",
    isFocused: true,
    isSplitPane: true,
    secondaryPanelHost: hostedPaneRegistration,
    reservesWindowPanelToggle: false,
    onRequestClose: noop,
    isMaximized: false,
    onToggleMaximize: noop,
    isBoundedPane: true,
    isTopRow: true,
    ownsWindowTopLeft: true,
    navigateInPane: noop,
  };
  return render(
    <PaneContext.Provider value={value}>{content}</PaneContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  publishedHostedPanel = null;
  secondaryPanelMockState.renderBrowserDeck = undefined;
  timelinePaneRenders.mockClear();
  useThreadsMock.mockClear();
  window.localStorage.clear();
});

describe("ThreadDetailSecondaryContent", () => {
  it("keeps the standalone panel hide control in the panel toolbar", async () => {
    renderThreadDetail(false);

    expect(
      (
        await screen.findByTestId(
          "inline-secondary-panel",
          {},
          { timeout: 5_000 },
        )
      ).getAttribute("data-inline-panel-toggle"),
    ).toBe("button");
  });

  it("places the hosted panel hide control at the outer edge of its toolbar", async () => {
    renderThreadDetail(true, false, true);

    expect(screen.getByTestId("header").closest("[inert]")).toBeNull();
    expect(
      screen.getByTestId("thread-timeline-pane").closest("[inert]"),
    ).not.toBeNull();
    if (publishedHostedPanel === null) {
      throw new Error("Expected the focused pane to publish its panel model");
    }
    expect(publishedHostedPanel).toMatchObject({
      contentKey: "thread-1",
      isMainCollapsed: true,
    });
    render(<>{publishedHostedPanel.panel}</>);
    expect(
      (await screen.findByTestId("inline-secondary-panel")).getAttribute(
        "data-inline-panel-toggle",
      ),
    ).toBe("button");
  });

  it("keeps the thread header inside the timeline column beside the panel", async () => {
    renderThreadDetail(false);

    const sidePanel = await screen.findByTestId("inline-secondary-panel");
    const timelinePanel = screen.getByTestId("panel");
    const panelGroup = screen.getByTestId("panel-group");
    expect(timelinePanel.contains(screen.getByTestId("header"))).toBe(true);
    expect(timelinePanel.contains(sidePanel)).toBe(false);
    expect(panelGroup.contains(timelinePanel)).toBe(true);
    expect(panelGroup.contains(sidePanel)).toBe(true);
    expect(timelinePanel.contains(screen.getByTestId("footer"))).toBe(true);
    expect(sidePanel.textContent).toContain("No thread details available.");
  });

  it("keeps the thread metadata loading presentation in the panel", async () => {
    renderThreadDetail(false, true);

    expect(
      (await screen.findByTestId("inline-secondary-panel")).contains(
        screen.getByTestId("metadata-card"),
      ),
    ).toBe(true);
  });

  it("pins a split browser pane to its tab and gates native commands by pane focus", () => {
    const renderBrowserDeck = vi.fn(() => null);
    const props = createProps();
    props.secondaryPanel.renderBrowserDeck = renderBrowserDeck;

    render(
      <MemoryRouter>
        <DefaultPaneContextProvider>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    const panelBrowserDeck = secondaryPanelMockState.renderBrowserDeck;
    expect(panelBrowserDeck).toBeDefined();
    if (panelBrowserDeck === undefined) return;

    const onFocusPane = vi.fn();
    panelBrowserDeck("browser-split", {
      isFocused: true,
      onFocusPane,
    });
    expect(renderBrowserDeck).toHaveBeenLastCalledWith({
      activeBrowserTabId: "browser-split",
      canHandleBrowserCommands: true,
      canShowNativeBrowserView: true,
      onNativeFocus: onFocusPane,
    });

    panelBrowserDeck("browser-split", {
      isFocused: false,
      onFocusPane,
    });
    expect(renderBrowserDeck).toHaveBeenLastCalledWith({
      activeBrowserTabId: "browser-split",
      canHandleBrowserCommands: false,
      canShowNativeBrowserView: true,
      onNativeFocus: onFocusPane,
    });
  });

  it("keeps the panel subtree mounted when navigating between threads", async () => {
    const props = createProps();
    const { rerender } = render(
      <MemoryRouter>
        <DefaultPaneContextProvider>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    const sidePanel = await screen.findByTestId(
      "inline-secondary-panel",
      {},
      { timeout: 5_000 },
    );
    const panelGroup = screen.getByTestId("panel-group");

    const nextProps = createProps();
    nextProps.timeline = {
      ...nextProps.timeline,
      threadId: "thread-2",
    } as ThreadDetailSecondaryContentProps["timeline"];
    rerender(
      <MemoryRouter>
        <DefaultPaneContextProvider>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...nextProps} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("panel-group")).toBe(panelGroup);
    expect(screen.getByTestId("inline-secondary-panel")).toBe(sidePanel);
    expect(
      screen.getByTestId("thread-timeline-pane").getAttribute("data-thread-id"),
    ).toBe("thread-2");
  });

  it("only requests the forks list while the secondary panel is open", () => {
    const props = createProps();
    const { rerender } = render(
      <MemoryRouter>
        <DefaultPaneContextProvider>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent
              {...props}
              isSecondaryPanelOpen={false}
            />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    expect(useThreadsMock).toHaveBeenLastCalledWith(
      {
        projectId: "proj-test",
        sourceThreadId: "thread-1",
        originKind: "fork",
        archived: false,
      },
      { enabled: false },
    );

    rerender(
      <MemoryRouter>
        <DefaultPaneContextProvider>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} isSecondaryPanelOpen />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    expect(useThreadsMock).toHaveBeenLastCalledWith(expect.anything(), {
      enabled: true,
    });
  });

  it("does not re-render the timeline pane while the composer draft changes", async () => {
    const props = createProps();
    props.footer = <FooterComposerHostPublisher threadId="thread-1" />;
    render(
      <MemoryRouter>
        <DefaultPaneContextProvider>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId("inline-secondary-panel", {}, { timeout: 5_000 });
    expect(screen.getByTestId("footer-composer-draft").textContent).toBe("");
    const paneRendersAfterMount = timelinePaneRenders.mock.calls.length;

    const accessor = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-test",
      threadId: "thread-1",
    });
    const typed = "why does typing hang";
    for (let index = 1; index <= typed.length; index += 1) {
      const text = typed.slice(0, index);
      act(() => {
        accessor.setDraft({ text, mentions: [], attachments: [] });
      });
      expect(screen.getByTestId("footer-composer-draft").textContent).toBe(
        text,
      );
    }

    expect(timelinePaneRenders.mock.calls.length).toBe(paneRendersAfterMount);
  });
});
