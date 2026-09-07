// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchPicker } from "./BranchPicker";

afterEach(cleanup);

describe("BranchPicker search", () => {
  it("uses fuzzy matching and returns the results viewport to the top", () => {
    render(
      <BranchPicker
        value="main"
        options={[
          "main",
          "develop",
          "feature/one",
          "feature/two",
          "feature/three",
        ]}
        onChange={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
    const search = screen.getByPlaceholderText("Search branches");
    const scrollArea = search.parentElement?.parentElement?.nextElementSibling;
    expect(scrollArea).toBeInstanceOf(HTMLElement);
    if (!(scrollArea instanceof HTMLElement)) return;
    scrollArea.scrollTop = 120;

    fireEvent.change(search, { target: { value: "fth" } });

    expect(scrollArea.scrollTop).toBe(0);
    expect(screen.getByText("feature/three")).toBeTruthy();
    expect(screen.queryByText("feature/two")).toBeNull();
  });

  it("uses relevance order instead of pinning the selected match", () => {
    const selectedBranch = "super-feature/three-compatibility";
    const directBranch = "feature/three";
    render(
      <BranchPicker
        value={selectedBranch}
        options={[selectedBranch, directBranch]}
        onChange={vi.fn()}
        modal={false}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));
    fireEvent.change(screen.getByPlaceholderText("Search branches"), {
      target: { value: "fth" },
    });

    const directResult = screen.getByText(directBranch);
    const selectedResult = screen.getAllByText(selectedBranch).at(-1);
    expect(selectedResult).toBeTruthy();
    if (!selectedResult) return;
    expect(
      directResult.compareDocumentPosition(selectedResult) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
