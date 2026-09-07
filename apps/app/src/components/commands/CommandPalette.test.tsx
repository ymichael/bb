// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultAppSettings,
  type AppCommandId,
  type AppDefaultKeybinding,
  type AppKeybinding,
} from "@bb/domain";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { AppCommandProvider, useAppCommandHandler } from "./AppCommandProvider";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { CommandPalette } from "./CommandPalette";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const PALETTE_SHORTCUT = {
  key: "p",
  mod: true,
  meta: false,
  control: false,
  alt: false,
  shift: true,
};

const MAIN_SURFACE = { all: ["mainSurface" as const], none: [] };

const PALETTE_BINDING: AppKeybinding = {
  command: "palette.open",
  desktopOnly: false,
  shortcut: PALETTE_SHORTCUT,
  when: { all: ["mainSurface"], none: ["modalOpen"] },
};

const THREAD_SEARCH_BINDING: AppKeybinding = {
  command: "thread.search",
  desktopOnly: false,
  shortcut: {
    key: "k",
    mod: true,
    meta: false,
    control: false,
    alt: false,
    shift: false,
  },
  when: { all: ["mainSurface"], none: ["modalOpen"] },
};

const THREAD_NEW_BINDING: AppKeybinding = {
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
};

function defaults(...commands: AppCommandId[]): AppDefaultKeybinding[] {
  return commands.map((command) => ({
    command,
    desktopOnly: false,
    shortcut: null,
    when: MAIN_SURFACE,
  }));
}

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  filesAvailable: false,
  plugins: [] as Array<{
    enabled: boolean;
    hasSettings: boolean;
    icon: string | null;
    id: string;
    name: string | null;
  }>,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: {
        ...defaultAppSettings,
        showKeyboardHints: false,
      },
      keybindings: [PALETTE_BINDING, THREAD_SEARCH_BINDING, THREAD_NEW_BINDING],
      defaultKeybindings: [
        PALETTE_BINDING,
        THREAD_SEARCH_BINDING,
        ...defaults(
          "thread.new",
          "thread.next",
          "panel.toggle",
          "terminal.open",
        ),
      ],
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({
    accessState: testState.filesAvailable
      ? "permission-required"
      : "unavailable",
  }),
}));

vi.mock("@/lib/app-query-client", () => ({
  appQueryClient: {
    fetchQuery: () => Promise.resolve(testState.plugins),
  },
}));

vi.mock("./ThreadPaletteResults", () => ({
  ThreadPaletteResults: ({
    onSelect,
    query,
  }: {
    onSelect: (item: {
      id: string;
      optionId: string;
      projectId: string;
      threadId: string;
      messageSeq: number | null;
    }) => void;
    query: string;
  }) => (
    <button
      type="button"
      role="option"
      aria-selected="true"
      onClick={() =>
        onSelect({
          id: "active:thr_message",
          optionId: "thread-option",
          projectId: "proj_search",
          threadId: "thr_message",
          messageSeq: 7,
        })
      }
    >
      Matched thread {query}
    </button>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </output>
  );
}

function Handler({ command }: { command: AppCommandId }) {
  useAppCommandHandler(command, () => {
    testState.calls.push(command);
    return true;
  });
  return null;
}

function renderPalette(isCompactViewport = false) {
  const result = render(
    <MemoryRouter>
      <AppCommandProvider>
        <button type="button" data-testid="origin">
          origin
        </button>
        <Handler command="thread.new" />
        <Handler command="thread.next" />
        <Handler command="panel.toggle" />
        <Handler command="terminal.open" />
        <CommandPalette threadId={null} projectId={null} />
        <LocationProbe />
      </AppCommandProvider>
    </MemoryRouter>,
    {
      wrapper: ({ children }) => (
        <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
          {children}
        </CompactViewportOverrideProvider>
      ),
    },
  );
  screen.getByTestId("origin").focus();
  return result;
}

function openPalette(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "p",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? window).dispatchEvent(event);
  return event;
}

function openThreadSearch(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "k",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? window).dispatchEvent(event);
  return event;
}

const searchField = () => screen.getByRole("combobox");
const optionTitles = () =>
  screen.queryAllByRole("option").map((option) => option.textContent);
