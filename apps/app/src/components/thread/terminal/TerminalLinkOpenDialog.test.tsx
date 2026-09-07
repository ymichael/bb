// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalLinkOpenDialog } from "./TerminalLinkOpenDialog";

const TARGET = {
  source: "osc8" as const,
  uri: "https://example.com/hidden-target?token=visible",
};

afterEach(cleanup);

describe("TerminalLinkOpenDialog", () => {
  it("discloses the exact target and cancels without opening it", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <TerminalLinkOpenDialog
        target={TARGET}
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Link target").textContent).toBe(TARGET.uri);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms the exact disclosed target", () => {
    const onConfirm = vi.fn();

    render(
      <TerminalLinkOpenDialog
        target={TARGET}
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith(TARGET);
  });
});
