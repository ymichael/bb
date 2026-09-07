// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelGroup } from "react-resizable-panels";
import { LazyThreadSecondaryPanel } from "./lazySecondaryPanelComponents";

vi.mock("./ThreadSecondaryPanel", () => new Promise(() => {}));

afterEach(cleanup);

const noop = () => {};

function renderLoadingPanel({
  isConversationCollapsed = false,
  isOpen = true,
}: {
  isConversationCollapsed?: boolean;
  isOpen?: boolean;
} = {}) {
  return render(
    <PanelGroup direction="horizontal">
      <LazyThreadSecondaryPanel
        activeTab={null}
        canUseGitUi={false}
        drawerFallback={null}
        fixedTabs={[]}
        isConversationCollapsed={isConversationCollapsed}
        isOpen={isOpen}
        metadataContent={null}
        onClose={noop}
        onCollapse={noop}
        onOpenNewTab={noop}
        onPanelFocus={noop}
        onTabReorder={noop}
        onToggleConversationCollapse={noop}
        renderAsDrawer={false}
        tabs={[]}
      />
    </PanelGroup>,
  );
}

describe("LazyThreadSecondaryPanel", () => {
  it("keeps the panel seam visible while inline content loads", () => {
    renderLoadingPanel();

    const placeholder = screen.getByTestId(
      "thread-secondary-panel-placeholder",
    );
    expect(placeholder.className).toContain("border-l");
    expect(placeholder.className).toContain("border-border-seam");
  });

  it("does not show the loading seam when the panel is closed or full screen", () => {
    const view = renderLoadingPanel({ isOpen: false });

    expect(
      screen.getByTestId("thread-secondary-panel-placeholder").className,
    ).not.toContain("border-l");

    view.unmount();
    renderLoadingPanel({ isConversationCollapsed: true });

    expect(
      screen.getByTestId("thread-secondary-panel-placeholder").className,
    ).not.toContain("border-l");
  });
});
