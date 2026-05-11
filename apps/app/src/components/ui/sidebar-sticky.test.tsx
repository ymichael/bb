// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarStickyStack, SidebarStickyTier } from "@/components/ui/sidebar";

function requireHTMLElement(
  value: Element | null,
  message: string,
): HTMLElement {
  if (!(value instanceof HTMLElement)) {
    throw new Error(message);
  }

  return value;
}

afterEach(() => {
  cleanup();
});

describe("SidebarStickyStack", () => {
  it("renders a scoped sticky stack with labeled tiers and no overflow fades", () => {
    const view = render(
      <SidebarStickyStack>
        <SidebarStickyTier tier="label">Projects</SidebarStickyTier>
        <SidebarStickyTier tier="project">
          Sidebar Project Title
        </SidebarStickyTier>
        <SidebarStickyTier tier="manager">Manager Notes</SidebarStickyTier>
      </SidebarStickyStack>,
    );

    const stack = requireHTMLElement(
      view.container.querySelector("[data-sidebar-sticky-stack]"),
      "Expected the sticky stack container to render",
    );
    const label = requireHTMLElement(
      screen.getByText("Projects").closest("[data-sidebar-sticky-tier]"),
      "Expected the label tier to render",
    );
    const project = requireHTMLElement(
      screen
        .getByText("Sidebar Project Title")
        .closest("[data-sidebar-sticky-tier]"),
      "Expected the project tier to render",
    );
    const manager = requireHTMLElement(
      screen.getByText("Manager Notes").closest("[data-sidebar-sticky-tier]"),
      "Expected the manager tier to render",
    );

    expect(stack.contains(label)).toBe(true);
    expect(stack.contains(project)).toBe(true);
    expect(stack.contains(manager)).toBe(true);
    expect(label.getAttribute("data-sidebar-sticky-tier")).toBe("label");
    expect(project.getAttribute("data-sidebar-sticky-tier")).toBe("project");
    expect(manager.getAttribute("data-sidebar-sticky-tier")).toBe("manager");
    expect(label.querySelector("[data-overflow-fade]")).toBeNull();
    expect(project.querySelector("[data-overflow-fade]")).toBeNull();
  });
});
