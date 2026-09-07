// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTerminalContextMenuState } from "./ThreadTerminalView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("terminal context menu", () => {
  it("captures the logical selection before xterm replaces it on macOS", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? 288
          : 108;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 90;
      },
    );
    const { Terminal } = await import("@xterm/xterm");
    const terminal = new Terminal({
      cols: 12,
      rightClickSelectsWord: true,
      rows: 5,
    });
    let capturedSelection = "";

    render(
      <div
        onContextMenuCapture={() => {
          capturedSelection = captureTerminalContextMenuState({
            link: null,
            terminal,
          }).selectionText;
        }}
      >
        <div data-testid="terminal-host" />
      </div>,
    );
    terminal.open(screen.getByTestId("terminal-host"));
    await new Promise<void>((resolve) => {
      terminal.write("alpha bravo charlie", resolve);
    });
    terminal.select(0, 0, 5);

    const terminalScreen = screen
      .getByTestId("terminal-host")
      .querySelector<HTMLElement>(".xterm-screen");
    if (terminalScreen === null) {
      throw new Error("Expected xterm screen");
    }
    terminalScreen.style.padding = "0";
    vi.spyOn(terminalScreen, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 108, 90),
    );
    fireEvent.contextMenu(terminalScreen, {
      button: 2,
      clientX: 18,
      clientY: 27,
    });

    expect(capturedSelection).toBe("alpha");
    expect(terminal.getSelection()).toBe("charlie");
    terminal.dispose();
  });
});
