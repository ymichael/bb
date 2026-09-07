// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MenuHoverProvider,
  useMenuItemHover,
} from "@bb/shared-ui/menu-item-hover";

function HoverItem({ label }: { label: string }) {
  const { hoverProps } = useMenuItemHover();
  return (
    <button type="button" {...hoverProps}>
      {label}
    </button>
  );
}

function Harness() {
  return (
    <MenuHoverProvider>
      <HoverItem label="A" />
      <HoverItem label="B" />
    </MenuHoverProvider>
  );
}

afterEach(cleanup);

describe("menu persistent last-hovered", () => {
  it("persists the highlight on the last pointer-hovered item and moves it", () => {
    render(<Harness />);
    const a = screen.getByText("A");
    const b = screen.getByText("B");

    expect(a.hasAttribute("data-last-hovered")).toBe(false);

    fireEvent.pointerEnter(a);
    expect(a.hasAttribute("data-last-hovered")).toBe(true);
    expect(b.hasAttribute("data-last-hovered")).toBe(false);

    fireEvent.pointerEnter(b);
    expect(a.hasAttribute("data-last-hovered")).toBe(false);
    expect(b.hasAttribute("data-last-hovered")).toBe(true);
  });

  it("hands the highlight back to keyboard navigation", () => {
    render(<Harness />);
    const a = screen.getByText("A");

    fireEvent.pointerEnter(a);
    expect(a.hasAttribute("data-last-hovered")).toBe(true);

    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(a.hasAttribute("data-last-hovered")).toBe(false);
  });
});
