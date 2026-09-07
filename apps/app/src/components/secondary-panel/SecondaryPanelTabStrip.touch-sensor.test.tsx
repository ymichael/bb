// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SecondaryPanelTabStrip,
  type SecondaryPanelTabStripProps,
} from "./SecondaryPanelTabStrip";

function makeTabs(count: number): SecondaryPanelTabStripProps["tabs"] {
  return Array.from({ length: count }, (_, index) => ({
    label: `file-${index}.ts`,
    isPinned: false,
    leadingVisual: null,
    statusLabel: null,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    renderContent: () => null,
    tab: { id: `tab-${index}`, kind: "new-tab" as const },
  }));
}

function touchMoveCalls(spy: {
  mock: { calls: readonly (readonly unknown[])[] };
}) {
  return spy.mock.calls.filter(([type]) => type === "touchmove");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SecondaryPanelTabStrip touch sensor scoping", () => {
  it("installs dnd-kit's window touchmove listener only while the panel is open with tabs to reorder, and removes it on close", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const baseProps: SecondaryPanelTabStripProps = {
      activeTabId: "tab-0",
      tabs: makeTabs(2),
      onReorderTab: vi.fn(),
      usesDesktopChrome: false,
      isPanelOpen: false,
    };

    const { rerender } = render(<SecondaryPanelTabStrip {...baseProps} />);
    expect(touchMoveCalls(addSpy)).toHaveLength(0);

    rerender(<SecondaryPanelTabStrip {...baseProps} isPanelOpen />);
    const installs = touchMoveCalls(addSpy);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.[2]).toEqual({ capture: false, passive: false });

    rerender(<SecondaryPanelTabStrip {...baseProps} isPanelOpen={false} />);
    expect(touchMoveCalls(removeSpy)).toHaveLength(1);
    expect(touchMoveCalls(addSpy)).toHaveLength(1);

    rerender(
      <SecondaryPanelTabStrip {...baseProps} tabs={makeTabs(1)} isPanelOpen />,
    );
    expect(touchMoveCalls(addSpy)).toHaveLength(1);
  });
});
