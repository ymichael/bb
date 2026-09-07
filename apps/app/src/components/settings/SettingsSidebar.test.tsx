// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SETTINGS_NAV_SECTIONS } from "./settings-sections";
import { SettingsSidebarContent } from "./SettingsSidebar";

const configurablePlugin = {
  icon: null,
  id: "linear",
  label: "Linear",
};

function renderSidebar(activePluginId: string | null = null) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SettingsSidebarContent
          appRoutePath="/"
          isResizing={false}
          mobileHosted
          navigation={{
            activePluginId,
            activeSection: activePluginId === null ? "general" : null,
            pluginEntries: [configurablePlugin],
            sections: SETTINGS_NAV_SECTIONS,
          }}
          onResizeMouseDown={() => {}}
          showTopReserve={false}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("SettingsSidebarContent plugin navigation", () => {
  it("offers installed management and configurable plugins without an extra plugin group", () => {
    renderSidebar();
    expect(
      screen
        .getByRole("link", { name: "Installed plugins" })
        .getAttribute("href"),
    ).toBe("/settings/plugins");
    expect(
      screen.getByRole("link", { name: "Linear" }).getAttribute("href"),
    ).toBe("/settings/plugins/linear");
    expect(
      screen.queryByRole("button", { name: /Other installed plugins/ }),
    ).toBeNull();
  });

  it("marks the active plugin settings page", () => {
    renderSidebar("linear");
    expect(
      screen.getByRole("link", { name: "Linear" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});
