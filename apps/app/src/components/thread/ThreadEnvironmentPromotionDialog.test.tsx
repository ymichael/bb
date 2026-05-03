// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { EnvironmentPromotionUnavailableReason } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadEnvironmentPromotionDialog } from "./ThreadEnvironmentPromotionDialog";

afterEach(() => {
  cleanup();
});

interface BaseProps {
  agentActive: boolean;
  blockers: EnvironmentPromotionUnavailableReason[];
  branchName: string;
  defaultBranch: string;
  primaryCheckoutPath: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => Promise<void>;
}

const baseProps: BaseProps = {
  agentActive: false,
  blockers: [],
  branchName: "bb/thread",
  defaultBranch: "main",
  primaryCheckoutPath: "/srv/repos/demo",
  pending: false,
  onOpenChange: () => {},
  onSubmit: async () => {},
};

describe("ThreadEnvironmentPromotionDialog", () => {
  it("renders branch, checkout, and the promote planned-change copy", () => {
    render(
      <ThreadEnvironmentPromotionDialog
        {...baseProps}
        target={{ kind: "promote" }}
      />,
    );

    expect(screen.getByText("Promote environment")).toBeTruthy();
    expect(screen.getAllByText("bb/thread").length).toBeGreaterThan(0);
    expect(screen.getByText("/srv/repos/demo")).toBeTruthy();
    expect(
      screen.getByText(
        "Check out bb/thread in the primary checkout and return the worktree to main.",
      ),
    ).toBeTruthy();
  });

  it("renders the demote planned-change copy when the target is demote", () => {
    render(
      <ThreadEnvironmentPromotionDialog
        {...baseProps}
        target={{ kind: "demote" }}
      />,
    );

    expect(screen.getByText("Demote environment")).toBeTruthy();
    expect(
      screen.getByText(
        "Check out bb/thread in the worktree and return the primary checkout to main.",
      ),
    ).toBeTruthy();
  });

  it("lists every blocker using the canonical copy strings", () => {
    render(
      <ThreadEnvironmentPromotionDialog
        {...baseProps}
        blockers={["primary_checkout_dirty", "environment_dirty"]}
        target={{ kind: "promote" }}
      />,
    );

    expect(
      screen.getByText("Clean the primary checkout before continuing."),
    ).toBeTruthy();
    expect(
      screen.getByText("Clean the environment worktree before continuing."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Promote" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows the agent-active note and disables submit when the agent is running", () => {
    render(
      <ThreadEnvironmentPromotionDialog
        {...baseProps}
        agentActive
        target={{ kind: "promote" }}
      />,
    );

    expect(
      screen.getByText("Wait for the agent to finish before continuing."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Promote" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("disables submit while a mutation is pending", () => {
    render(
      <ThreadEnvironmentPromotionDialog
        {...baseProps}
        pending
        target={{ kind: "promote" }}
      />,
    );

    expect(
      (screen.getByRole("button", { name: /Promote/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("calls onSubmit with the open target and closes on success", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <ThreadEnvironmentPromotionDialog
        {...baseProps}
        target={{ kind: "promote" }}
        onSubmit={onSubmit}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Promote" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ kind: "promote" });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("invokes onOpenChange(false) when cancel is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <ThreadEnvironmentPromotionDialog
        {...baseProps}
        target={{ kind: "promote" }}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
