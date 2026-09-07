// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginBrowseCategoryFilter,
  type PluginBrowseCategoryOption,
} from "./PluginBrowseControls";

const OPTIONS: PluginBrowseCategoryOption[] = [
  { id: "memory-and-context", label: "Memory & Context", count: 4 },
  { id: "security", label: "Security", count: 2 },
  { id: "tasks-and-workflows", label: "Tasks & Workflows", count: 7 },
];

function openMenu(selectionLabel: string) {
  fireEvent.click(
    screen.getByRole("button", {
      name: `Filter plugins by category: ${selectionLabel}`,
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PluginBrowseCategoryFilter", () => {
  it("shows searchable counts and checkboxes", () => {
    render(
      <PluginBrowseCategoryFilter
        selectionMode="multiple"
        options={OPTIONS}
        value={[]}
        onChange={() => undefined}
      />,
    );
    openMenu("All categories");

    expect(screen.getAllByRole("option")).toHaveLength(3);
    const security = screen.getByRole("option", { name: /Security/u });
    expect(
      security.querySelector("[data-category-option-count]")?.textContent,
    ).toBe("2");
    expect(
      security
        .querySelector("[data-category-option-checkbox]")
        ?.getAttribute("data-state"),
    ).toBe("disabled");
    const search = screen.getByRole("combobox", {
      name: "Search plugin categories",
    });
    fireEvent.change(search, { target: { value: "work" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain(
      "Tasks & Workflows",
    );
  });

  it("keeps the menu open for multiple selections", () => {
    function Harness() {
      const [value, setValue] = useState<string[]>([]);
      return (
        <PluginBrowseCategoryFilter
          selectionMode="multiple"
          options={OPTIONS}
          value={value}
          onChange={setValue}
        />
      );
    }
    render(<Harness />);
    openMenu("All categories");
    fireEvent.click(screen.getByRole("option", { name: /Security/u }));
    fireEvent.click(screen.getByRole("option", { name: /Tasks & Workflows/u }));

    expect(
      screen
        .getByRole("listbox", { name: "Plugin categories" })
        .getAttribute("aria-multiselectable"),
    ).toBe("true");
    expect(
      screen.getByRole("button", {
        name: "Filter plugins by category: Security, Tasks & Workflows",
      }).textContent,
    ).toContain("2 categories");
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(
      screen.getByRole("button", {
        name: "Filter plugins by category: All categories",
      }),
    ).toBeTruthy();
  });

  it("moves focus through options with the keyboard", () => {
    const onChange = vi.fn();
    render(
      <PluginBrowseCategoryFilter
        selectionMode="single"
        options={OPTIONS}
        value="tasks-and-workflows"
        onChange={onChange}
      />,
    );
    openMenu("Tasks & Workflows");
    const search = screen.getByRole("combobox", {
      name: "Search plugin categories",
    });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Memory & Context");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement?.textContent).toContain("Tasks & Workflows");
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps keyboard focus inside each filter instance", () => {
    render(
      <>
        <PluginBrowseCategoryFilter
          selectionMode="multiple"
          options={OPTIONS}
          value={[]}
          onChange={() => undefined}
        />
        <PluginBrowseCategoryFilter
          selectionMode="multiple"
          options={OPTIONS}
          value={[]}
          onChange={() => undefined}
        />
      </>,
    );
    const triggers = screen.getAllByRole("button", {
      name: "Filter plugins by category: All categories",
    });
    fireEvent.click(triggers[0] as HTMLButtonElement);
    const firstSearch = screen.getByRole("combobox", {
      name: "Search plugin categories",
    });
    const firstList = screen.getByRole("listbox", {
      name: "Plugin categories",
    });
    expect(firstSearch.getAttribute("aria-controls")).toBe(firstList.id);
    fireEvent.click(triggers[0] as HTMLButtonElement);
    fireEvent.click(triggers[1] as HTMLButtonElement);
    const secondSearch = screen.getByRole("combobox", {
      name: "Search plugin categories",
    });
    const secondList = screen.getByRole("listbox", {
      name: "Plugin categories",
    });
    expect(secondSearch.getAttribute("aria-controls")).toBe(secondList.id);
    expect(firstList.id).not.toBe(secondList.id);

    fireEvent.keyDown(secondSearch, { key: "ArrowDown" });
    expect(secondList.contains(document.activeElement)).toBe(true);
    expect(firstList.contains(document.activeElement)).toBe(false);
  });
});
