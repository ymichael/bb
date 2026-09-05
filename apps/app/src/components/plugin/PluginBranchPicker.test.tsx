// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginBranchPicker } from "./PluginBranchPicker";
import {
  usePluginBranches,
  usePluginCheckoutState,
  usePluginDefaultWorktreeBaseBranch,
} from "./usePluginBranchPickerState";

vi.mock("./usePluginBranchPickerState", () => ({
  usePluginBranches: vi.fn(),
  usePluginCheckoutState: vi.fn(),
  usePluginDefaultWorktreeBaseBranch: vi.fn(),
}));

const refreshBranches = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.mocked(usePluginBranches).mockReturnValue({
    branches: ["main", "release"],
    remoteBranches: ["origin/main"],
    isLoading: false,
    refresh: refreshBranches,
  });
  vi.mocked(usePluginCheckoutState).mockReturnValue({
    isGit: true,
    unborn: false,
    detached: false,
    dirty: false,
    currentBranch: "main",
    operation: { kind: "none" },
  });
  vi.mocked(usePluginDefaultWorktreeBaseBranch).mockReturnValue("main");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPicker(props: {
  value: string | null;
  label?: string;
  placeholder?: string;
  onChange?: (value: string | null) => void;
}) {
  return render(
    <PluginBranchPicker
      hostId="host-a"
      projectId="project-1"
      value={props.value}
      onChange={props.onChange ?? vi.fn()}
      {...(props.label === undefined ? {} : { label: props.label })}
      {...(props.placeholder === undefined
        ? {}
        : { placeholder: props.placeholder })}
    />,
  );
}

describe("PluginBranchPicker", () => {
  it("shows the placeholder while nothing is picked", () => {
    renderPicker({ value: null, placeholder: "Pick a base" });
    expect(
      screen.getByRole("combobox", { name: "Branch" }).textContent,
    ).toContain("Pick a base");
  });

  it("prefixes the picked branch with the label and nothing else", () => {
    renderPicker({ value: "release", label: "Base:" });
    expect(
      screen.getByRole("combobox", { name: "Branch" }).textContent,
    ).toContain("Base: release");
  });

  it("shows the branch alone without a label", () => {
    renderPicker({ value: "release" });
    const text =
      screen.getByRole("combobox", { name: "Branch" }).textContent ?? "";
    expect(text).toContain("release");
    expect(text).not.toContain("Branch from");
  });

  it("uses the resolved default base instead of the checkout branch", () => {
    vi.mocked(usePluginCheckoutState).mockReturnValue({
      isGit: true,
      unborn: false,
      detached: false,
      dirty: false,
      currentBranch: "feature",
      operation: { kind: "none" },
    });
    renderPicker({ value: null, label: "Branch from:" });
    const chipText = screen.getByRole("combobox", {
      name: "Branch",
    }).textContent;
    expect(chipText).toContain("Branch from:");
    expect(chipText).toContain("main");
    expect(chipText).not.toContain("feature");
  });

  it("refreshes and renders a standard branch list without checkout actions", () => {
    const onChange = vi.fn();
    renderPicker({ value: null, onChange });

    fireEvent.click(screen.getByRole("combobox", { name: "Branch" }));

    expect(refreshBranches).toHaveBeenCalledOnce();
    expect(screen.queryByText("New branch…")).toBeNull();
    fireEvent.click(screen.getByText("release"));
    expect(onChange).toHaveBeenCalledWith("release");
  });
});
