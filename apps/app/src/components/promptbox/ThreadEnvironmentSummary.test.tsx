// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadEnvironmentSummary } from "./ThreadEnvironmentSummary";

afterEach(cleanup);

describe("ThreadEnvironmentSummary", () => {
  it("uses a host-free environment label in compact prompt boxes", () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <ThreadEnvironmentSummary
          environmentLabel="Mac Studio · New worktree"
          environmentCompactLabel="Worktree"
        />
      </TooltipProvider>,
    );

    expect(
      container.querySelector('[data-promptbox-full-label=""]')?.textContent,
    ).toBe("Mac Studio · New worktree");
    expect(
      container.querySelector('[data-promptbox-compact-label=""]')?.textContent,
    ).toBe("Worktree");
  });

  it("reveals the full host and mode when the environment label is constrained", async () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <ThreadEnvironmentSummary
          environmentLabel="Bersabel's MacBook Pro"
          environmentCompactLabel="Bersabel's MacBook Pro"
        />
      </TooltipProvider>,
    );

    const environmentDisplay = container.querySelector<HTMLElement>(
      '[data-option-display=""]',
    );
    expect(environmentDisplay).not.toBeNull();
    expect(environmentDisplay!.className).not.toContain("max-w-[10rem]");
    fireEvent.focus(environmentDisplay!);

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Bersabel's MacBook Pro",
    );
  });

  it("keeps matching environment and branch labels visibly separate", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <ThreadEnvironmentSummary
          environmentLabel="bb/fix-environment-summary"
          environmentCompactLabel="bb/fix-environment-summary"
          environmentIcon="FolderGit"
          environmentTypeLabel="Local worktree"
          environmentCheckout={{
            copyErrorMessage: "Failed to copy branch name",
            copyLabel: "Copy branch name",
            copySuccessMessage: "Branch name copied",
            copyValue: "bb/fix-environment-summary",
            label: "bb/fix-environment-summary",
            rowLabel: "Branch",
            title: "Copy branch name: bb/fix-environment-summary",
          }}
        />
      </TooltipProvider>,
    );

    const copyButton = screen.getByRole("button", {
      name: "bb/fix-environment-summary",
    });
    expect(screen.getAllByText("bb/fix-environment-summary")).toHaveLength(3);
    expect(copyButton.textContent).toBe("bb/fix-environment-summary");
    expect(copyButton.querySelector('[data-icon="GitBranch"]')).not.toBeNull();
    expect(copyButton.querySelector('[data-icon="Copy"]')).toBeNull();
  });

  it.each(["Local worktree", "Remote worktree", "Local", "Remote"] as const)(
    "shows the %s environment type from the environment icon",
    async (environmentTypeLabel) => {
      render(
        <TooltipProvider delayDuration={0}>
          <ThreadEnvironmentSummary
            environmentLabel="Bersabel's MacBook Pro"
            environmentCompactLabel="Bersabel's MacBook Pro"
            environmentIcon="Laptop"
            environmentTypeLabel={environmentTypeLabel}
          />
        </TooltipProvider>,
      );

      fireEvent.focus(
        screen.getByRole("img", {
          name: `Environment type: ${environmentTypeLabel}`,
        }),
      );

      expect((await screen.findByRole("tooltip")).textContent).toBe(
        environmentTypeLabel,
      );
    },
  );

  it("explains the create-thread action in a tooltip", async () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <ThreadEnvironmentSummary
          environmentLabel="Worktree"
          onCreateNewThreadInWorktree={vi.fn()}
        />
      </TooltipProvider>,
    );

    const createThreadButton = screen.getByRole("button", {
      name: "Create thread in worktree",
    });
    expect(createThreadButton.classList).toContain("text-subtle-foreground/75");
    expect(createThreadButton.classList).toContain(
      "hover:text-muted-foreground",
    );
    expect(
      container.querySelector('[data-icon="MessageSquarePlus"]'),
    ).not.toBeNull();
    fireEvent.focus(createThreadButton);

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Create thread in worktree",
    );
  });
});
