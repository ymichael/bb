// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { useIsBrowserDimmingModalOpen } from "@/hooks/useBrowserDimmingModal";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import {
  PaneMaximizeButton,
  resolvePaneArrangementLabel,
} from "./PaneMaximizeButton";

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandShortcut: () => ({
    ariaKeyshortcuts: "Meta+Shift+E",
    label: "⌘⇧E",
  }),
}));

const noop = () => {};

function BrowserOverlayProbe() {
  return (
    <span data-testid="browser-overlay-state">
      {useIsBrowserDimmingModalOpen() ? "hidden" : "visible"}
    </span>
  );
}

function renderButton(
  isMaximized: boolean,
  onToggleMaximize: () => void = noop,
  onMoveToSide: PaneContextValue["onMoveToSide"] = noop,
) {
  const value: PaneContextValue = {
    paneId: "pane-1",
    isFocused: true,
    isSplitPane: true,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: noop,
    isMaximized,
    onToggleMaximize,
    onMoveToSide,
    isBoundedPane: true,
    isTopRow: true,
    ownsWindowTopLeft: true,
    navigateInPane: noop,
  };
  return render(
    <TooltipProvider delayDuration={0}>
      <PaneContext.Provider value={value}>
        <PaneMaximizeButton />
        <BrowserOverlayProbe />
      </PaneContext.Provider>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete window.bbDesktop;
});

describe("PaneMaximizeButton", () => {
  it("renders a keyboard-focusable native button that maximizes a web pane", () => {
    const onToggle = vi.fn();
    renderButton(false, onToggle);
    const button = screen.getByRole("button", {
      name: "Maximize pane (⌘⇧E)",
    });

    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+E");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("restores a web split on click and uses the clear tooltip copy", async () => {
    const onToggle = vi.fn();
    renderButton(true, onToggle);
    const button = screen.getByRole("button", {
      name: "Restore split (⌘⇧E)",
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.focus(button);
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("tooltip")
          .some((tooltip) => tooltip.textContent?.includes("Restore split")),
      ).toBe(true);
    });

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows only BB's supported split arrangement actions on hover", async () => {
    const onMoveToSide = vi.fn();
    renderButton(false, noop, onMoveToSide);
    const button = screen.getByRole("button", {
      name: "Maximize pane (⌘⇧E)",
    });

    fireEvent.pointerEnter(button);
    const menu = await screen.findByRole("menu", { name: "Pane arrangement" });
    expect(menu.textContent).toContain("Maximize pane");
    expect(menu.textContent).toContain("Move");
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Maximize pane⌘⇧E", "", "", "", ""]);
    for (const side of ["left", "right", "top", "bottom"]) {
      const action = screen.getByRole("menuitem", {
        name: `Move ${side}`,
      });
      expect(
        action.querySelector(`[data-pane-arrangement-glyph="${side}"]`),
      ).not.toBeNull();
      expect(action.className).toContain("cursor-pointer");
    }
    expect(
      screen.getByRole("menuitem", { name: /Maximize pane/ }).className,
    ).toContain("cursor-pointer");

    fireEvent.click(screen.getByRole("menuitem", { name: "Move left" }));
    expect(onMoveToSide).toHaveBeenCalledWith("left");
  });

  it("keeps the arrangement menu open for keyboard focus and enters it with Arrow Down", async () => {
    const onMoveToSide = vi.fn();
    renderButton(false, noop, onMoveToSide);
    const button = screen.getByRole("button", {
      name: "Maximize pane (⌘⇧E)",
    });

    fireEvent.focus(button);
    const menu = await screen.findByRole("menu", { name: "Pane arrangement" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(menu.isConnected).toBe(true);

    fireEvent.keyDown(button, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: /Maximize pane/ }),
      ),
    );

    const moveBottom = screen.getByRole("menuitem", { name: "Move bottom" });
    moveBottom.focus();
    moveBottom.click();
    expect(onMoveToSide).toHaveBeenCalledWith("bottom");
  });

  it("keeps the menu closed while the pointer only passes over the button", async () => {
    renderButton(false);
    const button = screen.getByRole("button", {
      name: "Maximize pane (⌘⇧E)",
    });

    fireEvent.pointerEnter(button);
    fireEvent.pointerLeave(button);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByRole("menu", { name: "Pane arrangement" })).toBeNull();
  });

  it("preserves full-screen copy in every desktop app context", async () => {
    const desktopInfo: BbDesktopInfo = {
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "linux",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.0-test",
    };
    window.bbDesktop = createBbDesktopApi(desktopInfo);
    renderButton(false);

    const button = screen.getByRole("button", {
      name: "Full Screen (⌘⇧E)",
    });
    fireEvent.focus(button);
    const menu = await screen.findByRole("menu", { name: "Pane arrangement" });
    expect(
      screen.getByRole("menuitem", { name: /Full Screen/ }),
    ).not.toBeNull();
    expect(menu.textContent).not.toContain("Maximize pane");
  });

  it("hides the native desktop browser while the arrangement menu can cover it", async () => {
    const desktopInfo: BbDesktopInfo = {
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.0-test",
    };
    window.bbDesktop = createBbDesktopApi(desktopInfo);
    renderButton(false);
    expect(screen.getByTestId("browser-overlay-state").textContent).toBe(
      "visible",
    );

    const trigger = screen.getByRole("button", {
      name: "Full Screen (⌘⇧E)",
    });
    fireEvent.pointerEnter(trigger);
    const menu = await screen.findByRole("menu", {
      name: "Pane arrangement",
    });
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerEnter(menu);
    await waitFor(() =>
      expect(screen.getByTestId("browser-overlay-state").textContent).toBe(
        "hidden",
      ),
    );

    fireEvent.pointerLeave(menu);
    await waitFor(() =>
      expect(screen.getByTestId("browser-overlay-state").textContent).toBe(
        "visible",
      ),
    );
  });

  it("does not render outside a multi-pane workspace", () => {
    const value: PaneContextValue = {
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
      navigateInPane: noop,
    };
    render(
      <PaneContext.Provider value={value}>
        <PaneMaximizeButton />
      </PaneContext.Provider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("resolvePaneArrangementLabel", () => {
  it.each([
    [false, false, "Maximize pane"],
    [false, true, "Restore split"],
    [true, false, "Full Screen"],
    [true, true, "Exit Full Screen"],
  ] as const)(
    "resolves desktop=%s fullScreen=%s as %s",
    (isDesktopApp, isFullScreen, expected) => {
      expect(resolvePaneArrangementLabel({ isDesktopApp, isFullScreen })).toBe(
        expected,
      );
    },
  );
});
