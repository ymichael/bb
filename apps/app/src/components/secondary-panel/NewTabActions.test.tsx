// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { PluginPanelActionEntry } from "@/components/plugin/PluginPanelActions";
import { setCompactSidebarDrawerShowing } from "@/components/ui/sidebar-mobile-drawer-visibility";
import { NewTabActions } from "./NewTabActions";
import { newTabActionOrderAtom } from "./newTabActionsAtoms";

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));

const START_TERMINAL_ID = "file-search-result-start-terminal";

function pluginAction(id: string, title: string): PluginPanelActionEntry {
  return {
    id: `plugin-action:${id}`,
    pluginId: id,
    icon: null,
    title,
    onSelect: () => undefined,
  };
}

const sideChat = pluginAction("side-chat", "Start side chat");
const quickstart = pluginAction("quickstart", "Quickstart");

function renderActions(
  storedOrder: string[],
  pluginActions: PluginPanelActionEntry[],
) {
  const store = createStore();
  store.set(newTabActionOrderAtom, storedOrder);
  return render(
    <Provider store={store}>
      <NewTabActions
        onStartTerminal={() => undefined}
        pluginActions={pluginActions}
      />
    </Provider>,
  );
}

function actionLabels(): string[] {
  return screen
    .getAllByRole("button")
    .map((button) => button.textContent?.trim() ?? "")
    .filter((label) => label.length > 0);
}

afterEach(() => {
  cleanup();
  setCompactSidebarDrawerShowing(false);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NewTabActions", () => {
  it("keeps a trailing terminal control separate from the terminal action", () => {
    const onSelectHost = vi.fn();
    const onStartTerminal = vi.fn();
    const { container } = render(
      <NewTabActions
        onStartTerminal={onStartTerminal}
        startTerminalTrailing={
          <button type="button" onClick={onSelectHost}>
            Machine
          </button>
        }
      />,
    );

    expect(container.querySelector("button button")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Machine" }));
    expect(onSelectHost).toHaveBeenCalledOnce();
    expect(onStartTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start terminal" }));
    expect(onStartTerminal).toHaveBeenCalledOnce();
  });

  it("renders built-in and plugin actions in the order the user saved", () => {
    renderActions([sideChat.id, START_TERMINAL_ID], [sideChat]);

    expect(actionLabels()).toEqual(["Start side chat", "Start terminal"]);
  });

  it("offers a reorder handle per action once there are two to order", () => {
    renderActions([], [sideChat]);

    expect(
      screen
        .getAllByRole("button", { name: /^Reorder / })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Reorder Start terminal", "Reorder Start side chat"]);
  });

  it("offers no reorder handle when a single action cannot move", () => {
    renderActions([], []);

    expect(
      screen.getByRole("button", { name: "Start terminal" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Reorder / })).toBeNull();
  });

  it("appends an action the saved order has never seen", () => {
    renderActions([sideChat.id, START_TERMINAL_ID], [sideChat, quickstart]);

    expect(actionLabels()).toEqual([
      "Start side chat",
      "Start terminal",
      "Quickstart",
    ]);
  });

  it("installs touch reorder on a compact viewport while the sidebar drawer is closed", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: COMPACT_VIEWPORT_QUERY,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    setCompactSidebarDrawerShowing(false);
    const addSpy = vi.spyOn(window, "addEventListener");

    renderActions([], [sideChat]);

    const touchMoveInstalls = addSpy.mock.calls.filter(
      ([type]) => type === "touchmove",
    );
    expect(touchMoveInstalls).toHaveLength(1);
    expect(touchMoveInstalls[0]?.[2]).toEqual({
      capture: false,
      passive: false,
    });
  });

  it("uses the default order after stored data has an invalid shape", () => {
    window.localStorage.setItem("bb.newTab.actionOrder", JSON.stringify({}));
    const store = createStore();

    render(
      <Provider store={store}>
        <NewTabActions
          onStartTerminal={() => undefined}
          pluginActions={[sideChat]}
        />
      </Provider>,
    );

    expect(store.get(newTabActionOrderAtom)).toEqual([]);
    expect(actionLabels()).toEqual(["Start terminal", "Start side chat"]);
  });
});
