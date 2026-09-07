// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Thread } from "@bb/domain";
import { makeThread as makeThreadFixture } from "@bb/test-helpers/domain-fixtures";
import { defaultAppSettings } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { ThreadArchiveCommandHandler } from "./ThreadArchiveCommandHandler";

const mocks = vi.hoisted(() => ({
  archiveThreadAndChildren: vi.fn(),
}));

const testState = vi.hoisted(() => ({
  keybindings: [
    {
      command: "thread.archive" as const,
      desktopOnly: false,
      shortcut: {
        key: "a",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      },
      when: { all: ["mainSurface" as const], none: ["modalOpen" as const] },
    },
  ],
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    archiveThreadAndChildren: mocks.archiveThreadAndChildren,
  }),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: defaultAppSettings,
      keybindings: testState.keybindings,
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

function makeThread(id: string, title: string): Thread {
  return makeThreadFixture({
    createdAt: 1,
    id,
    lastReadAt: null,
    latestAttentionAt: 1,
    title,
    titleFallback: null,
    updatedAt: 1,
  });
}

const firstThread = makeThread("thr_first", "First pane title");
const secondThread = makeThread("thr_second", "Second pane title");

function paneContext(paneId: string, isFocused: boolean): PaneContextValue {
  return {
    beginPaneDrag: undefined,
    isBoundedPane: true,
    isFocused,
    isMaximized: false,
    isSplitPane: true,
    isTopRow: true,
    navigateInPane: vi.fn(),
    onMoveToSide: undefined,
    onRequestClose: vi.fn(),
    onToggleMaximize: vi.fn(),
    ownsWindowTopLeft: paneId === "pane-first",
    paneId,
    reservesWindowPanelToggle: false,
    secondaryPanelHost: null,
  };
}

function SplitArchiveHandlers({
  firstPaneThread = firstThread,
  focusedThreadId,
}: {
  firstPaneThread?: Thread;
  focusedThreadId: string | null;
}) {
  return (
    <AppCommandProvider>
      <PaneContext.Provider
        value={paneContext(
          "pane-first",
          focusedThreadId === firstPaneThread.id,
        )}
      >
        <ThreadArchiveCommandHandler thread={firstPaneThread} />
      </PaneContext.Provider>
      <PaneContext.Provider
        value={paneContext("pane-second", focusedThreadId === secondThread.id)}
      >
        <ThreadArchiveCommandHandler thread={secondThread} />
      </PaneContext.Provider>
    </AppCommandProvider>
  );
}

function pressArchiveShortcut() {
  fireEvent.keyDown(window, {
    key: "A",
    code: "KeyA",
    ctrlKey: true,
    shiftKey: true,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadArchiveCommandHandler", () => {
  it("archives only the focused pane's thread as focus changes", () => {
    const view = render(
      <SplitArchiveHandlers focusedThreadId={firstThread.id} />,
    );

    pressArchiveShortcut();
    expect(mocks.archiveThreadAndChildren.mock.calls).toEqual([[firstThread]]);

    mocks.archiveThreadAndChildren.mockClear();
    view.rerender(<SplitArchiveHandlers focusedThreadId={secondThread.id} />);
    pressArchiveShortcut();
    expect(mocks.archiveThreadAndChildren.mock.calls).toEqual([[secondThread]]);
  });

  it("does nothing when no pane is focused", () => {
    render(<SplitArchiveHandlers focusedThreadId={null} />);

    pressArchiveShortcut();

    expect(mocks.archiveThreadAndChildren).not.toHaveBeenCalled();
  });

  it("does nothing when the focused thread is archived", () => {
    const archivedThread = { ...firstThread, archivedAt: 2 };
    render(
      <SplitArchiveHandlers
        firstPaneThread={archivedThread}
        focusedThreadId={archivedThread.id}
      />,
    );

    pressArchiveShortcut();

    expect(mocks.archiveThreadAndChildren).not.toHaveBeenCalled();
  });
});
