// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginSlotMount,
  resetAllCrashedPluginSlotsForTest,
  resetCrashedPluginSlots,
} from "./PluginSlotMount";
import { applyPluginCss, resetPluginCssForTest } from "@/lib/plugin-css";

function Bomb(): never {
  throw new Error("kaboom");
}

function Healthy() {
  return <div>healthy slot</div>;
}

describe("PluginSlotMount", () => {
  beforeEach(() => {
    resetAllCrashedPluginSlotsForTest();
    resetPluginCssForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    resetPluginCssForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collapses a throwing slot to a crash chip and keeps siblings alive", () => {
    render(
      <>
        <PluginSlotMount
          pluginId="broken"
          slotKind="homepageSection"
          slotId="a"
        >
          <Bomb />
        </PluginSlotMount>
        <PluginSlotMount pluginId="fine" slotKind="homepageSection" slotId="b">
          <Healthy />
        </PluginSlotMount>
      </>,
    );

    expect(screen.getByText("plugin broken crashed")).toBeDefined();
    expect(screen.getByText("healthy slot")).toBeDefined();
  });

  it("renders nothing after a crash when the fallback is explicitly null", () => {
    render(
      <PluginSlotMount
        pluginId="broken"
        slotKind="appOverlay"
        slotId="widget"
        crashFallback={null}
      >
        <Bomb />
      </PluginSlotMount>,
    );

    expect(screen.queryByText("plugin broken crashed")).toBeNull();
  });

  it("keeps one sheet through simultaneous mounts and a portal until the final route unmount", async () => {
    vi.useFakeTimers();
    applyPluginCss("demo", "/demo.css?h=v1");
    function PortalContent() {
      return createPortal(<div>portalled plugin content</div>, document.body);
    }
    const view = render(
      <>
        <PluginSlotMount pluginId="demo" slotKind="navPanel" slotId="main">
          <Healthy />
        </PluginSlotMount>
        <PluginSlotMount
          pluginId="demo"
          slotKind="threadPanelAction"
          slotId="details"
        >
          <PortalContent />
        </PluginSlotMount>
      </>,
    );
    const pluginSheets = () =>
      document.head.querySelectorAll('link[data-bb-plugin-css="demo"]');
    expect(pluginSheets()).toHaveLength(1);
    expect(screen.getByText("portalled plugin content")).toBeDefined();

    view.rerender(
      <PluginSlotMount
        pluginId="demo"
        slotKind="threadPanelAction"
        slotId="details"
      >
        <PortalContent />
      </PluginSlotMount>,
    );
    expect(pluginSheets()).toHaveLength(1);

    view.unmount();
    await act(async () => {});
    expect(pluginSheets()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(pluginSheets()).toHaveLength(0);
  });

  it("keeps a crashed slot instance disabled for the session across remounts", () => {
    const first = render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Bomb />
      </PluginSlotMount>,
    );
    first.unmount();

    const childRender = vi.fn(() => <div>should not render</div>);
    function Child() {
      return childRender();
    }
    render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Child />
      </PluginSlotMount>,
    );
    expect(screen.getByText("plugin broken crashed")).toBeDefined();
    expect(childRender).not.toHaveBeenCalled();
  });

  it("re-enables a plugin's slots after resetCrashedPluginSlots (reload path)", () => {
    const first = render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Bomb />
      </PluginSlotMount>,
    );
    first.unmount();
    resetCrashedPluginSlots("broken");

    render(
      <PluginSlotMount pluginId="broken" slotKind="navPanel" slotId="board">
        <Healthy />
      </PluginSlotMount>,
    );
    expect(screen.getByText("healthy slot")).toBeDefined();
  });
});
