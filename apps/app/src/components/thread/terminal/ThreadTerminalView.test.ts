import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  buildTerminalThemeFromCssColors,
  captureTerminalContextMenuState,
  decodeTerminalOutputBytes,
  encodeTerminalInputChunks,
  focusTerminalFromTouchRelease,
  forwardTerminalData,
  loadOptionalTerminalWebglAddon,
  loadTerminalWebglRenderer,
  shouldFocusTerminalAfterAsyncMount,
  startTerminalTouchFocusGesture,
  TERMINAL_ALLOW_PROPOSED_API,
  TERMINAL_FONT_FAMILY,
  TERMINAL_UNICODE_VERSION,
  writeTerminalOutput,
  updateTerminalTouchFocusGesture,
} from "./ThreadTerminalView";
import {
  createTerminalOsc8LinkHandler,
  requestTerminalLinkOpen,
} from "./terminal-links";

describe("terminal hyperlinks", () => {
  it("preserves OSC-8 provenance through hover and primary activation", () => {
    const onActivate = vi.fn();
    const onHover = vi.fn();
    const handler = createTerminalOsc8LinkHandler({
      onActivate,
      onHover,
    });
    const event = { button: 0 } as MouseEvent;
    const range = {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    };

    handler.hover?.(event, "https://example.com/authorize", range);
    handler.activate(event, "https://example.com/authorize", range);
    handler.leave?.(event, "https://example.com/authorize", range);

    expect(onActivate).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(1, {
      source: "osc8",
      uri: "https://example.com/authorize",
    });
    expect(onHover).toHaveBeenNthCalledWith(2, null);
  });

  it("does not activate OSC-8 links from a secondary click", () => {
    const onActivate = vi.fn();
    const handler = createTerminalOsc8LinkHandler({
      onActivate,
      onHover: vi.fn(),
    });
    const range = {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    };

    handler.activate(
      { button: 2 } as MouseEvent,
      "https://example.com/right-click",
      range,
    );

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("confirms concealed targets and directly opens detected URLs", () => {
    const openLink = vi.fn();
    const requestConfirmation = vi.fn();

    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: { source: "osc8", uri: "https://example.com/concealed" },
    });
    requestTerminalLinkOpen({
      openLink,
      requestConfirmation,
      target: {
        source: "detected-url",
        uri: "https://example.com/visible",
      },
    });

    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(requestConfirmation).toHaveBeenCalledWith({
      source: "osc8",
      uri: "https://example.com/concealed",
    });
    expect(openLink).toHaveBeenCalledOnce();
    expect(openLink).toHaveBeenCalledWith("https://example.com/visible");
  });

  it("preserves link actions while copying the exact xterm selection", () => {
    const getSelection = vi.fn(() => "  wrapped terminal selection\n");
    const link = {
      source: "detected-url" as const,
      uri: "https://example.com/visible",
    };

    expect(
      captureTerminalContextMenuState({
        link,
        terminal: { getSelection },
      }),
    ).toEqual({
      link,
      selectionText: "  wrapped terminal selection\n",
    });
    expect(getSelection).toHaveBeenCalledOnce();
  });
});

function startTouchFocusGesture() {
  const gesture = startTerminalTouchFocusGesture(
    [{ identifier: 1, x: 40, y: 80 }],
    100,
  );
  if (gesture === null) {
    throw new Error("Expected one touch to start a focus gesture");
  }
  return gesture;
}

describe("terminal async mount focus", () => {
  it("preserves focus that moved to the composer while xterm loaded", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("does not let an explicit request override a newer focus target", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses an opened terminal when focus stayed on its trigger", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("preserves a composer that was focused before xterm started mounting", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: true,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: false,
        isPanelOpen: true,
      }),
    ).toBe(false);
  });

  it("focuses the terminal when its initiating trigger unmounted", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: false,
        focusMovedDuringMount: true,
        isPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("does not focus a terminal after its panel closes", () => {
    expect(
      shouldFocusTerminalAfterAsyncMount({
        currentFocusIsAvailable: false,
        hasExplicitFocusRequest: true,
        focusMovedDuringMount: false,
        isPanelOpen: false,
      }),
    ).toBe(false);
  });
});

describe("terminal touch focus", () => {
  it("focuses the terminal after a tap", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 43, y: 84 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not focus after a drag returns near its start", () => {
    const focus = vi.fn();
    const gesture = updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
      { identifier: 1, x: 40, y: 120 },
    ]);

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 81 }],
        focus,
        gesture,
        releasedAt: 200,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not focus after a long press", () => {
    const focus = vi.fn();

    expect(
      focusTerminalFromTouchRelease({
        changedTouches: [{ identifier: 1, x: 40, y: 80 }],
        focus,
        gesture: startTouchFocusGesture(),
        releasedAt: 800,
        remainingTouchCount: 0,
      }),
    ).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("invalidates the gesture when another touch starts", () => {
    expect(
      updateTerminalTouchFocusGesture(startTouchFocusGesture(), [
        { identifier: 1, x: 40, y: 80 },
        { identifier: 2, x: 80, y: 80 },
      ]),
    ).toBeNull();
  });
});

