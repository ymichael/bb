// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { DropdownMenuItem } from "@bb/shared-ui/dropdown-menu";
import { CompactLongPressMenu } from "./compact-long-press-menu";

const LONG_PRESS_MS = 700;

function renderRow({
  onRowClick = vi.fn(),
  onOpenChange = vi.fn(),
  onRename = vi.fn(),
}: {
  onRowClick?: () => void;
  onOpenChange?: (open: boolean) => void;
  onRename?: () => void;
} = {}) {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  const utils = render(
    <CompactViewportOverrideProvider isCompactViewport>
      <CompactLongPressMenu
        label="Thread actions"
        onOpenChange={onOpenChange}
        items={<DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>}
      >
        <a href="#thread" onClick={onRowClick} data-testid="row">
          Thread row
        </a>
      </CompactLongPressMenu>
    </CompactViewportOverrideProvider>,
    { container: root },
  );
  return {
    ...utils,
    row: screen.getByTestId("row"),
    onRowClick,
    onOpenChange,
    onRename,
  };
}

function touchPointerDown(target: Element, x = 100, y = 100) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
}

afterEach(() => {
  cleanup();
  document.getElementById("root")?.remove();
  vi.useRealTimers();
});

describe("CompactLongPressMenu", () => {
  it("mounts nothing for the menu until a long press, then opens the drawer without a modal takeover", () => {
    vi.useFakeTimers();
    const { row, onOpenChange } = renderRow();

    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(document.querySelector("[role='dialog']")).toBeNull();

    touchPointerDown(row);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onOpenChange).toHaveBeenCalledWith(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();

    const root = document.getElementById("root");
    expect(root?.getAttribute("aria-hidden")).toBeNull();
    expect(root?.hasAttribute("inert")).toBe(false);
    expect(document.body.style.pointerEvents).toBe("");
  });

  it("swallows the click that follows a long press so the row does not navigate", () => {
    vi.useFakeTimers();
    const { row, onRowClick } = renderRow();

    touchPointerDown(row);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    fireEvent.pointerUp(row, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(row);
    expect(onRowClick).not.toHaveBeenCalled();

    fireEvent.click(row);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("cancels the press when the finger moves or lifts early, and ignores mouse pointers", () => {
    vi.useFakeTimers();
    const { row, onOpenChange, onRowClick } = renderRow();

    touchPointerDown(row, 100, 100);
    fireEvent.pointerMove(row, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 130,
    });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    touchPointerDown(row, 100, 100);
    fireEvent.pointerUp(row, { pointerId: 1, pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(row, {
      pointerId: 2,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
    });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(row);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("lets only the innermost menu open when menus nest (thread row inside a project section)", () => {
    vi.useFakeTimers();
    const onProjectOpenChange = vi.fn();
    const onThreadOpenChange = vi.fn();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <CompactLongPressMenu
          label="Project actions"
          onOpenChange={onProjectOpenChange}
          items={<DropdownMenuItem>Rename project</DropdownMenuItem>}
        >
          <div data-testid="project-section">
            <span>Project</span>
            <CompactLongPressMenu
              label="Thread actions"
              onOpenChange={onThreadOpenChange}
              items={<DropdownMenuItem>Rename thread</DropdownMenuItem>}
            >
              <a href="#thread" data-testid="row">
                Thread row
              </a>
            </CompactLongPressMenu>
          </div>
        </CompactLongPressMenu>
      </CompactViewportOverrideProvider>,
    );
    const row = screen.getByTestId("row");

    touchPointerDown(row);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onThreadOpenChange).toHaveBeenCalledWith(true);
    expect(onProjectOpenChange).not.toHaveBeenCalled();

    onThreadOpenChange.mockClear();
    fireEvent.contextMenu(row);
    expect(onThreadOpenChange).toHaveBeenCalledWith(true);
    expect(onProjectOpenChange).not.toHaveBeenCalled();

    touchPointerDown(screen.getByText("Project"));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onProjectOpenChange).toHaveBeenCalledWith(true);
  });

  it("opens from a right-click on a narrow window without the native menu", () => {
    const { row, onOpenChange } = renderRow();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(row, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
