// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode, Ref } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";

const mocks = vi.hoisted(() => ({
  renameThread: vi.fn(),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    renameThread: mocks.renameThread,
  }),
}));

vi.mock("@/components/layout/AppPageHeader", () => ({
  COMPACT_SHELF_HIDDEN_PAGE_HEADER_ACTIONS_CLASS:
    "compact-shelf-hidden-header-actions",
  HEADER_ICON_BUTTON_CLASS: "header-icon-button",
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS: "header-pane-action-button",
  AppPageHeader: ({
    actions,
    center,
    className,
    headerRef,
  }: {
    actions?: ReactNode;
    center?: ReactNode;
    className?: string;
    headerRef?: Ref<HTMLElement>;
  }) => (
    <header ref={headerRef} className={className}>
      {center}
      {actions}
    </header>
  ),
}));

const viewportState = vi.hoisted(() => ({ isCompactViewport: false }));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewportState.isCompactViewport,
}));

const THREAD_ID = "thr_header";

const PANE_CONTEXT: PaneContextValue = {
  paneId: "main",
  isFocused: true,
  isSplitPane: false,
  secondaryPanelHost: null,
  reservesWindowPanelToggle: false,
  onRequestClose: null,
  isMaximized: false,
  onToggleMaximize: null,
  isBoundedPane: false,
  isTopRow: true,
  ownsWindowTopLeft: true,
  navigateInPane: vi.fn(),
};

