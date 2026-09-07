// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultAppSettings,
  type AppCommandId,
  type AppDefaultKeybindings,
  type AppKeybindingOverrides,
} from "@bb/domain";
import { KeyboardSettingsSection } from "./KeyboardSettingsSection";

const testState = vi.hoisted(() => {
  const defaultKeybindings = [
    {
      command: "thread.new",
      desktopOnly: false,
      shortcut: {
        key: "o",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      },
      when: { all: ["mainSurface"], none: ["modalOpen"] },
    },
    {
      command: "thread.new",
      desktopOnly: true,
      shortcut: {
        key: "n",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: { all: ["mainSurface"], none: ["modalOpen"] },
    },
    {
      command: "thread.rename",
      desktopOnly: false,
      shortcut: null,
      when: { all: ["mainSurface"], none: ["modalOpen"] },
    },
    {
      command: "thread.archive",
      desktopOnly: false,
      shortcut: null,
      when: { all: ["mainSurface"], none: ["modalOpen"] },
    },
    {
      command: "thread.jump.1",
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
        all: ["mainSurface", "webSurface", "macPlatform"],
        none: ["modalOpen"],
      },
    },
    {
      command: "thread.jump.1",
      desktopOnly: false,
      shortcut: {
        key: "1",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      },
      when: {
        all: ["mainSurface", "webSurface"],
        none: ["modalOpen", "macPlatform"],
      },
    },
    {
      command: "thread.jump.1",
      desktopOnly: true,
      shortcut: {
        key: "1",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: { all: ["mainSurface"], none: ["modalOpen"] },
    },
    {
      command: "question.select.1",
      desktopOnly: false,
      shortcut: {
        key: "1",
        mod: false,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      },
      when: {
        all: ["mainSurface", "questionOpen"],
        none: ["modalOpen", "editableFocus"],
      },
    },
  ] as AppDefaultKeybindings;
  return {
    defaultKeybindings,
    generalMutate: vi.fn(),
    initialDefaultKeybindings: defaultKeybindings,
    isDesktop: false,
    keybindingOverrides: [] as AppKeybindingOverrides,
    keyboardPending: false,
    metadataCalls: new Map<AppCommandId, number>(),
    recorderButtonCalls: new Map<string, number>(),
    mutate:
      vi.fn<
        (
          overrides: AppKeybindingOverrides,
          options: { onError(): void },
        ) => void
      >(),
  };
});

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      defaultKeybindings: testState.defaultKeybindings,
      generalSettings: defaultAppSettings,
      keybindingOverrides: testState.keybindingOverrides,
    },
  }),
}));

vi.mock("@/hooks/mutations/settings-mutations", () => ({
  useUpdateGeneralSettings: () => ({
    isPending: false,
    mutate: testState.generalMutate,
  }),
  useUpdateKeyboardSettings: () => ({
    isPending: testState.keyboardPending,
    mutate: testState.mutate,
  }),
}));

vi.mock("@bb/shared-ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/shared-ui/button")>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      const label = props["aria-label"];
      if (
        typeof label === "string" &&
        label.startsWith("Record shortcut for ")
      ) {
        testState.recorderButtonCalls.set(
          label,
          (testState.recorderButtonCalls.get(label) ?? 0) + 1,
        );
      }
      return createElement(actual.Button, props);
    },
  };
});

vi.mock("@/lib/app-command-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/app-command-metadata")>();
  return {
    ...actual,
    getAppCommandMetadata: (command: AppCommandId) => {
      testState.metadataCalls.set(
        command,
        (testState.metadataCalls.get(command) ?? 0) + 1,
      );
      return actual.getAppCommandMetadata(command);
    },
  };
});

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => (testState.isDesktop ? {} : null),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  testState.defaultKeybindings = testState.initialDefaultKeybindings;
  testState.isDesktop = false;
  testState.keybindingOverrides = [];
  testState.keyboardPending = false;
  testState.metadataCalls.clear();
  testState.recorderButtonCalls.clear();
});

