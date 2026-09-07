// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@bb/shared-ui/hooks/use-pointer-coarse";
import {
  computeMessageActionRowLayout,
  findMessageActionTooltipCollisionBoundary,
  MessageActionBar,
  MessageColumnWidthContext,
} from "./MessageActionBar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installControlledResizeObserver() {
  const observations: { callback: ResizeObserverCallback; node: Element }[] =
    [];
  class ControlledResizeObserver {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(node: Element) {
      observations.push({ callback: this.#callback, node });
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  const report = (widths: { slot: number; column: number }) => {
    act(() => {
      for (const { callback, node } of observations) {
        const width = node.hasAttribute("data-message-column")
          ? widths.column
          : widths.slot;
        callback(
          [
            {
              target: node,
              contentRect: { width, height: 20 },
            } as unknown as ResizeObserverEntry,
          ],
          undefined as unknown as ResizeObserver,
        );
      }
    });
  };
  return {
    reportWidth(width: number) {
      report({ slot: width, column: width });
    },
    reportWidths: report,
  };
}

function mockMobileCoarsePointer() {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === COMPACT_VIEWPORT_QUERY || query === POINTER_COARSE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe("MessageActionBar", () => {
  it("uses the nearest thread window as the tooltip collision boundary", () => {
    const threadWindow = document.createElement("div");
    threadWindow.setAttribute("data-thread-window", "");
    const sidePanel = document.createElement("aside");
    const actionBar = document.createElement("div");
    threadWindow.append(actionBar);
    document.body.append(threadWindow, sidePanel);

    expect(findMessageActionTooltipCollisionBoundary(actionBar)).toBe(
      threadWindow,
    );
    expect(
      findMessageActionTooltipCollisionBoundary(sidePanel),
    ).toBeUndefined();
  });

  it("renders the send-to-main action and fires its handler when supplied", () => {
    const onSendToMain = vi.fn();
    render(
      <MessageActionBar
        messageText="An answer worth keeping."
        alignment="start"
        mobileActionDisplay="overflow"
        onSendToMain={onSendToMain}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Send to main thread",
    });
    fireEvent.click(button);
    expect(onSendToMain).toHaveBeenCalledTimes(1);
  });

  it("orders agent actions as copy, add, then fork", () => {
    const { container } = render(
      <MessageActionBar
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="inline"
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
      />,
    );

    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
        .map((button) => button.getAttribute("aria-label"))
        .filter((label) => label !== "Message actions"),
    ).toEqual(["Copy message", "Add to chat", "Fork into new thread"]);
  });

  it("keeps the same agent action order in the mobile overflow", () => {
    mockMobileCoarsePointer();
    render(
      <MessageActionBar
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="overflow"
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    const content =
      document.body.querySelector<HTMLElement>('[data-side="top"]');
    if (!content) throw new Error("Missing mobile message action menu");
    expect(
      within(content)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Copy message", "Add to chat", "Fork into new thread"]);
  });

  it("renders plugin actions after the native ones and fires their handlers", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <MessageActionBar
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="inline"
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
        pluginActions={[
          {
            key: "demo/summarize/1",
            pluginId: "demo",
            icon: "Zap",
            label: "Summarize",
            onSelect,
          },
        ]}
      />,
    );

    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
        .map((button) => button.getAttribute("aria-label"))
        .filter((label) => label !== "Message actions"),
    ).toEqual([
      "Copy message",
      "Add to chat",
      "Fork into new thread",
      "Summarize",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders an action bar for a plugin-action-only message", () => {
    render(
      <MessageActionBar
        messageText=""
        alignment="start"
        mobileActionDisplay="inline"
        pluginActions={[
          {
            key: "demo/summarize/1",
            pluginId: "demo",
            icon: null,
            label: "Summarize",
            onSelect: vi.fn(),
          },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Summarize" })).toBeTruthy();
  });

  it("includes plugin actions in the mobile overflow menu", () => {
    mockMobileCoarsePointer();
    const onSelect = vi.fn();
    render(
      <MessageActionBar
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="overflow"
        onAddToChat={vi.fn()}
        pluginActions={[
          {
            key: "demo/summarize/1",
            pluginId: "demo",
            icon: "Zap",
            label: "Summarize",
            onSelect,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    const content =
      document.body.querySelector<HTMLElement>('[data-side="top"]');
    if (!content) throw new Error("Missing mobile message action menu");
    fireEvent.click(within(content).getByRole("button", { name: "Summarize" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders add-to-chat as an icon action and passes the message text", () => {
    const onAddToChat = vi.fn();
    render(
      <MessageActionBar
        messageText="Quote this message."
        alignment="end"
        mobileActionDisplay="overflow"
        onAddToChat={onAddToChat}
      />,
    );

    const button = screen.getByRole("button", { name: "Add to chat" });
    fireEvent.click(button);
    expect(onAddToChat).toHaveBeenCalledWith("Quote this message.");
  });

  it("passes add-to-chat attachments with the message text", () => {
    const onAddToChat = vi.fn();
    const attachment = {
      type: "localFile" as const,
      path: "uploads/spec.md",
      name: "spec.md",
      sizeBytes: 0,
    };
    render(
      <MessageActionBar
        messageText="Quote this message."
        alignment="end"
        mobileActionDisplay="overflow"
        addToChatAttachments={[attachment]}
        onAddToChat={onAddToChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddToChat).toHaveBeenCalledWith("Quote this message.", [
      attachment,
    ]);
  });

  it("renders add-to-chat for attachment-only messages", () => {
    const onAddToChat = vi.fn();
    const attachment = {
      type: "localImage" as const,
      path: "uploads/screenshot.png",
      name: "screenshot.png",
      sizeBytes: 0,
    };
    render(
      <MessageActionBar
        messageText=""
        alignment="end"
        mobileActionDisplay="overflow"
        addToChatAttachments={[attachment]}
        onAddToChat={onAddToChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddToChat).toHaveBeenCalledWith("", [attachment]);
  });

  it("renders copy for an image-only message", () => {
    render(
      <MessageActionBar
        messageText=""
        copyImageUrl="/attachments/screenshot.png"
        alignment="end"
        mobileActionDisplay="overflow"
      />,
    );

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("omits the send-to-main action when no handler is supplied", () => {
    render(
      <MessageActionBar
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="overflow"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Send to main thread" }),
    ).toBeNull();
  });

  it("send-to-main is not gated by the fork/side-chat depth `disabled` flag", () => {
    const onSendToMain = vi.fn();
    render(
      <MessageActionBar
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="overflow"
        onSendToMain={onSendToMain}
        disabled
      />,
    );

    const button = screen.getByRole("button", { name: "Send to main thread" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onSendToMain).toHaveBeenCalledTimes(1);
  });

  it("uses an anchored popover instead of a bottom drawer on mobile", () => {
    mockMobileCoarsePointer();
    const onAddToChat = vi.fn();
    render(
      <MessageActionBar
        messageText="Quote this message."
        alignment="end"
        mobileActionDisplay="overflow"
        onAddToChat={onAddToChat}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Message actions" });
    expect(trigger.hasAttribute("data-no-sidebar-swipe")).toBe(true);
    fireEvent.click(trigger);

    const content =
      document.body.querySelector<HTMLElement>('[data-side="top"]');
    expect(content).not.toBeNull();
    expect(content!.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(document.body.querySelector("[data-vaul-drawer]")).toBeNull();

    fireEvent.click(
      within(content!).getByRole("button", { name: "Add to chat" }),
    );

    expect(onAddToChat).toHaveBeenCalledWith("Quote this message.");
    expect(document.body.querySelector('[data-side="top"]')).toBeNull();
  });

  it("confirms a mobile overflow copy on the trigger instead of toasting", async () => {
    mockMobileCoarsePointer();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <MessageActionBar
        messageText="Copy this answer."
        alignment="start"
        mobileActionDisplay="overflow"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Message actions" });
    fireEvent.click(trigger);
    const content =
      document.body.querySelector<HTMLElement>('[data-side="top"]');
    if (!content) throw new Error("Missing mobile message action menu");
    fireEvent.click(
      within(content).getByRole("button", { name: "Copy message" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Copy this answer."),
    );
    expect(trigger.querySelector('[data-icon="Check"]')).not.toBeNull();
  });

  it("forks from the inline mobile action", () => {
    const onFork = vi.fn();
    render(
      <MessageActionBar
        messageText="The latest answer."
        alignment="start"
        mobileActionDisplay="inline"
        onFork={onFork}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Fork into new thread" }),
    );

    expect(onFork).toHaveBeenCalledTimes(1);
  });
  it("skips the desktop tooltip trees on touch phones", () => {
    mockMobileCoarsePointer();
    render(
      <MessageActionBar
        messageText="The latest answer."
        alignment="start"
        mobileActionDisplay="inline"
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
      />,
    );

    const fork = screen.getByRole("button", { name: "Fork into new thread" });
    expect(fork.hasAttribute("data-state")).toBe(false);
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Copy message", "Add to chat", "Fork into new thread"]);
    expect(
      screen.queryByRole("button", { name: "Message actions" }),
    ).toBeNull();
  });

  it("collapses desktop actions that do not fit into a trailing overflow menu", () => {
    const resizeObserver = installControlledResizeObserver();
    const onAddToChat = vi.fn();
    render(
      <MessageActionBar
        messageText="An answer."
        alignment="end"
        mobileActionDisplay="overflow"
        onAddToChat={onAddToChat}
        onFork={vi.fn()}
      />,
    );
    resizeObserver.reportWidth(44);

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Fork into new thread" }),
    ).toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Fork into new thread" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to chat" }));
    expect(onAddToChat).toHaveBeenCalledWith("An answer.");
  });

  it("keeps every desktop action in the overflow menu when nothing fits inline", () => {
    const resizeObserver = installControlledResizeObserver();
    render(
      <MessageActionBar
        messageText="An answer."
        alignment="end"
        mobileActionDisplay="overflow"
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
      />,
    );
    resizeObserver.reportWidth(24);

    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Copy message", "Add to chat", "Fork into new thread"]);
  });

  it("collapses touch inline actions that do not fit into the mobile popover", () => {
    mockMobileCoarsePointer();
    const resizeObserver = installControlledResizeObserver();
    const onFork = vi.fn();
    render(
      <MessageActionBar
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="inline"
        onAddToChat={vi.fn()}
        onFork={onFork}
      />,
    );
    resizeObserver.reportWidth(60);

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Fork into new thread" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    const content =
      document.body.querySelector<HTMLElement>('[data-side="top"]');
    if (!content) throw new Error("Missing mobile message action menu");
    expect(
      within(content)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Add to chat", "Fork into new thread"]);
    fireEvent.click(
      within(content).getByRole("button", { name: "Fork into new thread" }),
    );
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it("expands the hidden touch actions inline when the column has room", () => {
    mockMobileCoarsePointer();
    const resizeObserver = installControlledResizeObserver();
    const onAddToChat = vi.fn();
    render(
      <div data-message-column="">
        <MessageActionBar
          messageText="An answer."
          alignment="end"
          mobileActionDisplay="overflow"
          onAddToChat={onAddToChat}
          onFork={vi.fn()}
        />
      </div>,
    );
    resizeObserver.reportWidths({ slot: 54, column: 358 });

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));

    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Copy message", "Add to chat", "Fork into new thread"]);
    expect(document.body.querySelector('[data-side="top"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddToChat).toHaveBeenCalledWith("An answer.");
    expect(
      screen.getByRole("button", { name: "Message actions" }),
    ).toBeTruthy();
  });

  it("confirms a copy made from the revealed touch row on the trigger", async () => {
    mockMobileCoarsePointer();
    const resizeObserver = installControlledResizeObserver();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <div data-message-column="">
        <MessageActionBar
          messageText="Copy this answer."
          alignment="end"
          mobileActionDisplay="overflow"
          onAddToChat={vi.fn()}
          onFork={vi.fn()}
        />
      </div>,
    );
    resizeObserver.reportWidths({ slot: 54, column: 358 });

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Copy this answer."),
    );
    const trigger = await screen.findByRole("button", {
      name: "Message actions",
    });
    await waitFor(() =>
      expect(trigger.querySelector('[data-icon="Check"]')).not.toBeNull(),
    );
  });

  it("keeps the popover when the column cannot fit the actions comfortably", () => {
    mockMobileCoarsePointer();
    const resizeObserver = installControlledResizeObserver();
    render(
      <div data-message-column="">
        <MessageActionBar
          messageText="An answer."
          alignment="end"
          mobileActionDisplay="overflow"
          onAddToChat={vi.fn()}
          onFork={vi.fn()}
        />
      </div>,
    );
    resizeObserver.reportWidths({ slot: 54, column: 110 });

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));

    const content =
      document.body.querySelector<HTMLElement>('[data-side="top"]');
    if (!content) throw new Error("Missing mobile message action menu");
    expect(
      within(content)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Copy message", "Add to chat", "Fork into new thread"]);
  });

  it("mounts the tooltip bar on fine-pointer viewports", () => {
    render(
      <MessageActionBar
        messageText="The latest answer."
        alignment="start"
        mobileActionDisplay="inline"
        onFork={vi.fn()}
      />,
    );
    const fork = screen.getByRole("button", { name: "Fork into new thread" });
    expect(fork.getAttribute("data-state")).toBe("closed");
  });
});

describe("MessageActionBar observer budget", () => {
  function spyResizeObserverConstructions(): () => number {
    let constructions = 0;
    class CountingResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
        constructions += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", CountingResizeObserver);
    return () => constructions;
  }

  it("constructs only the column fallback observer for a mobile overflow bar without a provider", () => {
    mockMobileCoarsePointer();
    const constructionCount = spyResizeObserverConstructions();
    render(
      <div data-message-column="">
        <MessageActionBar
          messageText="An answer."
          alignment="start"
          mobileActionDisplay="overflow"
          onAddToChat={vi.fn()}
        />
      </div>,
    );

    expect(constructionCount()).toBe(1);
  });

  it("creates no per-bar observer on the mobile overflow branch under the shared column width", () => {
    mockMobileCoarsePointer();
    const constructionCount = spyResizeObserverConstructions();
    render(
      <MessageColumnWidthContext.Provider value={{ width: 358 }}>
        <MessageActionBar
          messageText="An answer."
          alignment="end"
          mobileActionDisplay="overflow"
          onAddToChat={vi.fn()}
          onFork={vi.fn()}
        />
      </MessageColumnWidthContext.Provider>,
    );
    expect(constructionCount()).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Copy message", "Add to chat", "Fork into new thread"]);
  });

  it("constructs only the slot observer for a desktop bar under the shared column width", () => {
    const constructionCount = spyResizeObserverConstructions();
    render(
      <MessageColumnWidthContext.Provider value={{ width: 400 }}>
        <MessageActionBar
          messageText="An answer."
          alignment="end"
          mobileActionDisplay="overflow"
          onAddToChat={vi.fn()}
          onFork={vi.fn()}
        />
      </MessageColumnWidthContext.Provider>,
    );
    expect(constructionCount()).toBe(1);
  });
});

describe("MessageActionBar shared column width", () => {
  function expandsInPlaceAt({
    alignment,
    listWidth,
  }: {
    alignment: "start" | "end";
    listWidth: number;
  }): boolean {
    const { container, unmount } = render(
      <MessageColumnWidthContext.Provider value={{ width: listWidth }}>
        <MessageActionBar
          messageText="An answer."
          alignment={alignment}
          mobileActionDisplay="overflow"
          onAddToChat={vi.fn()}
          onFork={vi.fn()}
        />
      </MessageColumnWidthContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    const popover = document.body.querySelector('[data-side="top"]');
    const inPlaceRow = within(container).queryByRole("button", {
      name: "Fork into new thread",
    });
    unmount();
    if (popover === null) {
      expect(inPlaceRow).not.toBeNull();
      return true;
    }
    expect(inPlaceRow).toBeNull();
    return false;
  }

  it("reads the assistant column as the shared list width minus its px-2 padding", () => {
    mockMobileCoarsePointer();
    expect(expandsInPlaceAt({ alignment: "start", listWidth: 131 })).toBe(
      false,
    );
    expect(expandsInPlaceAt({ alignment: "start", listWidth: 132 })).toBe(true);
  });

  it("reads the unpadded user column at the full shared list width", () => {
    mockMobileCoarsePointer();
    expect(expandsInPlaceAt({ alignment: "end", listWidth: 115 })).toBe(false);
    expect(expandsInPlaceAt({ alignment: "end", listWidth: 116 })).toBe(true);
  });
});

describe("computeMessageActionRowLayout", () => {
  const metrics = { actionWidth: 20, overflowTriggerWidth: 20 };

  it("renders everything inline before the slot is measured", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 5,
        availableWidth: undefined,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 5, overflowCount: 0 });
  });

  it("keeps all actions inline when they exactly fit", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 76,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 3, overflowCount: 0 });
  });

  it("collapses the tail once the full row would overflow", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 75,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 2, overflowCount: 1 });
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 71,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 1, overflowCount: 2 });
  });

  it("puts every action in the menu when not even one fits beside the trigger", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 3,
        availableWidth: 30,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 0, overflowCount: 3 });
  });

  it("returns an empty layout for zero actions", () => {
    expect(
      computeMessageActionRowLayout({
        actionCount: 0,
        availableWidth: 400,
        ...metrics,
      }),
    ).toEqual({ inlineCount: 0, overflowCount: 0 });
  });
});