describe("terminal output encoding", () => {
  it("splits large paste input at the wire limit without losing UTF-8 bytes", () => {
    const input = `${"a".repeat(TERMINAL_DATA_MAX_BYTES - 1)}🙂tail`;
    const chunks = encodeTerminalInputChunks(input);
    const decoded = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk, "base64")),
    );

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) =>
          Buffer.from(chunk, "base64").byteLength <= TERMINAL_DATA_MAX_BYTES,
      ),
    ).toBe(true);
    expect(decoded.toString("utf8")).toBe(input);
  });

  it("keeps UTF-8 bytes intact when a glyph spans output chunks", () => {
    const encoded = new TextEncoder().encode("🙂");
    const first = decodeTerminalOutputBytes(
      Buffer.from(encoded.subarray(0, 2)).toString("base64"),
    );
    const second = decodeTerminalOutputBytes(
      Buffer.from(encoded.subarray(2)).toString("base64"),
    );
    const decoder = new TextDecoder();

    expect(
      decoder.decode(first, { stream: true }) + decoder.decode(second),
    ).toBe("🙂");
  });

  it("does not send terminal protocol replies generated by replayed output", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const onInput = vi.fn<(dataBase64: string) => void>();
    const onUserInput = vi.fn();
    const replayWriteState = { suppressedWriteCount: 0 };
    terminal.onData((data) => {
      forwardTerminalData({
        data,
        onInput,
        onUserInput,
        replayWriteState,
        sessionStatus: "running",
      });
    });

    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: true,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onInput).not.toHaveBeenCalled();
    expect(onUserInput).not.toHaveBeenCalled();

    writeTerminalOutput({
      data: "\u001b[6n",
      isReplay: false,
      replayWriteState,
      terminal,
    });
    await new Promise<void>((resolve) => terminal.write("", resolve));

    expect(onInput).toHaveBeenCalledOnce();
    const encodedReply = onInput.mock.calls[0]?.[0];
    if (encodedReply === undefined) {
      throw new Error("Expected xterm to emit a cursor-position reply");
    }
    expect(Buffer.from(encodedReply, "base64").toString("utf8")).toBe(
      "\u001b[1;1R",
    );
    expect(onUserInput).toHaveBeenCalledOnce();
    expect(replayWriteState.suppressedWriteCount).toBe(0);
    terminal.dispose();
  });

  it("enables the proposed xterm API required by the Unicode addon", () => {
    expect(TERMINAL_ALLOW_PROPOSED_API).toBe(true);
    expect(TERMINAL_UNICODE_VERSION).toBe("11");
  });

  it("prefers installed Nerd Font families before system monospace fallbacks", () => {
    expect(TERMINAL_FONT_FAMILY).toContain("Nerd Font");
    expect(TERMINAL_FONT_FAMILY).toContain("ui-monospace");
  });
});

describe("buildTerminalThemeFromCssColors", () => {
  it("paints the terminal canvas and cursor cutout with the sidebar surface", () => {
    const get = vi.fn((name: string) => name);

    const theme = buildTerminalThemeFromCssColors(get);

    expect(theme.background).toBe("--sidebar");
    expect(theme.cursorAccent).toBe("--sidebar");
  });
});

describe("loadTerminalWebglRenderer", () => {
  it("continues without WebGL when the optional module fails to load", async () => {
    const importAddon = vi.fn().mockRejectedValue(new Error("chunk failed"));

    await expect(
      loadOptionalTerminalWebglAddon(importAddon),
    ).resolves.toBeNull();
  });

  it("loads the accelerated renderer and falls back when its context is lost", () => {
    let onContextLoss = () => {};
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn((listener: () => void) => {
        onContextLoss = listener;
        return { dispose: vi.fn() };
      }),
    };
    const terminal = { loadAddon: vi.fn() };

    expect(loadTerminalWebglRenderer(terminal, () => addon)).toBe(true);
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);

    onContextLoss();

    expect(addon.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the DOM renderer when WebGL addon registration fails", () => {
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const terminal = {
      loadAddon: vi.fn(() => {
        throw new Error("WebGL unavailable");
      }),
    };

    expect(loadTerminalWebglRenderer(terminal, () => addon)).toBe(false);
    expect(addon.dispose).toHaveBeenCalledOnce();
  });
});