describe("KeyboardSettingsSection", () => {
  it("turns keyboard hints off while preserving the full settings contract", () => {
    render(<KeyboardSettingsSection />);

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Show keyboard hints when holding CMD / Control",
      }),
    );

    expect(testState.generalMutate).toHaveBeenCalledWith({
      ...defaultAppSettings,
      showKeyboardHints: false,
    });
  });

  it("records, clears, and resets a command shortcut", () => {
    render(<KeyboardSettingsSection />);
    const defaults = screen.getByLabelText("Default shortcuts for New thread");
    const webLabel = within(defaults).getByText("Web");
    const webGroup = webLabel.parentElement;
    const webDefault = within(webGroup!).getByText("Ctrl + Shift + O");
    expect(webDefault.tagName).toBe("KBD");
    expect(webDefault.getAttribute("aria-hidden")).toBe("false");
    const desktopLabel = within(defaults).getByText("Desktop");
    const desktopGroup = desktopLabel.parentElement;
    expect(within(desktopGroup!).getByText("Ctrl + N")).toBeDefined();
    expect(within(defaults).queryByText("macOS web")).toBeNull();
    expect(within(defaults).queryByText("Windows/Linux web")).toBeNull();
    const recorder = screen.getByRole("button", {
      name: "Record shortcut for New thread, current shortcut Ctrl + Shift + O",
    });
    const recorderShortcut = within(recorder).getByText("Ctrl + Shift + O");
    expect(recorderShortcut.tagName).toBe("KBD");
    expect(recorderShortcut.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(recorder);
    expect(screen.getByText("Press keys")).toBeDefined();
    fireEvent.keyDown(recorder, {
      key: "U",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(testState.mutate).toHaveBeenLastCalledWith(
      [
        {
          command: "thread.new",
          shortcut: {
            key: "u",
            mod: true,
            meta: false,
            control: false,
            alt: false,
            shift: true,
          },
        },
      ],
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear shortcut for New thread",
      }),
    );
    expect(testState.mutate).toHaveBeenLastCalledWith(
      [{ command: "thread.new", shortcut: null }],
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset shortcut for New thread",
      }),
    );
    expect(testState.mutate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("lets users assign a command that has no default shortcut", () => {
    render(<KeyboardSettingsSection />);
    const recorder = screen.getByRole("button", {
      name: "Record shortcut for Rename thread, current shortcut unassigned",
    });
    expect(recorder.hasAttribute("disabled")).toBe(false);
    expect(within(recorder).getByText("Unassigned")).toBeDefined();

    fireEvent.click(recorder);
    fireEvent.keyDown(recorder, {
      key: "R",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(testState.mutate).toHaveBeenLastCalledWith(
      [
        {
          command: "thread.rename",
          shortcut: {
            key: "r",
            mod: true,
            meta: false,
            control: false,
            alt: false,
            shift: true,
          },
        },
      ],
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("renders only rows whose presentation changes during a settings transaction", () => {
    const { rerender } = render(<KeyboardSettingsSection />);
    const recorder = screen.getByRole("button", {
      name: "Record shortcut for New thread, current shortcut Ctrl + Shift + O",
    });

    testState.metadataCalls.clear();
    fireEvent.click(recorder);
    expect(testState.metadataCalls.get("thread.new")).toBeGreaterThan(0);
    expect(testState.metadataCalls.has("thread.jump.1")).toBe(false);

    testState.metadataCalls.clear();
    fireEvent.keyDown(recorder, {
      key: "U",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(testState.metadataCalls.get("thread.new")).toBeGreaterThan(0);
    expect(testState.metadataCalls.has("thread.jump.1")).toBe(false);

    const assignedOverrides = testState.mutate.mock.lastCall?.[0];
    if (assignedOverrides === undefined) {
      throw new Error("Expected shortcut assignment mutation");
    }

    testState.metadataCalls.clear();
    testState.keybindingOverrides = structuredClone(assignedOverrides);
    testState.defaultKeybindings = structuredClone(
      testState.defaultKeybindings,
    );
    rerender(<KeyboardSettingsSection />);
    expect(testState.metadataCalls.size).toBe(0);

    testState.metadataCalls.clear();
    testState.recorderButtonCalls.clear();
    testState.keyboardPending = true;
    rerender(<KeyboardSettingsSection />);
    expect([...testState.metadataCalls.keys()]).toEqual(["thread.new"]);
    expect(testState.recorderButtonCalls.size).toBe(0);
    expect(recorder.matches(":disabled")).toBe(true);
    expect(recorder.hasAttribute("disabled")).toBe(false);
    expect(
      screen
        .getByRole("button", { name: /^Record shortcut for Search threads/u })
        .closest('[aria-busy="true"]'),
    ).toBeNull();

    testState.metadataCalls.clear();
    testState.keyboardPending = false;
    testState.keybindingOverrides = structuredClone(assignedOverrides);
    testState.defaultKeybindings = structuredClone(
      testState.defaultKeybindings,
    );
    rerender(<KeyboardSettingsSection />);
    expect([...testState.metadataCalls.keys()]).toEqual(["thread.new"]);
    expect(recorder.matches(":disabled")).toBe(false);
    expect(recorder.closest('[aria-busy="true"]')).toBeNull();

    testState.metadataCalls.clear();
    testState.keybindingOverrides = [
      ...assignedOverrides,
      {
        command: "thread.jump.1",
        shortcut: {
          key: "2",
          mod: true,
          meta: false,
          control: false,
          alt: false,
          shift: true,
        },
      },
    ];
    rerender(<KeyboardSettingsSection />);
    expect([...testState.metadataCalls.keys()]).toEqual(["thread.jump.1"]);
    expect(
      screen.getByRole("button", {
        name: "Record shortcut for Open thread 1, current shortcut Ctrl + Shift + 2",
      }),
    ).toBeDefined();
  });

  it("updates conflict warnings on another customized row", () => {
    render(<KeyboardSettingsSection />);
    const newThreadRecorder = screen.getByRole("button", {
      name: "Record shortcut for New thread, current shortcut Ctrl + Shift + O",
    });
    fireEvent.click(newThreadRecorder);
    fireEvent.keyDown(newThreadRecorder, {
      key: "U",
      ctrlKey: true,
      shiftKey: true,
    });

    const jumpRecorder = screen.getByRole("button", {
      name: "Record shortcut for Open thread 1, current shortcut Ctrl + Shift + 1",
    });
    fireEvent.click(jumpRecorder);
    testState.recorderButtonCalls.clear();
    fireEvent.keyDown(jumpRecorder, {
      key: "U",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(screen.getByText(/Also used by Open thread 1\./u)).toBeDefined();
    expect(screen.getByText(/Also used by New thread\./u)).toBeDefined();
    expect(testState.mutate.mock.lastCall?.[0]).toHaveLength(2);
    expect(
      [...testState.recorderButtonCalls.keys()].filter((label) =>
        label.includes("New thread"),
      ),
    ).toEqual([]);
    expect(
      [...testState.recorderButtonCalls.keys()].filter((label) =>
        label.includes("Open thread 1"),
      ),
    ).toHaveLength(1);
  });

  it("rolls reset-all draft state back when the mutation fails", () => {
    render(<KeyboardSettingsSection />);
    const recorder = screen.getByRole("button", {
      name: "Record shortcut for New thread, current shortcut Ctrl + Shift + O",
    });
    fireEvent.click(recorder);
    fireEvent.keyDown(recorder, {
      key: "U",
      ctrlKey: true,
      shiftKey: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(testState.mutate.mock.lastCall?.[0]).toEqual([]);
    expect(
      screen.getByRole("button", {
        name: "Record shortcut for New thread, current shortcut Ctrl + Shift + O",
      }),
    ).toBeDefined();

    const rollback = testState.mutate.mock.lastCall?.[1].onError;
    if (rollback === undefined) throw new Error("Expected rollback handler");
    act(() => rollback());

    expect(
      screen.getByRole("button", {
        name: "Record shortcut for New thread, current shortcut Ctrl + Shift + U",
      }),
    ).toBeDefined();
  });

  it("shows web and desktop defaults without OS-specific groups", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<KeyboardSettingsSection />);

    const defaults = screen.getByLabelText(
      "Default shortcuts for Open thread 1",
    );
    const webGroup = within(defaults).getByText("Web").parentElement;
    expect(within(webGroup!).getByText("⌃ 1")).toBeDefined();
    const desktopGroup = within(defaults).getByText("Desktop").parentElement;
    expect(within(desktopGroup!).getByText("⌘ 1")).toBeDefined();
    expect(within(defaults).queryByText("macOS web")).toBeNull();
    expect(within(defaults).queryByText("Windows/Linux web")).toBeNull();
    expect(within(defaults).queryByText("Ctrl + Shift + 1")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Record shortcut for Open thread 1, current shortcut ⌃ 1",
      }),
    ).toBeDefined();
  });

  it("selects the active desktop shortcut from the displayed surface defaults", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    testState.isDesktop = true;
    render(<KeyboardSettingsSection />);

    const defaults = screen.getByLabelText(
      "Default shortcuts for Open thread 1",
    );
    const webGroup = within(defaults).getByText("Web").parentElement;
    expect(within(webGroup!).getByText("⌃ 1")).toBeDefined();
    const desktopGroup = within(defaults).getByText("Desktop").parentElement;
    expect(within(desktopGroup!).getByText("⌘ 1")).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: "Record shortcut for Open thread 1, current shortcut ⌘ 1",
      }),
    ).toBeDefined();
  });

  it("shows one unlabeled default when web and desktop match", () => {
    render(<KeyboardSettingsSection />);

    const defaults = screen.getByLabelText(
      "Default shortcut for Choose answer 1",
    );
    expect(within(defaults).getByText("1")).toBeDefined();
    expect(within(defaults).queryByText("Web")).toBeNull();
    expect(within(defaults).queryByText("Desktop")).toBeNull();
  });
});
