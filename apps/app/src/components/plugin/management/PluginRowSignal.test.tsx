// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRowSignalView } from "./PluginRowSignal";
import { displayPluginVersion } from "./plugin-ui";

afterEach(cleanup);

describe("PluginRowSignalView", () => {
  it("uses the shared update-action icon", () => {
    render(
      <PluginRowSignalView
        signal={{ kind: "update", version: "1.9.0" }}
        onUpdateClick={vi.fn()}
        onStatusClick={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole("button", {
          name: "Update to 1.9.0",
        })
        .querySelector('[data-icon="Download"]'),
    ).not.toBeNull();
  });

  it("keeps runtime health icon-only until hover or focus and opens details", async () => {
    const onStatusClick = vi.fn();
    render(
      <PluginRowSignalView
        signal={{
          kind: "status",
          icon: "AlertTriangle",
          label: "Degraded",
          tone: "warning",
          detail: "One background service failed.",
        }}
        onUpdateClick={vi.fn()}
        onStatusClick={onStatusClick}
      />,
    );

    const statusButton = screen.getByRole("button", {
      name: "Degraded: One background service failed.",
    });
    expect(screen.queryByText("Degraded")).toBeNull();

    fireEvent.focus(statusButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Degraded: One background service failed.",
    );

    fireEvent.click(statusButton);
    expect(onStatusClick).toHaveBeenCalledOnce();
  });

  it("names readable versions and hides commit hashes in the update control", () => {
    const { rerender } = render(
      <PluginRowSignalView
        signal={{ kind: "update", version: "1.2.0" }}
        onUpdateClick={vi.fn()}
        onStatusClick={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Update to 1.2.0" }),
    ).toBeTruthy();

    rerender(
      <PluginRowSignalView
        signal={{
          kind: "update",
          version: "a985e1d5523398e9c7459d35679142cc4339771e",
        }}
        onUpdateClick={vi.fn()}
        onStatusClick={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Update available" });
    expect(button.getAttribute("aria-label")).not.toContain("a985e1d");
  });
});

describe("displayPluginVersion", () => {
  it("shortens only long hex hashes, never versions, tags, or refs", () => {
    expect(
      displayPluginVersion("a985e1d5523398e9c7459d35679142cc4339771e"),
    ).toBe("a985e1d");
    expect(displayPluginVersion("1.2.0")).toBe("1.2.0");
    expect(displayPluginVersion("v1.2.0-rc.1")).toBe("v1.2.0-rc.1");
    expect(displayPluginVersion("main")).toBe("main");
    expect(displayPluginVersion("deadbee")).toBe("deadbee");
  });
});
