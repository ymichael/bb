// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { SplitButton } from "./split-button";

afterEach(cleanup);

describe("SplitButton", () => {
  it("keeps the primary and app-picker actions independently operable with tooltips", () => {
    const onOpenPreferred = vi.fn();
    const onOpenOther = vi.fn();

    render(
      <TooltipProvider>
        <SplitButton
          primaryAction={{
            label: "Open workspace in Finder",
            onSelect: onOpenPreferred,
            content: <span aria-hidden>F</span>,
          }}
          primaryTooltip="Open in Finder"
          secondaryActions={[{ label: "VS Code", onSelect: onOpenOther }]}
          triggerLabel="Choose another app to open workspace"
          triggerTooltip="Choose another app"
          modal={false}
        />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open workspace in Finder" }),
    );
    expect(onOpenPreferred).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Choose another app to open workspace",
      }),
      { button: 0, ctrlKey: false },
    );
    const alternate = screen.getByRole("menuitem", { name: "VS Code" });
    fireEvent.click(alternate);
    expect(onOpenOther).toHaveBeenCalledTimes(1);
  });

  it("disables both halves together", () => {
    render(
      <SplitButton
        primaryAction={{ label: "Commit", onSelect: vi.fn() }}
        secondaryActions={[{ label: "Amend commit", onSelect: vi.fn() }]}
        triggerLabel="More commit actions"
        disabled
      />,
    );

    expect(
      screen.getByRole("button", { name: "Commit" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "More commit actions" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
