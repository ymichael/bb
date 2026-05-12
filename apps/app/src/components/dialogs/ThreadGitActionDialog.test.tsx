// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadGitActionDialog } from "./ThreadGitActionDialog";

afterEach(() => {
  cleanup();
});

describe("ThreadGitActionDialog", () => {
  it("closes immediately when submitting a commit", () => {
    const onCommit = vi.fn(() => new Promise<void>(() => {}));
    const onOpenChange = vi.fn();

    render(
      <ThreadGitActionDialog
        target={{ kind: "commit" }}
        onOpenChange={onOpenChange}
        onCommit={onCommit}
        onSquashMerge={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCommit).toHaveBeenCalled();
  });

  it("closes immediately when submitting a squash merge", () => {
    const onOpenChange = vi.fn();
    const onSquashMerge = vi.fn(() => new Promise<void>(() => {}));

    render(
      <ThreadGitActionDialog
        target={{ kind: "squash_merge" }}
        mergeBaseBranch="main"
        onOpenChange={onOpenChange}
        onCommit={vi.fn(async () => undefined)}
        onSquashMerge={onSquashMerge}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Squash merge" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSquashMerge).toHaveBeenCalledWith({
      mergeBaseBranch: "main",
    });
  });

  it("uses the squash merge handler for commit-and-squash-merge", () => {
    const onCommit = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();
    const onSquashMerge = vi.fn(async () => undefined);

    render(
      <ThreadGitActionDialog
        target={{ kind: "commit_and_squash_merge" }}
        mergeBaseBranch="main"
        onOpenChange={onOpenChange}
        onCommit={onCommit}
        onSquashMerge={onSquashMerge}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Commit + squash merge" }),
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSquashMerge).toHaveBeenCalledWith({
      mergeBaseBranch: "main",
    });
  });

  it("keeps the submit button disabled when a merge base is missing", () => {
    render(
      <ThreadGitActionDialog
        target={{ kind: "squash_merge" }}
        onOpenChange={vi.fn()}
        onCommit={vi.fn(async () => undefined)}
        onSquashMerge={vi.fn(async () => undefined)}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Squash merge" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
  });

  it("shows an inline error when submitted without a required merge base", () => {
    render(
      <ThreadGitActionDialog
        target={{ kind: "squash_merge" }}
        onOpenChange={vi.fn()}
        onCommit={vi.fn(async () => undefined)}
        onSquashMerge={vi.fn(async () => undefined)}
      />,
    );

    const form = screen.getByRole("button", {
      name: "Squash merge",
    }).closest("form");
    if (!form) {
      throw new Error("Expected a git action form");
    }

    fireEvent.submit(form);

    expect(screen.getByText("A merge base branch is required")).toBeTruthy();
  });

});
