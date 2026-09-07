// @vitest-environment jsdom

import type { TerminalSession } from "@bb/server-contract";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTerminalContent } from "./ThreadTerminalContent";
import type { ThreadTerminalController } from "./useThreadTerminalController";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";

const threadTerminalView = vi.hoisted(() =>
  vi.fn((props: { autoFocus: boolean; isPanelOpen: boolean }) => (
    <div
      data-testid="terminal-view"
      data-panel-open={String(props.isPanelOpen)}
    />
  )),
);

vi.mock("./ThreadTerminalView", () => ({
  ThreadTerminalView: threadTerminalView,
}));

const session: TerminalSession = makeTerminalSession({
  id: "term_1",
  threadId: "thr_1",
  environmentId: "env_1",
  hostId: "host_1",
  createdAt: 1,
  updatedAt: 1,
});

function controller(
  isPanelOpen: boolean,
  shouldMountTerminalView: boolean = isPanelOpen,
): ThreadTerminalController {
  return {
    activeSession: session,
    canCreateTerminal: true,
    handleActiveTerminalSessionChange: () => undefined,
    handleActiveTerminalTitleChange: () => undefined,
    handleActiveTerminalUserInput: () => undefined,
    handleCreateTerminal: () => undefined,
    handleSelectTerminal: () => undefined,
    hasTerminalQueryError: false,
    isCreateTerminalPending: false,
    isPanelOpen,
    shouldMountTerminalView,
    shouldRetainActiveTerminalView: false,
    terminalBodyMessage: "No terminals",
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadTerminalContent", () => {
  it("does not mount the terminal view until the panel opens", () => {
    const rendered = render(
      <ThreadTerminalContent
        autoFocus={false}
        controller={controller(false)}
      />,
    );

    expect(threadTerminalView).not.toHaveBeenCalled();
    expect(rendered.container.firstChild).toBeNull();

    rendered.rerender(
      <ThreadTerminalContent autoFocus controller={controller(true)} />,
    );

    expect(threadTerminalView).toHaveBeenCalledOnce();
    expect(threadTerminalView.mock.calls[0]?.[0]).toMatchObject({
      autoFocus: true,
      isPanelOpen: true,
    });
  });

  it("keeps the mounted terminal view alive while a persisted panel is hidden", () => {
    const rendered = render(
      <ThreadTerminalContent autoFocus={false} controller={controller(true)} />,
    );
    const mountedView = rendered.getByTestId("terminal-view");

    rendered.rerender(
      <ThreadTerminalContent
        autoFocus={false}
        controller={controller(false, true)}
      />,
    );

    const hiddenView = rendered.getByTestId("terminal-view");
    expect(hiddenView).toBe(mountedView);
    expect(hiddenView.dataset.panelOpen).toBe("false");

    rendered.rerender(
      <ThreadTerminalContent autoFocus={false} controller={controller(true)} />,
    );
    expect(rendered.getByTestId("terminal-view")).toBe(mountedView);
  });

  it("unmounts the terminal view once the panel is neither open nor persisted", () => {
    const rendered = render(
      <ThreadTerminalContent autoFocus={false} controller={controller(true)} />,
    );
    expect(rendered.queryByTestId("terminal-view")).not.toBeNull();

    rendered.rerender(
      <ThreadTerminalContent
        autoFocus={false}
        controller={controller(false, false)}
      />,
    );

    expect(rendered.queryByTestId("terminal-view")).toBeNull();
  });
});
