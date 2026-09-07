// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Thread } from "@bb/domain";
import { makeThread as makeThreadFixture } from "@bb/test-helpers/domain-fixtures";
import { defaultAppSettings } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { ThreadRenameCommandHandler } from "./ThreadRenameCommandHandler";

const mocks = vi.hoisted(() => ({
  requestRename: vi.fn(),
}));

const testState = vi.hoisted(() => ({
  keybindings: [
    {
      command: "thread.rename" as const,
      desktopOnly: false,
      shortcut: {
        key: "r",
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
  useThreadActions: () => ({ requestRename: mocks.requestRename }),
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

function SplitRenameHandlers({
  focusedThreadId,
}: {
  focusedThreadId: string | null;
}) {
  return (
    <AppCommandProvider>
      <PaneContext.Provider
        value={paneContext("pane-first", focusedThreadId === firstThread.id)}
      >
        <ThreadRenameCommandHandler thread={firstThread} />
      </PaneContext.Provider>
      <PaneContext.Provider
        value={paneContext("pane-second", focusedThreadId === secondThread.id)}
      >
        <ThreadRenameCommandHandler thread={secondThread} />
      </PaneContext.Provider>
    </AppCommandProvider>
  );
}

function pressRenameShortcut() {
  fireEvent.keyDown(window, {
    key: "R",
    code: "KeyR",
    ctrlKey: true,
    shiftKey: true,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadRenameCommandHandler", () => {
  it("routes rename to the focused pane's thread as focus changes", () => {
    const view = render(
      <SplitRenameHandlers focusedThreadId={firstThread.id} />,
    );

    pressRenameShortcut();
    expect(mocks.requestRename.mock.calls).toEqual([[firstThread]]);

    mocks.requestRename.mockClear();
    view.rerender(<SplitRenameHandlers focusedThreadId={secondThread.id} />);
    pressRenameShortcut();
    expect(mocks.requestRename.mock.calls).toEqual([[secondThread]]);
  });

  it("does not request rename when no pane is focused", () => {
    render(<SplitRenameHandlers focusedThreadId={null} />);

    pressRenameShortcut();

    expect(mocks.requestRename).not.toHaveBeenCalled();
  });
});
