// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSelector } from "./ProjectSelector";

const PROJECTS = [
  { id: "proj_alpha", name: "Alpha Web" },
  { id: "proj_bravo", name: "Bravo API" },
  { id: "proj_charlie", name: "Charlie Docs" },
  { id: "proj_delta", name: "Delta Mobile" },
  { id: "proj_echo", name: "Echo Infra" },
  { id: "proj_foxtrot", name: "Foxtrot Design" },
] as const;

afterEach(cleanup);

describe("ProjectSelector", () => {
  it("exposes the current project separately from keyboard highlight", () => {
    render(
      <ProjectSelector
        projects={PROJECTS}
        value="proj_charlie"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Project: Charlie Docs" }),
    ).toBeTruthy();
    const search = screen.getByRole("combobox", { name: "Search projects" });
    const alpha = screen.getByRole("option", { name: "Alpha Web" });
    const bravo = screen.getByRole("option", { name: "Bravo API" });
    const charlie = screen.getByRole("option", { name: "Charlie Docs" });
    expect(alpha.getAttribute("aria-selected")).toBe("true");
    expect(charlie.getAttribute("aria-selected")).toBe("false");
    expect(charlie.getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(bravo.getAttribute("aria-selected")).toBe("true");
    expect(charlie.getAttribute("aria-current")).toBe("true");
  });

  it("shows search only when there are more than five projects", () => {
    const result = render(
      <ProjectSelector
        projects={PROJECTS.slice(0, 5)}
        value="proj_alpha"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen.queryByRole("combobox", { name: "Search projects" }),
    ).toBeNull();

    result.rerender(
      <ProjectSelector
        projects={PROJECTS}
        value="proj_alpha"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Search projects" }),
    ).toBeTruthy();
  });

  it("fuzzy-matches project names case-insensitively and selects the match", () => {
    const onChange = vi.fn();
    render(
      <ProjectSelector
        projects={PROJECTS}
        value="proj_alpha"
        onChange={onChange}
        defaultOpen
        modal={false}
      />,
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Search projects" }),
      { target: { value: "CD" } },
    );

    expect(screen.queryByRole("option", { name: "Alpha Web" })).toBeNull();
    expect(screen.getByRole("option", { name: "Charlie Docs" })).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search projects" }),
      { key: "Enter" },
    );

    expect(onChange).toHaveBeenCalledWith("proj_charlie");
    expect(screen.queryByRole("dialog", { name: "Project" })).toBeNull();
  });

  it("keeps keyboard selection for short project lists", () => {
    const onChange = vi.fn();
    render(
      <ProjectSelector
        projects={PROJECTS.slice(0, 5)}
        value="proj_alpha"
        onChange={onChange}
        defaultOpen
        modal={false}
      />,
    );

    const command = document.querySelector<HTMLElement>("[cmdk-root]");
    expect(command).not.toBeNull();
    expect(document.activeElement).toBe(command);

    if (command === null) return;
    fireEvent.keyDown(command, { key: "ArrowDown" });
    fireEvent.keyDown(command, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("proj_bravo");
  });

  it("keeps project actions visible and resets search after closing", () => {
    const onCreate = vi.fn();
    render(
      <ProjectSelector
        projects={PROJECTS}
        value={null}
        onChange={() => {}}
        allowNoProject
        createProject={{ onCreate }}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen
        .getByRole("option", { name: "Don't work in a project" })
        .getAttribute("aria-current"),
    ).toBe("true");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search projects" }),
      { target: { value: "missing" } },
    );

    expect(screen.getByText("No projects found")).toBeTruthy();
    expect(screen.getByRole("option", { name: "New project" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Don't work in a project" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: "New project" }));
    expect(onCreate).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Project: Work in a project" }),
    );
    expect(
      screen.getByRole<HTMLInputElement>("combobox", {
        name: "Search projects",
      }).value,
    ).toBe("");
    expect(screen.getByRole("option", { name: "Alpha Web" })).toBeTruthy();
  });

  it("keeps empty-list actions in the project group", () => {
    render(
      <ProjectSelector
        projects={[]}
        value={null}
        onChange={() => {}}
        allowNoProject
        createProject={{ onCreate: () => {} }}
        defaultOpen
        modal={false}
      />,
    );

    const groups = document.querySelectorAll("[cmdk-group]");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelector("[cmdk-group-heading]")?.textContent).toBe(
      "Project",
    );
    expect(groups[0]?.querySelectorAll("[cmdk-item]")).toHaveLength(2);
  });

  it("keeps the search fixed while the project results scroll", () => {
    render(
      <ProjectSelector
        projects={Array.from({ length: 20 }, (_, index) => ({
          id: `proj_${index}`,
          name: `Project ${index}`,
        }))}
        value="proj_0"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Project" });
    expect(dialog.className).toContain(
      "max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))]",
    );
    expect(dialog.className).toContain("overflow-hidden");

    const list = document.querySelector<HTMLElement>("[cmdk-list]");
    expect(list).not.toBeNull();
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("overscroll-contain");

    if (list === null) return;
    list.scrollTop = 120;
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search projects" }),
      { target: { value: "Project 19" } },
    );
    expect(list.scrollTop).toBe(0);
  });
});
