// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppCommandId } from "@bb/domain";
import {
  AppCommandProvider,
  useAppCommandContext,
  useAppCommandHandler,
  useAppCommandShortcut,
  useIsAppCommandModifierHeld,
} from "./AppCommandProvider";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  showKeyboardHints: true,
  keybindings: [
    {
      command: "thread.new" as const,
      desktopOnly: false,
      shortcut: {
        key: "o",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      },
      when: { all: ["mainSurface" as const], none: ["modalOpen" as const] },
    },
    {
      command: "thread.new" as const,
      desktopOnly: true,
      shortcut: {
        key: "n",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: { all: ["mainSurface" as const], none: ["modalOpen" as const] },
    },
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
      command: "thread.previous" as const,
      desktopOnly: true,
      shortcut: {
        key: "[",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      },
      when: { all: ["mainSurface" as const], none: [] },
    },
    {
      command: "thread.search" as const,
      desktopOnly: false,
      shortcut: {
        key: "k",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: { all: ["mainSurface" as const], none: [] },
    },
    {
      command: "thread.jump.1" as const,
      desktopOnly: false,
      shortcut: {
        key: "1",
        mod: false,
        meta: false,
        control: true,
        alt: false,
        shift: false,
      },
      when: {
        all: [
          "mainSurface" as const,
          "webSurface" as const,
          "macPlatform" as const,
        ],
        none: [],
      },
    },
    {
      command: "thread.jump.1" as const,
      desktopOnly: false,
      shortcut: {
        key: "1",
        mod: false,
        meta: false,
        control: true,
        alt: false,
        shift: true,
      },
      when: {
        all: ["mainSurface" as const, "webSurface" as const],
        none: ["macPlatform" as const],
      },
    },
    {
      command: "thread.jump.1" as const,
      desktopOnly: true,
      shortcut: {
        key: "1",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: { all: ["mainSurface" as const], none: [] },
    },
    {
      command: "question.select.1" as const,
      desktopOnly: false,
      shortcut: {
        key: "k",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: {
        all: ["mainSurface" as const, "questionOpen" as const],
        none: [],
      },
    },
    {
      command: "panel.toggle" as const,
      desktopOnly: false,
      shortcut: {
        key: "j",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: { all: ["mainSurface" as const], none: ["modalOpen" as const] },
    },
    {
      command: "browser.reload" as const,
      desktopOnly: false,
      shortcut: {
        key: "r",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: {
        all: ["mainSurface" as const, "browserFocus" as const],
        none: [],
      },
    },
  ],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: {
        ...defaultAppSettings,
        showKeyboardHints: testState.showKeyboardHints,
      },
      keybindings: testState.keybindings,
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

interface HandlerProps {
  command?: AppCommandId;
  enabled?: boolean;
  name: string;
  priority?: number;
  result: boolean;
}

function Handler({
  command = "thread.search",
  enabled,
  name,
  priority,
  result,
}: HandlerProps) {
  useAppCommandHandler(
    command,
    () => {
      testState.calls.push(name);
      return result;
    },
    priority,
    enabled,
  );
  return null;
}

function QuestionContext() {
  useAppCommandContext("questionOpen", true);
  return <Handler command="question.select.1" name="question" result={true} />;
}

function FocusScopedHandler({ name }: { name: string }) {
  useAppCommandHandler("thread.search", ({ target }) => {
    if (
      !(target instanceof HTMLElement) ||
      target.closest(`[data-command-scope="${name}"]`) === null
    ) {
      return false;
    }
    testState.calls.push(name);
    return true;
  });
  return (
    <div data-command-scope={name}>
      <button type="button">{name}</button>
    </div>
  );
}

function ShortcutLabel({ command }: { command: AppCommandId }) {
  const shortcut = useAppCommandShortcut(command);
  return <span>{shortcut?.label}</span>;
}

function ModifierState() {
  const held = useIsAppCommandModifierHeld();
  return <span>{held ? "held" : "released"}</span>;
}

function renderProvider(children: ReactNode) {
  return render(
    <MemoryRouter>
      <AppCommandProvider>{children}</AppCommandProvider>
    </MemoryRouter>,
  );
}

function dispatchShortcut(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: "k",
  });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  testState.calls.length = 0;
  testState.showKeyboardHints = true;
});

describe("AppCommandProvider", () => {
  it("shares shortcut-hint modifier state after 700ms and clears it on release or blur", () => {
    vi.useFakeTimers();
    renderProvider(<ModifierState />);

    expect(screen.getByText("released")).toBeDefined();
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    act(() => vi.advanceTimersByTime(699));
    expect(screen.getByText("released")).toBeDefined();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("held")).toBeDefined();
    fireEvent.keyUp(window, { key: "Control" });
    expect(screen.getByText("released")).toBeDefined();
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByText("held")).toBeDefined();
    fireEvent.blur(window);
    expect(screen.getByText("released")).toBeDefined();
    vi.useRealTimers();
  });

  it("shows keyboard hints for either Command or Control on macOS", () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    renderProvider(<ModifierState />);

    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByText("held")).toBeDefined();
    fireEvent.keyUp(window, { key: "Meta" });
    expect(screen.getByText("released")).toBeDefined();

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByText("held")).toBeDefined();
    fireEvent.keyUp(window, { key: "Control" });
    expect(screen.getByText("released")).toBeDefined();
    vi.useRealTimers();
  });

  it("cancels keyboard hints when the modifier becomes part of a shortcut chord", () => {
    vi.useFakeTimers();
    renderProvider(<ModifierState />);

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    act(() => vi.advanceTimersByTime(699));
    fireEvent.keyDown(window, {
      key: "Shift",
      ctrlKey: true,
      shiftKey: true,
    });
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("released")).toBeDefined();

    fireEvent.keyUp(window, { key: "Control" });
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByText("held")).toBeDefined();
    fireEvent.keyDown(window, { key: "3", ctrlKey: true, shiftKey: true });
    expect(screen.getByText("released")).toBeDefined();
    vi.useRealTimers();
  });

  it("does not show keyboard hints when another modifier was held first", () => {
    vi.useFakeTimers();
    renderProvider(<ModifierState />);

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(window, {
      key: "Control",
      ctrlKey: true,
      shiftKey: true,
    });
    act(() => vi.advanceTimersByTime(700));

    expect(screen.getByText("released")).toBeDefined();
    vi.useRealTimers();
  });

  it("does not share shortcut-hint modifier state when keyboard hints are disabled", () => {
    vi.useFakeTimers();
    testState.showKeyboardHints = false;
    renderProvider(<ModifierState />);

    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByText("released")).toBeDefined();
    vi.useRealTimers();
  });

  it("presents the web-capable alias when the primary binding is desktop-only", () => {
    renderProvider(
      <>
        <ShortcutLabel command="thread.new" />
        <ShortcutLabel command="thread.previous" />
        <ShortcutLabel command="thread.jump.1" />
      </>,
    );

    expect(screen.getByText("Ctrl + Shift + O")).toBeDefined();
    expect(screen.getByText("Ctrl + Shift + ArrowUp")).toBeDefined();
    expect(screen.getByText("Ctrl + Shift + 1")).toBeDefined();
  });

  it("preserves native Mod+number behavior and dispatches the shifted web chat alias", () => {
    renderProvider(
      <Handler command="thread.jump.1" name="thread" result={true} />,
    );

    const nativeTabShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "1",
    });
    window.dispatchEvent(nativeTabShortcut);
    expect(nativeTabShortcut.defaultPrevented).toBe(false);
    expect(testState.calls).toEqual([]);

    const webChatShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "!",
      shiftKey: true,
    });
    window.dispatchEvent(webChatShortcut);
    expect(webChatShortcut.defaultPrevented).toBe(true);
    expect(testState.calls).toEqual(["thread"]);
  });

  it("uses the Slack-style Control+number web alias on macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    renderProvider(
      <>
        <ShortcutLabel command="thread.jump.1" />
        <Handler command="thread.jump.1" name="thread" result={true} />
      </>,
    );

    expect(screen.getByText("⌃ 1")).toBeDefined();
    const webChatShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "1",
    });
    window.dispatchEvent(webChatShortcut);
    expect(webChatShortcut.defaultPrevented).toBe(true);
    expect(testState.calls).toEqual(["thread"]);

    const nativeTabShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "1",
      metaKey: true,
    });
    window.dispatchEvent(nativeTabShortcut);
    expect(nativeTabShortcut.defaultPrevented).toBe(false);
  });

  it.each([
    ["thread.previous" as const, "ArrowUp"],
    ["thread.next" as const, "ArrowDown"],
  ])(
    "dispatches configured %s shortcuts from a focused editable control",
    (command, key) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      renderProvider(
        <>
          <Handler command={command} name={command} result={true} />
          <textarea aria-label="Composer" />
        </>,
      );
      const composer = screen.getByLabelText("Composer");
      composer.focus();
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        metaKey: true,
        shiftKey: true,
      });

      composer.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(testState.calls).toEqual([command]);
      expect(document.activeElement).toBe(composer);
    },
  );

  it("falls through declining handlers in priority order", () => {
    renderProvider(
      <>
        <Handler name="low" result={true} />
        <Handler name="high" priority={10} result={false} />
      </>,
    );

    expect(dispatchShortcut().defaultPrevented).toBe(true);
    expect(testState.calls).toEqual(["high", "low"]);
  });

  it("gives later scoped bindings precedence on the same chord", () => {
    renderProvider(
      <>
        <Handler name="global" result={true} />
        <QuestionContext />
      </>,
    );

    dispatchShortcut();
    expect(testState.calls).toEqual(["question"]);
  });

  it("unregisters handlers on unmount and preserves native behavior when unhandled", () => {
    const rendered = renderProvider(<Handler name="removed" result={true} />);
    rendered.rerender(
      <MemoryRouter>
        <AppCommandProvider>{null}</AppCommandProvider>
      </MemoryRouter>,
    );

    expect(dispatchShortcut().defaultPrevented).toBe(false);
    expect(testState.calls).toEqual([]);
  });

  it("does not register a disabled handler", () => {
    renderProvider(<Handler enabled={false} name="disabled" result={true} />);

    expect(dispatchShortcut().defaultPrevented).toBe(false);
    expect(testState.calls).toEqual([]);
  });

  it("lets equal-priority handlers fall through to the focus-owning instance", () => {
    renderProvider(
      <>
        <FocusScopedHandler name="main" />
        <FocusScopedHandler name="side" />
      </>,
    );
    const mainButton = document.querySelector<HTMLButtonElement>(
      '[data-command-scope="main"] button',
    );
    expect(mainButton).not.toBeNull();
    mainButton?.focus();

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "k",
    });
    mainButton?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(testState.calls).toEqual(["main"]);
  });

  it("derives browser focus only from events inside browser DOM chrome", () => {
    renderProvider(
      <>
        <Handler command="browser.reload" name="browser" result={true} />
        <button type="button">Outside</button>
        <div data-app-browser>
          <button type="button">Inside browser</button>
        </div>
      </>,
    );
    const outside = document.querySelector<HTMLButtonElement>("button");
    const inside = document.querySelector<HTMLButtonElement>(
      "[data-app-browser] button",
    );
    const dispatchReload = (target: HTMLButtonElement | null) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "r",
      });
      target?.dispatchEvent(event);
      return event;
    };

    expect(dispatchReload(outside).defaultPrevented).toBe(false);
    expect(testState.calls).toEqual([]);
    expect(dispatchReload(inside).defaultPrevented).toBe(true);
    expect(testState.calls).toEqual(["browser"]);
  });

  it.each([
    ["thread.new" as const, "o", true],
    ["panel.toggle" as const, "j", false],
  ])(
    "runs %s from any focused surface while a closed drawer stays mounted",
    (command, key, shiftKey) => {
      renderProvider(
        <>
          <Handler command={command} name={command} result={true} />
          <div role="dialog" aria-modal="true" data-state="closed" inert>
            {}
            <div role="dialog" data-state="open">
              <button type="button">Sidebar entry</button>
            </div>
          </div>
          <button type="button">Timeline row</button>
          <div contentEditable data-testid="composer" />
        </>,
      );
      const dispatchChord = (target: Element | null) => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key,
          shiftKey,
        });
        target?.dispatchEvent(event);
        return event;
      };

      for (const target of [
        screen.getByText("Timeline row"),
        screen.getByText("Sidebar entry"),
        screen.getByTestId("composer"),
      ]) {
        testState.calls.length = 0;
        expect(dispatchChord(target).defaultPrevented).toBe(true);
        expect(testState.calls).toEqual([command]);
      }
    },
  );

  it("suppresses main-surface commands while a drawer is actually open", () => {
    renderProvider(
      <>
        <Handler command="thread.new" name="thread.new" result={true} />
        <div role="dialog" aria-modal="true" data-state="open">
          <button type="button">Drawer entry</button>
        </div>
      </>,
    );
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "o",
      shiftKey: true,
    });
    screen.getByText("Drawer entry").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(testState.calls).toEqual([]);
  });
});
