// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultAppSettings,
  type AppCommandContextKey,
  type AppCommandId,
  type AppDefaultKeybinding,
} from "@bb/domain";
import {
  AppCommandProvider,
  useAppCommandContext,
  useAppCommandHandler,
  useAppCommandRunner,
} from "./AppCommandProvider";

const MOD_P = {
  key: "p",
  mod: true,
  meta: false,
  control: false,
  alt: false,
  shift: false,
};

function defaultBinding(
  command: AppCommandId,
  options: {
    all?: readonly AppCommandContextKey[];
    desktopOnly?: boolean;
    none?: readonly AppCommandContextKey[];
    unassigned?: boolean;
  } = {},
): AppDefaultKeybinding {
  return {
    command,
    desktopOnly: options.desktopOnly ?? false,
    shortcut: options.unassigned === true ? null : MOD_P,
    when: {
      all: [...(options.all ?? ["mainSurface"])],
      none: [...(options.none ?? [])],
    },
  };
}

const testState = vi.hoisted(() => ({
  isDesktop: false,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: {
        ...defaultAppSettings,
        showKeyboardHints: false,
      },
      keybindings: [],
      defaultKeybindings: [
        defaultBinding("thread.new", { none: ["modalOpen"] }),
        defaultBinding("thread.rename", { unassigned: true }),
        defaultBinding("pane.close", { all: ["mainSurface", "splitActive"] }),
        defaultBinding("window.new", { desktopOnly: true }),
        defaultBinding("diff.toggle", {
          none: ["modalOpen", "editableFocus", "terminalFocus"],
        }),
      ],
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => (testState.isDesktop ? {} : null),
}));

function Handler({ command }: { command: AppCommandId }) {
  useAppCommandHandler(command, () => true);
  return null;
}

function SplitContext() {
  useAppCommandContext("splitActive", true);
  return null;
}

function Availability({
  command,
  target = null,
}: {
  command: AppCommandId;
  target?: EventTarget | null;
}) {
  const runner = useAppCommandRunner();
  const [answer, setAnswer] = useState("unasked");
  return (
    <button
      type="button"
      data-testid={`available-${command}`}
      onClick={() =>
        setAnswer(runner.isCommandAvailable(command, target) ? "yes" : "no")
      }
    >
      {answer}
    </button>
  );
}

function renderProvider(children: ReactNode) {
  return render(
    <MemoryRouter>
      <AppCommandProvider>{children}</AppCommandProvider>
    </MemoryRouter>,
  );
}

function availabilityOf(command: AppCommandId): string | null {
  const probe = screen.getByTestId(`available-${command}`);
  fireEvent.click(probe);
  return probe.textContent;
}

afterEach(() => {
  cleanup();
  testState.isDesktop = false;
});

describe("isCommandAvailable", () => {
  it("is false while no component handles the command", () => {
    renderProvider(<Availability command="thread.new" />);
    expect(availabilityOf("thread.new")).toBe("no");
  });

  it("is true once a handler is mounted and the preconditions hold", () => {
    renderProvider(
      <>
        <Handler command="thread.new" />
        <Availability command="thread.new" />
      </>,
    );
    expect(availabilityOf("thread.new")).toBe("yes");
  });

  it("is false while an `all` precondition is unmet", () => {
    renderProvider(
      <>
        <Handler command="pane.close" />
        <Availability command="pane.close" />
      </>,
    );
    expect(availabilityOf("pane.close")).toBe("no");
  });

  it("is true once the `all` precondition's context registers", () => {
    renderProvider(
      <>
        <SplitContext />
        <Handler command="pane.close" />
        <Availability command="pane.close" />
      </>,
    );
    expect(availabilityOf("pane.close")).toBe("yes");
  });

  it("ignores `none` guards, which exist to stop chords stealing keystrokes", () => {
    renderProvider(
      <>
        <div aria-modal="true" />
        <input aria-label="query" />
        <Handler command="diff.toggle" />
        <Availability
          command="diff.toggle"
          target={document.createElement("input")}
        />
      </>,
    );
    expect(availabilityOf("diff.toggle")).toBe("yes");
  });

  it("is true for a command the user left unbound", () => {
    renderProvider(
      <>
        <Handler command="thread.rename" />
        <Availability command="thread.rename" />
      </>,
    );
    expect(availabilityOf("thread.rename")).toBe("yes");
  });

  it("is false on the web for a desktop-only command", () => {
    renderProvider(
      <>
        <Handler command="window.new" />
        <Availability command="window.new" />
      </>,
    );
    expect(availabilityOf("window.new")).toBe("no");
  });

  it("is true on the desktop for that same command", () => {
    testState.isDesktop = true;
    renderProvider(
      <>
        <Handler command="window.new" />
        <Availability command="window.new" />
      </>,
    );
    expect(availabilityOf("window.new")).toBe("yes");
  });
});
