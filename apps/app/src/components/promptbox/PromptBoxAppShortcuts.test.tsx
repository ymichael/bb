// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppShortcut } from "@bb/domain";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@bb/client-core";
import {
  AppCommandProvider,
  useAppCommandHandler,
  useIsAppCommandModifierHeld,
} from "@/components/commands/AppCommandProvider";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
} from "./PromptBoxInternal";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  composerInputLocked: false,
  sidebarHandlerResult: true,
  sidebarShortcut: {
    key: "\\",
    mod: true,
    meta: false,
    control: false,
    alt: false,
    shift: false,
  } as AppShortcut,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { ...defaultAppSettings },
      keybindings: [
        {
          command: "thread.previous" as const,
          desktopOnly: false,
          shortcut: {
            key: "ArrowUp",
            mod: true,
            meta: false,
            control: false,
            alt: false,
            shift: true,
          },
          when: { all: ["mainSurface" as const], none: [] },
        },
        {
          command: "thread.next" as const,
          desktopOnly: false,
          shortcut: {
            key: "ArrowDown",
            mod: true,
            meta: false,
            control: false,
            alt: false,
            shift: true,
          },
          when: { all: ["mainSurface" as const], none: [] },
        },
        {
          command: "sidebar.toggle" as const,
          desktopOnly: false,
          shortcut: testState.sidebarShortcut,
          when: { all: ["mainSurface" as const], none: ["modalOpen" as const] },
        },
      ],
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

vi.mock("@/lib/plugin-sdk-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugin-sdk-hooks")>()),
  useComposerInputLock: () => testState.composerInputLocked,
}));

function SidebarToggleHandler() {
  useAppCommandHandler("sidebar.toggle", () => {
    testState.calls.push("sidebar.toggle");
    return testState.sidebarHandlerResult;
  });
  return null;
}

function ThreadNavigationHandlers() {
  useAppCommandHandler("thread.previous", () => {
    testState.calls.push("thread.previous");
    return true;
  });
  useAppCommandHandler("thread.next", () => {
    testState.calls.push("thread.next");
    return true;
  });
  return null;
}

function ShortcutHintState() {
  return (
    <span>{useIsAppCommandModifierHeld() ? "hint-held" : "hint-released"}</span>
  );
}

function renderComposer(extra: React.ReactNode = null) {
  render(
    <MemoryRouter>
      <AppCommandProvider>
        <SidebarToggleHandler />
        {extra}
        <PromptBoxInternal
          value=""
          mentionRanges={[]}
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          mentionMenuPlacement="bottom"
          typeahead={{
            mention: {
              results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
              isLoading: false,
              isError: false,
              onQueryChange: vi.fn(),
            },
            command: INERT_TYPEAHEAD_COMMAND_CONFIG,
          }}
        />
      </AppCommandProvider>
    </MemoryRouter>,
  );
  const editor = document.querySelector<HTMLElement>(
    "[data-promptbox-editor-content] [contenteditable]",
  );
  if (editor === null) throw new Error("prompt editor did not render");
  editor.focus();
  return editor;
}

function pressInEditor(
  editor: HTMLElement,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  editor.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  testState.calls.length = 0;
  testState.composerInputLocked = false;
  testState.sidebarHandlerResult = true;
  testState.sidebarShortcut = {
    key: "\\",
    mod: true,
    meta: false,
    control: false,
    alt: false,
    shift: false,
  };
});

describe("prompt editor app shortcuts", () => {
  it.each([
    ["ArrowUp", "thread.previous"],
    ["ArrowDown", "thread.next"],
  ])("runs the configured Meta+Shift+%s app shortcut", (key, command) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const editor = renderComposer(<ThreadNavigationHandlers />);

    const event = pressInEditor(editor, {
      key,
      metaKey: true,
      shiftKey: true,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(testState.calls).toEqual([command]);
    expect(document.activeElement).toBe(editor);
  });

  it("runs the sidebar shortcut while the composer has focus", () => {
    const editor = renderComposer();

    const event = pressInEditor(editor, { ctrlKey: true, key: "\\" });

    expect(testState.calls).toEqual(["sidebar.toggle"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("runs a sidebar shortcut whose chord the editor keymap also claims", () => {
    testState.sidebarShortcut = {
      key: "b",
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: true,
    };
    const editor = renderComposer();

    pressInEditor(editor, {
      code: "KeyB",
      ctrlKey: true,
      key: "B",
      shiftKey: true,
    });

    expect(testState.calls).toEqual(["sidebar.toggle"]);
  });

  it("releases composer focus on Escape", () => {
    const editor = renderComposer();
    expect(document.activeElement).toBe(editor);

    pressInEditor(editor, { key: "Escape" });

    expect(document.activeElement).not.toBe(editor);
  });

  it("offers a declined chord to the handlers only once", () => {
    testState.sidebarHandlerResult = false;
    const editor = renderComposer();

    const event = pressInEditor(editor, { ctrlKey: true, key: "\\" });

    expect(testState.calls).toEqual(["sidebar.toggle"]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("clears the keyboard hint when the composer runs a shortcut", () => {
    vi.useFakeTimers();
    try {
      const editor = renderComposer(<ShortcutHintState />);
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }),
      );
      act(() => vi.advanceTimersByTime(700));
      expect(screen.getByText("hint-held")).toBeDefined();

      act(() => {
        pressInEditor(editor, { ctrlKey: true, key: "\\" });
      });

      expect(testState.calls).toEqual(["sidebar.toggle"]);
      expect(screen.getByText("hint-released")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases focus on Escape while a plugin locks the composer", () => {
    testState.composerInputLocked = true;
    const editor = renderComposer();
    expect(editor.getAttribute("contenteditable")).toBe("false");
    editor.focus();
    expect(document.activeElement).toBe(editor);

    pressInEditor(editor, { key: "Escape" });

    expect(document.activeElement).not.toBe(editor);
  });

  it("keeps typed text in the composer", () => {
    const editor = renderComposer();

    const event = pressInEditor(editor, { code: "KeyB", key: "b" });

    expect(testState.calls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
