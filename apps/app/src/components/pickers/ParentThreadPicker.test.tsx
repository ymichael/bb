// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ParentThreadPicker,
  type ParentThreadPickerProps,
} from "./ParentThreadPicker";

const OPTIONS = [
  { value: "none", label: "None" },
  { value: "thr_codex_parent", label: "Codex Parent" },
  { value: "thr_frontend_parent", label: "Frontend Parent" },
] as const;

function picker(overrides: Partial<ParentThreadPickerProps> = {}) {
  return (
    <ParentThreadPicker
      value="none"
      options={OPTIONS}
      isLoading={false}
      isError={false}
      onChange={vi.fn()}
      onOpenChange={vi.fn()}
      onRetry={vi.fn()}
      {...overrides}
    />
  );
}

afterEach(cleanup);

describe("ParentThreadPicker", () => {
  it("exposes the current parent separately from keyboard highlight", () => {
    render(
      picker({
        value: "thr_frontend_parent",
        defaultOpen: true,
      }),
    );

    const search = screen.getByRole("combobox", {
      name: "Search parent threads",
    });
    const none = screen.getByRole("option", { name: "None" });
    const codex = screen.getByRole("option", { name: "Codex Parent" });
    const frontend = screen.getByRole("option", { name: "Frontend Parent" });
    expect(none.getAttribute("aria-selected")).toBe("true");
    expect(frontend.getAttribute("aria-selected")).toBe("false");
    expect(frontend.getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(codex.getAttribute("aria-selected")).toBe("true");
    expect(frontend.getAttribute("aria-current")).toBe("true");
  });

  it("requests candidates only when opened", async () => {
    const onOpenChange = vi.fn();
    render(picker({ isLoading: true, onOpenChange }));

    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Loading threads…")).toBeTruthy();
  });

  it("offers a retry after candidate loading fails and shows recovered results", async () => {
    const onRetry = vi.fn();
    const result = render(picker({ isError: true, options: [], onRetry }));

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByText("Retry loading threads"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    result.rerender(picker());
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Codex Parent")).toBeTruthy();
  });

  it("fuzzy-searches candidates by title and selects the match", async () => {
    const onChange = vi.fn();
    render(picker({ onChange }));

    fireEvent.click(screen.getByRole("button"));
    const search = await screen.findByRole("combobox", {
      name: "Search parent threads",
    });
    fireEvent.change(search, { target: { value: "frpar" } });

    expect(screen.queryByRole("option", { name: /Codex Parent/u })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Frontend Parent/u }));

    expect(onChange).toHaveBeenCalledWith("thr_frontend_parent");
    expect(
      screen.queryByRole("combobox", { name: "Search parent threads" }),
    ).toBeNull();
  });

  it("augments thread titles with thread IDs", async () => {
    render(picker());

    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(
      await screen.findByRole("combobox", {
        name: "Search parent threads",
      }),
      { target: { value: "frontend_parent" } },
    );

    expect(screen.queryByRole("option", { name: /Codex Parent/u })).toBeNull();
    expect(
      screen.getByRole("option", { name: /Frontend Parent/u }),
    ).toBeTruthy();
  });

  it("returns the results viewport to the top when searching", async () => {
    render(picker());

    fireEvent.click(screen.getByRole("button"));
    const search = await screen.findByRole("combobox", {
      name: "Search parent threads",
    });
    const list = document.querySelector<HTMLElement>("[cmdk-list]");
    expect(list).not.toBeNull();
    if (list === null) return;
    list.scrollTop = 120;

    fireEvent.change(search, { target: { value: "frontend" } });

    expect(list.scrollTop).toBe(0);
  });
});
