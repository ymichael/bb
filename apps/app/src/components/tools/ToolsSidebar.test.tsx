// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ToolsSidebar } from "./ToolsSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

afterEach(cleanup);

const PAGE_ROWS = [
  "Browse plugins",
  "Installed plugins",
  "Browse skills",
  "My skills",
];

function renderAt(path: string, appRoutePath = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <ToolsSidebar
          appRoutePath={appRoutePath}
          isResizing={false}
          onResizeMouseDown={() => {}}
          showTopReserve={false}
        />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

const row = (name: string) => screen.getByRole("link", { name });

describe("ToolsSidebar", () => {
  it("lists every Extensions page under its section and keeps the back target", () => {
    renderAt("/extensions/plugins", "/projects/proj_one");

    expect(screen.getByText("Plugins")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(row("Browse plugins").getAttribute("href")).toBe(
      "/extensions/plugins",
    );
    expect(row("Installed plugins").getAttribute("href")).toBe(
      "/extensions/plugins?view=installed",
    );
    expect(row("Browse skills").getAttribute("href")).toBe(
      "/extensions/skills",
    );
    expect(row("My skills").getAttribute("href")).toBe(
      "/extensions/skills?view=library",
    );
    expect(row("Back to app").getAttribute("href")).toBe("/projects/proj_one");
  });

  it.each([
    ["/extensions/plugins", "Browse plugins"],
    ["/extensions/plugins?view=installed", "Installed plugins"],
    ["/extensions/plugins/github", "Browse plugins"],
    ["/extensions/plugins/github?view=installed", "Browse plugins"],
    ["/extensions/skills", "Browse skills"],
    ["/extensions/skills/registry", "Browse skills"],
    ["/extensions/skills?view=library", "My skills"],
    ["/extensions/skills/library/my-skill", "My skills"],
    ["/extensions/skills/installed/my-skill", "My skills"],
    ["/extensions/skills/registry/owner%2Frepo%2Fskill", "Browse skills"],
  ])("marks exactly one active page for %s", (path, expected) => {
    renderAt(path);
    const activeRows = PAGE_ROWS.filter(
      (name) => row(name).getAttribute("aria-current") === "page",
    );
    expect(activeRows).toEqual([expected]);
  });
});