afterEach(() => {
  cleanup();
  viewportState.isCompactViewport = false;
  mocks.renameThread.mockReset();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ThreadDetailHeader", () => {
  it("leaves the open right-panel collapse control to the panel header", () => {
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          childPillLabel={null}
          isSecondaryPanelOpen
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[]}
          threadId={THREAD_ID}
          threadTitle="Panel state"
        />
      </PaneContext.Provider>,
    );

    expect(
      screen.queryByRole("button", { name: "Hide right panel" }),
    ).toBeNull();
  });

  it("retains the compact trigger while the open shelf hides page actions", () => {
    viewportState.isCompactViewport = true;

    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          childPillLabel={null}
          isSecondaryPanelOpen
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[]}
          threadId={THREAD_ID}
          threadTitle="Panel state"
        />
      </PaneContext.Provider>,
    );

    const trigger = screen.getByRole("button", {
      name: "Hide right panel",
    });
    expect(trigger.closest("[data-thread-header-pane-actions]")).not.toBeNull();
  });

  it.each([
    { expectedIcon: "PanelRight", isCompactViewport: true },
    { expectedIcon: "PanelRight", isCompactViewport: false },
  ])(
    "shows the $expectedIcon glyph on the right-panel trigger",
    ({ expectedIcon, isCompactViewport }) => {
      viewportState.isCompactViewport = isCompactViewport;

      render(
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            childPillLabel={null}
            isSecondaryPanelOpen={false}
            onOpenThreadGitAction={vi.fn()}
            onToggleSecondaryPanel={vi.fn()}
            threadHeaderGitActions={[]}
            threadId={THREAD_ID}
            threadTitle="Panel state"
          />
        </PaneContext.Provider>,
      );

      const showButton = screen.getByRole("button", {
        name: "Show right panel",
      });
      expect(
        showButton.querySelector(`[data-icon="${expectedIcon}"]`),
      ).not.toBeNull();
    },
  );

  it("keeps thread Full Screen in a split header while its panel is open", () => {
    render(
      <PaneContext.Provider
        value={{
          ...PANE_CONTEXT,
          isSplitPane: true,
          secondaryPanelHost: { clear: vi.fn(), publish: vi.fn() },
          onToggleMaximize: vi.fn(),
        }}
      >
        <ThreadDetailHeader
          actionsMenu={null}
          childPillLabel={null}
          isSecondaryPanelOpen
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[]}
          threadId={THREAD_ID}
          threadTitle="Split panel state"
        />
      </PaneContext.Provider>,
    );

    expect(
      screen.getByRole("button", { name: /Maximize pane/ }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Hide right panel" }),
    ).toBeNull();
  });

  it("moves secondary controls into overflow for narrow split panes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 360,
      top: 0,
      width: 360,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const splitContext: PaneContextValue = {
      ...PANE_CONTEXT,
      isFocused: true,
      isSplitPane: true,
      beginPaneDrag: vi.fn(),
    };

    render(
      <PaneContext.Provider value={splitContext}>
        <ThreadDetailHeader
          actionsMenu={(includeResponsiveActions) => (
            <>
              <span>Thread menu</span>
              {includeResponsiveActions ? (
                <span>Responsive menu actions</span>
              ) : null}
            </>
          )}
          childPillLabel={null}
          isSecondaryPanelOpen={false}
          onClosePane={vi.fn()}
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[
            { label: "Commit", target: { kind: "commit" } },
          ]}
          threadId={THREAD_ID}
          threadTitle="Narrow split"
          workspaceOpenButton={<button>Open workspace</button>}
        />
      </PaneContext.Provider>,
    );

    expect(screen.queryByText("Open workspace")).toBeNull();
    expect(screen.queryByText("Commit")).toBeNull();
    expect(screen.getByText("Thread menu")).not.toBeNull();
    expect(screen.getByText("Responsive menu actions")).not.toBeNull();
    expect(
      screen.getByTestId("thread-detail-header-actions-menu").classList,
    ).toContain("compact-shelf-hidden-header-actions");
    const closePane = screen.getByRole("button", { name: "Close pane" });
    expect(closePane.classList).toContain("header-pane-action-button");
    const closeIcon = closePane.querySelector('[data-icon="CloseThreadPane"]');
    expect(closeIcon).not.toBeNull();
    expect(closeIcon?.querySelectorAll("path")).toHaveLength(1);
    expect(closeIcon?.querySelector("path")?.getAttribute("d")).toContain(
      "M18 6L6.00081 17.9992",
    );
  });

  it("keeps responsive controls inline and out of the menu for wide split panes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 720,
      top: 0,
      width: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const splitContext: PaneContextValue = {
      ...PANE_CONTEXT,
      isFocused: true,
      isSplitPane: true,
      beginPaneDrag: vi.fn(),
    };

    render(
      <PaneContext.Provider value={splitContext}>
        <ThreadDetailHeader
          actionsMenu={(includeResponsiveActions) => (
            <>
              <span>Thread menu</span>
              {includeResponsiveActions ? (
                <span>Responsive menu actions</span>
              ) : null}
            </>
          )}
          childPillLabel={null}
          isSecondaryPanelOpen={false}
          onClosePane={vi.fn()}
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[
            { label: "Commit", target: { kind: "commit" } },
          ]}
          threadId={THREAD_ID}
          threadTitle="Wide split"
          workspaceOpenButton={<button>Open workspace</button>}
        />
      </PaneContext.Provider>,
    );

    expect(screen.getByText("Open workspace")).not.toBeNull();
    expect(screen.getByText("Commit")).not.toBeNull();
    expect(screen.getByText("Thread menu")).not.toBeNull();
    expect(screen.queryByText("Responsive menu actions")).toBeNull();
  });

  it("renders serialized mentions in the thread title as pills", () => {
    const { container } = render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          childPillLabel={null}
          isSecondaryPanelOpen={false}
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[]}
          threadId={THREAD_ID}
          threadTitle="Review @docs/foo.test.ts with @thread:thr_worker"
        />
      </PaneContext.Provider>,
    );

    expect(screen.getByTitle("docs/foo.test.ts")).not.toBeNull();
    expect(screen.getByText("thr_worker")).not.toBeNull();
    expect(
      container.querySelectorAll('[data-prompt-mention="true"]'),
    ).toHaveLength(2);
    expect(screen.queryByText("@thread:thr_worker")).toBeNull();
  });

  it("renders a raw thread id in the title as an unlinked mention pill", () => {
    const mentionedThread = makeThreadListEntry({
      id: "thr_dcwivn5n8w",
      projectId: "proj_target",
      title: "Raw title target",
      titleFallback: "Raw title target",
    });

    render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map()}
        threadById={new Map([[mentionedThread.id, mentionedThread]])}
      >
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            childPillLabel={null}
            isSecondaryPanelOpen={false}
            onOpenThreadGitAction={vi.fn()}
            onToggleSecondaryPanel={vi.fn()}
            threadHeaderGitActions={[]}
            threadId={THREAD_ID}
            threadTitle="Continue from thr_dcwivn5n8w docs/foo.ts"
          />
        </PaneContext.Provider>
      </ThreadTitleMentionResourcesProvider>,
    );

    const pill = screen.getByText("Raw title target");
    expect(pill.closest('[data-prompt-mention="true"]')).not.toBeNull();
    expect(pill.closest("a")).toBeNull();
    expect(screen.queryByText("thr_dcwivn5n8w")).toBeNull();
    expect(screen.getByText(/docs\/foo\.ts/u)).not.toBeNull();
  });

  it.each([
    ["straight closing quote", 'Review "thr_dcwivn5n8w."'],
    ["curly closing quote", "Review “thr_dcwivn5n8w.”"],
  ])(
    "renders a sentence-final raw id before a %s in a title",
    (_label, title) => {
      const mentionedThread = makeThreadListEntry({
        id: "thr_dcwivn5n8w",
        projectId: "proj_target",
        title: "Quoted title target",
        titleFallback: "Quoted title target",
      });

      render(
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map([[mentionedThread.id, mentionedThread]])}
        >
          <PaneContext.Provider value={PANE_CONTEXT}>
            <ThreadDetailHeader
              actionsMenu={null}
              childPillLabel={null}
              isSecondaryPanelOpen={false}
              onOpenThreadGitAction={vi.fn()}
              onToggleSecondaryPanel={vi.fn()}
              threadHeaderGitActions={[]}
              threadId={THREAD_ID}
              threadTitle={title}
            />
          </PaneContext.Provider>
        </ThreadTitleMentionResourcesProvider>,
      );

      const pill = screen.getByText("Quoted title target");
      expect(pill.closest('[data-prompt-mention="true"]')).not.toBeNull();
      expect(pill.closest("a")).toBeNull();
      expect(screen.queryByText("thr_dcwivn5n8w")).toBeNull();
    },
  );

  it("leaves raw-id path, extension, and overlong continuations literal in titles", () => {
    const resolveMentions = vi
      .spyOn(sdk.threads, "resolveMentions")
      .mockResolvedValue([]);
    const title = [
      "thr_dcwivn5n8w.md",
      "thr_dcwivn5n8w/path",
      "thr_dcwivn5n8w2",
      "/tmp/thr_dcwivn5n8w",
      "docs/thr_dcwivn5n8w",
      "C:\\tmp\\thr_dcwivn5n8w",
      "docs\\thr_dcwivn5n8w",
      "thr_dcwivn5n8w\\logs",
    ].join(" ");
    const mentionedThread = makeThreadListEntry({
      id: "thr_dcwivn5n8w",
      title: "Should not render",
      titleFallback: "Should not render",
    });

    const { container } = render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map()}
        threadById={new Map([[mentionedThread.id, mentionedThread]])}
      >
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            childPillLabel={null}
            isSecondaryPanelOpen={false}
            onOpenThreadGitAction={vi.fn()}
            onToggleSecondaryPanel={vi.fn()}
            threadHeaderGitActions={[]}
            threadId={THREAD_ID}
            threadTitle={title}
          />
        </PaneContext.Provider>
      </ThreadTitleMentionResourcesProvider>,
    );

    expect(container.textContent).toContain(title);
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(resolveMentions).not.toHaveBeenCalled();
  });

  it("leaves an unresolvable raw thread id literal in a title", async () => {
    const resolveMentions = vi
      .spyOn(sdk.threads, "resolveMentions")
      .mockResolvedValue([]);
    const { container } = render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map()}
        threadById={new Map()}
      >
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            childPillLabel={null}
            isSecondaryPanelOpen={false}
            onOpenThreadGitAction={vi.fn()}
            onToggleSecondaryPanel={vi.fn()}
            threadHeaderGitActions={[]}
            threadId={THREAD_ID}
            threadTitle="Unknown thr_2222222222"
          />
        </PaneContext.Provider>
      </ThreadTitleMentionResourcesProvider>,
    );

    await waitFor(() => expect(resolveMentions).toHaveBeenCalledTimes(1));
    expect(container.textContent).toContain("thr_2222222222");
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
  });

  it("edits the title inline after a double click and commits on Enter", () => {
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          childPillLabel={null}
          isSecondaryPanelOpen={false}
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[]}
          threadId={THREAD_ID}
          threadTitle="Focused thread"
        />
      </PaneContext.Provider>,
    );

    fireEvent.doubleClick(screen.getByText("Focused thread"));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    expect(input).toHaveProperty("value", "Focused thread");

    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.renameThread).toHaveBeenCalledWith(
      THREAD_ID,
      "Renamed thread",
    );
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByText("Focused thread")).not.toBeNull();
  });

  it("cancels an inline header rename on Escape without saving", () => {
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          childPillLabel={null}
          isSecondaryPanelOpen={false}
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[]}
          threadId={THREAD_ID}
          threadTitle="Focused thread"
        />
      </PaneContext.Provider>,
    );

    fireEvent.doubleClick(screen.getByText("Focused thread"));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    fireEvent.change(input, { target: { value: "Scratch name" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(mocks.renameThread).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByText("Focused thread")).not.toBeNull();
  });

  it("does not start a pane drag while the header title is being edited", () => {
    const beginPaneDrag = vi.fn();
    render(
      <PaneContext.Provider
        value={{
          ...PANE_CONTEXT,
          isSplitPane: true,
          beginPaneDrag,
        }}
      >
        <ThreadDetailHeader
          actionsMenu={null}
          childPillLabel={null}
          isSecondaryPanelOpen={false}
          onOpenThreadGitAction={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadHeaderGitActions={[]}
          threadId={THREAD_ID}
          threadTitle="Focused thread"
        />
      </PaneContext.Provider>,
    );

    fireEvent.doubleClick(screen.getByText("Focused thread"));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    fireEvent.pointerDown(input, { button: 0 });

    expect(beginPaneDrag).not.toHaveBeenCalled();
  });
});
