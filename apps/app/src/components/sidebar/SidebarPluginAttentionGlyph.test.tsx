// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import { SidebarPluginAttentionGlyph } from "./SidebarPluginAttentionGlyph";
import { makePluginListItem } from "@/test/fixtures/plugins";

const usePluginListMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/queries/plugin-settings-queries", () => ({
  usePluginList: usePluginListMock,
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function plugin(overrides: Partial<PluginListItem>): PluginListItem {
  return makePluginListItem({
    id: "notify",
    name: "Notify",
    status: "incompatible",
    statusDetail: "requires bb >=0.38.0 <0.39.0, this is 0.39.0",
    ...overrides,
  });
}

function renderGlyph(plugins: PluginListItem[]) {
  usePluginListMock.mockReturnValue({ data: { plugins } });
  return render(
    <Provider>
      <MemoryRouter>
        <SidebarProvider>
          <SidebarPluginAttentionGlyph className="footer-action" />
        </SidebarProvider>
      </MemoryRouter>
    </Provider>,
  );
}

const glyph = () => screen.queryByTestId("sidebar-plugin-attention-glyph");

describe("SidebarPluginAttentionGlyph", () => {
  it("renders nothing while every enabled plugin runs", () => {
    renderGlyph([
      plugin({ status: "running" }),
      plugin({ id: "off", enabled: false, status: "incompatible" }),
    ]);
    expect(glyph()).toBeNull();
  });

  it("names the plugin, links to Installed plugins, and uses the warning tone", () => {
    renderGlyph([plugin({})]);
    const el = glyph()!;
    expect(el.getAttribute("aria-label")).toBe(
      "Notify is incompatible: requires bb >=0.38.0 <0.39.0, this is 0.39.0",
    );
    expect(el.getAttribute("href")).toBe("/settings/plugins");
    expect(el.className).toContain("text-warning-text");
    expect(el.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();
  });

  it("hides on click, stays hidden for the same set across a remount, and returns on any change", () => {
    renderGlyph([plugin({})]);
    fireEvent.click(glyph()!);
    expect(glyph()).toBeNull();
    cleanup();

    renderGlyph([plugin({})]);
    expect(glyph()).toBeNull();
    cleanup();

    renderGlyph([plugin({ status: "error", statusDetail: "boom" })]);
    expect(glyph()).not.toBeNull();
    cleanup();

    renderGlyph([
      plugin({}),
      plugin({ id: "foo", name: "Foo", status: "missing" }),
    ]);
    expect(glyph()?.getAttribute("aria-label")).toBe(
      "2 plugins are not running",
    );
  });

  it("clears the acknowledgement when the count drops to zero", () => {
    renderGlyph([plugin({})]);
    fireEvent.click(glyph()!);
    cleanup();

    renderGlyph([]);
    expect(glyph()).toBeNull();
    cleanup();

    renderGlyph([plugin({})]);
    expect(glyph()).not.toBeNull();
  });
});