const selectedOption = () =>
  screen
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-selected") === "true");

afterEach(() => {
  cleanup();
  removePluginSlotRegistrations("linear");
  removePluginSlotRegistrations("automations");
  testState.calls.length = 0;
  testState.filesAvailable = false;
  testState.plugins.length = 0;
  window.localStorage.clear();
});

describe("CommandPalette", () => {
  it("opens on its chord and lists the commands that apply", async () => {
    renderPalette();
    const event = openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());
    expect(event.defaultPrevented).toBe(true);
    expect((searchField() as HTMLInputElement).value).toBe(">");
    const titles = optionTitles();
    expect(titles?.[0]).toContain("New thread");
    expect(titles).toHaveLength(17);
  });

  it("filters as the user types and keeps the selection on a live row", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.keyDown(searchField(), { key: "ArrowDown" });
    fireEvent.keyDown(searchField(), { key: "ArrowDown" });
    fireEvent.change(searchField(), { target: { value: ">terminal" } });

    await waitFor(() => expect(optionTitles()).toHaveLength(1));
    expect(selectedOption()?.textContent).toContain("Open terminal");
  });

  it("finds commands when the query starts with a space", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), { target: { value: "> new thread" } });

    await waitFor(() => expect(optionTitles()).toHaveLength(1));
    expect(selectedOption()?.textContent).toContain("New thread");
  });

  it("wraps at both ends of the list", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());
    const titles = optionTitles();

    fireEvent.keyDown(searchField(), { key: "ArrowUp" });
    expect(selectedOption()?.textContent).toBe(titles.at(-1));

    fireEvent.keyDown(searchField(), { key: "ArrowDown" });
    expect(selectedOption()?.textContent).toBe(titles[0]);
  });

  it("runs the highlighted command, closes, and restores focus", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), { target: { value: ">toggle panel" } });
    await waitFor(() =>
      expect(selectedOption()?.textContent).toContain("Toggle panel"),
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });

    await waitFor(() => expect(testState.calls).toEqual(["panel.toggle"]));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("origin"));
  });

  it("runs a compact selection once after restoring focus", async () => {
    renderPalette(true);
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), { target: { value: ">toggle panel" } });
    fireEvent.keyDown(searchField(), { key: "Enter" });

    await waitFor(() => expect(testState.calls).toEqual(["panel.toggle"]));
    expect(document.activeElement).toBe(screen.getByTestId("origin"));
  });

  it("offers the last command run first the next time it opens", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());
    fireEvent.change(searchField(), { target: { value: ">toggle panel" } });
    await waitFor(() =>
      expect(selectedOption()?.textContent).toContain("Toggle panel"),
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());

    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());
    expect(optionTitles()?.[0]).toContain("Toggle panel");
  });

  it("closes on Escape without running anything", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.keyDown(searchField(), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    expect(testState.calls).toEqual([]);
  });

  it("suppresses app chords while open and releases them on close", async () => {
    renderPalette();
    const pressThreadNew = () =>
      fireEvent.keyDown(document.activeElement ?? window, {
        key: "o",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      });

    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());
    pressThreadNew();
    expect(testState.calls).toEqual([]);

    fireEvent.keyDown(searchField(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    screen.getByTestId("origin").focus();
    pressThreadNew();
    await waitFor(() => expect(testState.calls).toEqual(["thread.new"]));
  });

  it("scrolls the highlighted row into view when arrowing, but not on hover", async () => {
    const scrollIntoView = vi.spyOn(
      Element.prototype,
      "scrollIntoView",
    ) as unknown as ReturnType<typeof vi.fn>;
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());
    scrollIntoView.mockClear();

    fireEvent.keyDown(searchField(), { key: "ArrowDown" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.instances[0]).toBe(selectedOption());
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });

    fireEvent.keyDown(searchField(), { key: "End" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));

    scrollIntoView.mockClear();
    fireEvent.pointerMove(screen.getAllByRole("option")[0] as HTMLElement);
    expect(scrollIntoView).not.toHaveBeenCalled();

    scrollIntoView.mockRestore();
  });

  it("lists a plugin's commandPaletteAction and runs it", async () => {
    setPluginSlotRegistrations(
      "linear",
      makePluginRegistrationSet({
        commandPaletteActions: [
          {
            id: "open-issue",
            title: "Linear: open issue",
            run: () => {
              testState.calls.push("plugin-ran");
            },
          },
        ],
      }),
    );
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), { target: { value: ">linear" } });
    await waitFor(() => expect(optionTitles()).toHaveLength(1));
    expect(optionTitles()?.[0]).toContain("Linear: open issue");
    fireEvent.keyDown(searchField(), { key: "Enter" });

    await waitFor(() => expect(testState.calls).toEqual(["plugin-ran"]));
  });

  it("says so when nothing matches", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), { target: { value: ">zzzzz" } });

    await waitFor(() =>
      expect(screen.getByText("No matching commands")).toBeTruthy(),
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });
    expect(testState.calls).toEqual([]);
  });

  it("opens thread search without a prefix", async () => {
    renderPalette();
    const event = openThreadSearch();

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Search threads" }),
      ).toBeTruthy(),
    );
    expect(event.defaultPrevented).toBe(true);
    expect((searchField() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe(
      "Thread search results",
    );
  });

  it("switches the open command palette to thread search", async () => {
    renderPalette();
    openPalette();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), { target: { value: ">search threads" } });
    await waitFor(() =>
      expect(selectedOption()?.textContent).toContain("Search threads"),
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });

    expect(
      (
        screen.getByRole("combobox", {
          name: "Search threads",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("opens a specific settings page from Cmd-K", async () => {
    renderPalette();
    openThreadSearch();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), {
      target: { value: ">keyboard settings" },
    });
    await waitFor(() =>
      expect(selectedOption()?.textContent).toContain("Keyboard"),
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(
        "/settings/keyboard",
      ),
    );
  });

  it.each([false, true])(
    "excludes Files settings when Settings has no local opener (compact: %s)",
    async (compact) => {
      renderPalette(compact);
      openThreadSearch();
      await waitFor(() => expect(searchField()).toBeTruthy());

      fireEvent.change(searchField(), {
        target: { value: ">files settings" },
      });

      await waitFor(() =>
        expect(optionTitles()).not.toContainEqual(
          expect.stringContaining("Files settings"),
        ),
      );
    },
  );

  it("keeps Files settings when local helper access can be enabled", async () => {
    testState.filesAvailable = true;
    renderPalette();
    openThreadSearch();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), {
      target: { value: ">files settings" },
    });

    await waitFor(() =>
      expect(selectedOption()?.textContent).toContain("Files settings"),
    );
  });

  it("opens a plugin settings page from Cmd-K", async () => {
    testState.plugins.push({
      enabled: true,
      hasSettings: true,
      icon: null,
      id: "linear",
      name: "Linear",
    });
    renderPalette();
    openThreadSearch();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), {
      target: { value: ">linear settings" },
    });
    await waitFor(() =>
      expect(selectedOption()?.textContent).toContain("Linear settings"),
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(
        "/settings/plugins/linear",
      ),
    );
  });

  it("opens a plugin page from Cmd-K", async () => {
    setPluginSlotRegistrations(
      "automations",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "automations",
            title: "Automations",
            icon: "Calendar",
            path: "automations",
            component: () => null,
          },
        ],
        threadPanelActions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );
    renderPalette();
    openThreadSearch();
    await waitFor(() => expect(searchField()).toBeTruthy());

    fireEvent.change(searchField(), {
      target: { value: ">automations" },
    });
    await waitFor(() =>
      expect(selectedOption()?.textContent).toContain("Automations"),
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(
        "/plugins/automations/automations",
      ),
    );
  });

  it("opens a matched thread at its matched message", async () => {
    renderPalette();
    openThreadSearch();
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Matched thread/u }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("option", { name: /Matched thread/u }));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(
        "thr_message",
      ),
    );
    const location = JSON.parse(
      screen.getByTestId("location").textContent ?? "{}",
    ) as { pathname: string; state: Record<string, unknown> };
    expect(location.pathname).toContain("thr_message");
    expect(location.state).toEqual({
      searchMessageSeq: 7,
      searchThreadId: "thr_message",
    });
  });
});
