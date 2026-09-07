import { describe, expect, it, vi } from "vitest";
import {
  getCompactPanelPresentation,
  resolveConversationCollapseControl,
} from "./panelToggleControlState";

describe("resolveConversationCollapseControl", () => {
  it("collapses the conversation when it is shown", () => {
    const onToggleConversationCollapse = vi.fn();
    const state = resolveConversationCollapseControl({
      isConversationCollapsed: false,
      onToggleConversationCollapse,
    });

    expect(state.action).toBe("enter-full-screen");
    expect(state.label).toBe("Full Screen");
    expect(state.isFullScreen).toBe(false);
    expect(state.iconName).toBe("Maximize2");

    state.onClick();
    expect(onToggleConversationCollapse).toHaveBeenCalledTimes(1);
  });

  it("restores the conversation when it is collapsed", () => {
    const onToggleConversationCollapse = vi.fn();
    const state = resolveConversationCollapseControl({
      isConversationCollapsed: true,
      onToggleConversationCollapse,
    });

    expect(state.action).toBe("exit-full-screen");
    expect(state.label).toBe("Exit Full Screen");
    expect(state.isFullScreen).toBe(true);
    expect(state.iconName).toBe("Minimize2");

    state.onClick();
    expect(onToggleConversationCollapse).toHaveBeenCalledTimes(1);
  });
});

describe("getCompactPanelPresentation", () => {
  it("keeps thread info in the shelf so the thread stays visible beside it", () => {
    expect(getCompactPanelPresentation("thread-info")).toBe("shelf");
  });

  it("falls back to the shelf when no tab is active yet", () => {
    expect(getCompactPanelPresentation(undefined)).toBe("shelf");
  });

  it("uses the rendered fallback tab while active state catches up", () => {
    expect(getCompactPanelPresentation(undefined, "terminal")).toBe("full");
  });

  it.each([
    "git-diff",
    "terminal",
    "host-file-preview",
    "workspace-file-preview",
    "thread-storage-file-preview",
    "browser",
    "new-tab",
    "plugin-page-fixed",
    "plugin-panel",
  ])("gives %s the full page, where its content is usable", (kind) => {
    expect(getCompactPanelPresentation(kind)).toBe("full");
  });
});
