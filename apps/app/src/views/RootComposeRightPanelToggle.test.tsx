// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootComposeRightPanelToggle } from "./RootComposeView";

const { preloadThreadSecondaryPanel } = vi.hoisted(() => ({
  preloadThreadSecondaryPanel: vi.fn(),
}));

vi.mock(
  "@/components/secondary-panel/lazySecondaryPanelComponents",
  async (importOriginal) => ({
    ...(await importOriginal()),
    preloadThreadSecondaryPanel,
  }),
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("RootComposeRightPanelToggle", () => {
  it("uses a disclosure state without painting the whole click target as selected", () => {
    const onToggle = vi.fn();

    render(<RootComposeRightPanelToggle isOpen onToggle={onToggle} />);

    const button = screen.getByRole("button", { name: "Hide right panel" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBeNull();

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("starts loading the panel from pointer or keyboard intent", () => {
    render(<RootComposeRightPanelToggle isOpen={false} onToggle={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Show right panel" });
    fireEvent.pointerDown(button);
    fireEvent.focus(button);

    expect(preloadThreadSecondaryPanel).toHaveBeenCalledTimes(2);
  });

  it("warms the panel chunk while the browser is idle", () => {
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn(
      (callback: IdleRequestCallback): number => {
        callback({ didTimeout: false, timeRemaining: () => 50 });
        return 7;
      },
    );
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);

    render(<RootComposeRightPanelToggle isOpen={false} onToggle={vi.fn()} />);

    expect(requestIdleCallback).toHaveBeenCalledWith(
      preloadThreadSecondaryPanel,
      { timeout: 1000 },
    );
    expect(preloadThreadSecondaryPanel).toHaveBeenCalledOnce();
    cleanup();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });
});
