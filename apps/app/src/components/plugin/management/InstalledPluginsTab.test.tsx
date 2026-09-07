// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { type PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import { InstalledPluginRow } from "./InstalledPluginsTab";
import { makePluginListItem } from "@/test/fixtures/plugins";

function plugin(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return makePluginListItem({
    id: "notify",
    source: "path:/tmp/bb-plugin-notify",
    rootDir: "/tmp/bb-plugin-notify",
    version: "0.2.1",
    description: "Desktop notifications when a thread needs you.",
    name: "Notify",
    sourceDisplay: "path · /tmp/bb-plugin-notify",
    ...overrides,
  });
}

function renderRow(item: PluginListItem) {
  const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter>
      <QueryClientWrapper>
        <InstalledPluginRow plugin={item} onUpdateClick={vi.fn()} />
      </QueryClientWrapper>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("InstalledPluginRow", () => {
  it("shows the status word and detail and marks the switch when a plugin is not running", () => {
    renderRow(
      plugin({
        status: "incompatible",
        statusDetail: "requires bb >=0.38.0 <0.39.0, this is 0.39.0",
      }),
    );

    expect(screen.getByTestId("plugin-runtime-status-notify").textContent).toBe(
      "Incompatible",
    );
    expect(
      screen.getByText("requires bb >=0.38.0 <0.39.0, this is 0.39.0"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("switch", {
          name: "Disable notify (incompatible, not running)",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("does not call a needs-configuration plugin not running", () => {
    renderRow(
      plugin({
        status: "needs-configuration",
        statusDetail: "Set an API token.",
      }),
    );

    expect(screen.getByText("Set an API token.")).toBeTruthy();
    expect(screen.queryByTestId("plugin-not-running-notify")).toBeNull();
  });
});
