// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState, type ComponentType } from "react";
import { createStore, Provider } from "jotai";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  AUTOMATIONS_PLUGIN_ID,
  getPluginPanelRoutePath,
} from "@/lib/route-paths";
import {
  resetAllCrashedPluginSlotsForTest,
  resetCrashedPluginSlots,
} from "./PluginSlotMount";
import {
  type BuiltInSidebarNavEntry,
  ExtensionsNavSidebarItem,
  PluginNavSidebarItems,
  type SidebarNavActivationModifiers,
} from "./PluginNavSidebarItems";
import {
  pluginNavPanelOrderAtom,
  pluginNavVisiblePanelKeysAtom,
} from "./pluginNavSidebarAtoms";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { countPanes, findPaneByContent } from "@/lib/split-layout";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";

function registerPanel(
  pluginId: string,
  title: string,
  experimentalSidebarAccessory?: ComponentType,
) {
  setPluginSlotRegistrations(
    pluginId,
    registrationSet({
      navPanels: [
        {
          id: "main",
          title,
          icon: "Puzzle",
          path: "main",
          component: () => null,
          ...(experimentalSidebarAccessory === undefined
            ? {}
            : {
                experimental_sidebarAccessory: experimentalSidebarAccessory,
              }),
        },
      ],
    }),
  );
}

interface RenderSidebarItemsOptions {
  builtInEntries?: readonly BuiltInSidebarNavEntry[];
  storedOrder?: string[];
  storedVisibleKeys?: string[] | null;
  compactViewport?: boolean;
  compactCustomizeMode?: boolean;
  onCompactCustomizeModeChange?: (isCustomizing: boolean) => void;
  splitEnabled?: boolean;
}

function PluginNavSidebarItemsHarness({
  options,
}: {
  options: RenderSidebarItemsOptions;
}) {
  const [compactCustomizeMode, setCompactCustomizeMode] = useState(
    options.compactCustomizeMode ?? false,
  );
  const compactControlProps = options.compactViewport
    ? {
        compactCustomizeMode,
        onCompactCustomizeModeChange: (isCustomizing: boolean) => {
          setCompactCustomizeMode(isCustomizing);
          options.onCompactCustomizeModeChange?.(isCustomizing);
        },
      }
    : {};

  return (
    <PluginNavSidebarItems
      builtInEntries={options.builtInEntries}
      splitEnabled={options.splitEnabled}
      {...compactControlProps}
    />
  );
}

function renderSidebarItems(options: RenderSidebarItemsOptions = {}) {
  const store = createStore();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (options.storedOrder) {
    store.set(pluginNavPanelOrderAtom, options.storedOrder);
  }
  if ("storedVisibleKeys" in options) {
    store.set(pluginNavVisiblePanelKeysAtom, options.storedVisibleKeys ?? null);
  }
  if (options.splitEnabled) {
    store.set(splitLayoutAtom, {
      root: {
        type: "pane",
        paneId: "pane-1",
        content: { kind: "new-thread" },
      },
      focusedPaneId: "pane-1",
    });
  }
  const view = render(
    <CompactViewportOverrideProvider
      isCompactViewport={options.compactViewport ?? false}
    >
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <MemoryRouter initialEntries={["/"]}>
            <SidebarProvider>
              <PluginNavSidebarItemsHarness options={options} />
              <LocationProbe />
            </SidebarProvider>
          </MemoryRouter>
        </Provider>
      </QueryClientProvider>
    </CompactViewportOverrideProvider>,
  );
  return { ...view, store };
}

function LocationProbe() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

function panelRowNames(
  labels: readonly string[] = ["Docs", "GitHub"],
): string[] {
  const rowLabels = new Set(labels);
  const container = screen.queryByTestId("plugin-nav-sidebar-items");
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-sidebar-navigation-item]"),
  )
    .map((row) => row.textContent?.trim() ?? "")
    .filter((label) => rowLabels.has(label));
}

function builtInEntry(
  id: string,
  title: string,
  onActivate: (event: SidebarNavActivationModifiers) => void = vi.fn(),
): BuiltInSidebarNavEntry {
  return {
    kind: "built-in",
    pluginId: "__bb__",
    id,
    title,
    icon: <span aria-hidden="true" />,
    content: <button type="button">{title}</button>,
    onActivate,
  };
}

function customizeRows(): HTMLElement[] {
  return Array.from(
    screen
      .getByRole("list", { name: "Sidebar navigation" })
      .querySelectorAll<HTMLElement>("[data-plugin-nav-customize-item]"),
  );
}

function visibleRowKeys(): string[] {
  return Array.from(
    screen
      .getByTestId("plugin-nav-sidebar-items")
      .querySelectorAll("[data-sidebar-navigation-item]"),
  ).map((row) => row.getAttribute("data-sidebar-navigation-item") ?? "");
}

function moreTrigger(): HTMLElement {
  return screen.getByRole("button", { name: "More sidebar navigation" });
}

async function openMoreMenu(): Promise<HTMLElement[]> {
  fireEvent.pointerDown(moreTrigger(), { button: 0 });
  await screen.findByRole("menuitem", { name: "Customize sidebar" });
  return screen.getAllByRole("menuitem");
}

async function openCustomizeFromMore(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("menuitem", { name: "Customize sidebar" }));
  return await screen.findByRole("list", { name: "Sidebar navigation" });
}

async function openCustomizeFromContextMenu(
  target: HTMLElement,
): Promise<HTMLElement> {
  fireEvent.contextMenu(target);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Customize sidebar" }),
  );
  return await screen.findByRole("list", { name: "Sidebar navigation" });
}

beforeEach(() => {
  window.localStorage.clear();
  resetAllCrashedPluginSlotsForTest();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("PluginNavSidebarItems", () => {
  it("collapses the entire subsection with zero traditional plugins", () => {
    renderSidebarItems();

    expect(screen.queryByTestId("plugin-nav-sidebar-items")).toBeNull();
    expect(screen.queryByText("Plugins")).toBeNull();
  });

  it("shows one plugin without a More row and reaches Customize from the row menu", async () => {
    registerPanel("docs", "Docs");
    renderSidebarItems();

    expect(screen.queryByText("Plugins")).toBeNull();
    expect(panelRowNames(["Docs"])).toEqual(["Docs"]);
    expect(screen.queryByTestId("sidebar-navigation-more-row")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Customize sidebar navigation" }),
    ).toBeNull();

    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "Docs" }),
    );

    expect(customizeRows().map((row) => row.textContent?.trim())).toEqual([
      "Docs",
    ]);
  });

  it("keeps an accessory-less plugin row unchanged", () => {
    registerPanel("docs", "Docs");

    const view = renderSidebarItems();

    expect(screen.getByRole("button", { name: "Docs" }).textContent).toBe(
      "Docs",
    );
    expect(
      screen.getByRole("button", { name: "Docs" }).classList.contains("pr-7"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Docs" }).classList.contains("pr-18"),
    ).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Docs panel options" }),
    ).not.toBeNull();
    expect(
      view.container.querySelector("[data-plugin-nav-sidebar-accessory]"),
    ).toBeNull();
  });

  it("keeps the panel options trigger visible on mobile", () => {
    registerPanel("docs", "Docs");

    renderSidebarItems();

    expect(
      screen
        .getByRole("button", { name: "Docs panel options" })
        .closest("[data-sidebar-hover-actions-mobile]")
        ?.getAttribute("data-sidebar-hover-actions-mobile"),
    ).toBe("always");
  });

  it("bounds and truncates a long sidebar accessory", () => {
    registerPanel("tasks", "Tasks", () => (
      <span>123456789012345678901234567890</span>
    ));

    const view = renderSidebarItems();
    const accessory = view.container.querySelector(
      "[data-plugin-nav-sidebar-accessory]",
    );

    expect(accessory?.textContent).toBe("123456789012345678901234567890");
    expect(screen.getByRole("button", { name: "Tasks" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Tasks" }).classList.contains("pr-18"),
    ).toBe(true);
    for (const className of [
      "bb-sidebar-hover-actions-fade",
      "right-1",
      "min-w-5",
      "max-h-5",
      "max-w-16",
      "overflow-hidden",
      "text-xs",
      "text-ellipsis",
      "whitespace-nowrap",
    ]) {
      expect(accessory?.classList.contains(className), className).toBe(true);
    }
  });

  it("replaces a live accessory with row options without remounting it", async () => {
    let mounts = 0;
    let unmounts = 0;
    function LiveAccessory() {
      useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return <span>12</span>;
    }
    registerPanel("tasks", "Tasks", LiveAccessory);

    const view = renderSidebarItems();
    const accessory = view.container.querySelector(
      "[data-plugin-nav-sidebar-accessory]",
    );

    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(
      accessory?.getAttribute("data-sidebar-hover-actions-open"),
    ).toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Tasks panel options" }),
      { button: 0 },
    );
    expect(
      await screen.findByRole("menuitem", { name: "Hide from sidebar" }),
    ).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move to top" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Move to overflow" }),
    ).toBeNull();

    expect(accessory?.getAttribute("data-sidebar-hover-actions-open")).toBe(
      "true",
    );
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("does not mount sidebar accessories on compact viewports", () => {
    let mounts = 0;
    registerPanel("tasks", "Tasks", () => {
      mounts += 1;
      return <span>12</span>;
    });

    const view = renderSidebarItems({ compactViewport: true });

    expect(mounts).toBe(0);
    expect(
      view.container.querySelector("[data-plugin-nav-sidebar-accessory]"),
    ).toBeNull();
  });

  it("uses an in-place customization mode from the More drawer on compact viewports", async () => {
    const onCompactCustomizeModeChange = vi.fn();
    renderSidebarItems({
      compactViewport: true,
      builtInEntries: [
        builtInEntry("new-thread", "New thread"),
        builtInEntry("search-threads", "Search threads"),
      ],
      onCompactCustomizeModeChange,
    });

    expect(visibleRowKeys()).toEqual(["__bb__/new-thread"]);
    fireEvent.click(moreTrigger());
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize sidebar" }),
    );

    expect(onCompactCustomizeModeChange).toHaveBeenCalledWith(true);
    expect(
      screen.getByTestId("sidebar-navigation-customize-inline"),
    ).not.toBeNull();
    expect(
      screen
        .queryByRole("list", { name: "Sidebar navigation" })
        ?.closest("[role=dialog]"),
    ).toBeFalsy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Back to sidebar" })).toBe(
        document.activeElement,
      ),
    );
    expect(
      screen.queryByRole("button", { name: "More sidebar navigation" }),
    ).toBeNull();
    const firstCustomizeRow = customizeRows()[0];
    const firstDragHandle = firstCustomizeRow?.querySelector<HTMLElement>(
      "[data-plugin-nav-customize-drag-handle]",
    );
    const firstCheckbox = within(firstCustomizeRow as HTMLElement).getByRole(
      "checkbox",
    );
    expect(
      firstCustomizeRow?.classList.contains("max-md:pointer-coarse:h-9"),
    ).toBe(true);
    expect(
      firstDragHandle?.classList.contains("max-md:pointer-coarse:h-9"),
    ).toBe(true);
    expect(
      firstDragHandle?.classList.contains("max-md:pointer-coarse:w-9"),
    ).toBe(true);
    expect(
      firstCheckbox
        .closest("label")
        ?.classList.contains("max-md:pointer-coarse:h-9"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back to sidebar" }));

    expect(onCompactCustomizeModeChange).toHaveBeenLastCalledWith(false);
    expect(
      screen.queryByTestId("sidebar-navigation-customize-inline"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "New thread" })).not.toBeNull();
    expect(moreTrigger()).toBe(document.activeElement);
  });

  it("keeps compact visibility changes in place and closes the mode when launching", async () => {
    const onActivate = vi.fn();
    const { store } = renderSidebarItems({
      compactViewport: true,
      builtInEntries: [builtInEntry("new-thread", "New thread", onActivate)],
    });

    expect(screen.queryByTestId("sidebar-navigation-more-row")).toBeNull();
    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "New thread" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Show New thread in sidebar" }),
    );

    expect(
      screen.getByTestId("sidebar-navigation-customize-inline"),
    ).not.toBeNull();
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("sidebar-navigation-customize-inline"),
    ).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("replaces the desktop rows with an inline card until Done", async () => {
    renderSidebarItems({
      builtInEntries: [
        builtInEntry("new-thread", "New thread"),
        builtInEntry("search-threads", "Search threads"),
      ],
    });

    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "New thread" }),
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen
        .getByTestId("plugin-nav-sidebar-items")
        .getAttribute("data-sidebar-navigation-customize-mode"),
    ).toBe("true");
    expect(
      screen.getByTestId("sidebar-navigation-customize-inline"),
    ).not.toBeNull();
    expect(screen.queryByTestId("sidebar-navigation-more-row")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Back to sidebar" }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        document.activeElement?.getAttribute(
          "data-sidebar-navigation-customize-launch",
        ),
      ).toBe("__bb__/new-thread"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(
      screen.queryByRole("list", { name: "Sidebar navigation" }),
    ).toBeNull();
    expect(visibleRowKeys()).toEqual(["__bb__/new-thread"]);
    expect(moreTrigger()).toBe(document.activeElement);
  });

  it("closes the inline card on Escape", async () => {
    renderSidebarItems({
      builtInEntries: [builtInEntry("new-thread", "New thread")],
    });

    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "New thread" }),
    );
    fireEvent.keyDown(
      screen.getByTestId("sidebar-navigation-customize-inline"),
      { key: "Escape" },
    );

    expect(
      screen.queryByRole("list", { name: "Sidebar navigation" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "New thread" })).not.toBeNull();
  });

  it("hides a built-in row from its context menu", async () => {
    const { store } = renderSidebarItems({
      builtInEntries: [
        builtInEntry("new-thread", "New thread"),
        builtInEntry("extensions", "Extensions"),
      ],
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Extensions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide from sidebar" }),
    );

    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "__bb__/new-thread",
    ]);
    expect(visibleRowKeys()).toEqual(["__bb__/new-thread"]);
    expect(screen.getByTestId("sidebar-navigation-more-row")).not.toBeNull();
  });

  it("hides a crashed accessory and retries it after a plugin reload", () => {
    function CrashingAccessory(): never {
      throw new Error("accessory crashed");
    }
    registerPanel("tasks", "Tasks", CrashingAccessory);

    const view = renderSidebarItems();

    expect(screen.queryByText("plugin tasks crashed")).toBeNull();
    expect(
      view.container.querySelector("[data-plugin-nav-sidebar-accessory]"),
    ).not.toBeNull();

    resetCrashedPluginSlots("tasks");
    act(() => registerPanel("tasks", "Tasks", () => <span>18</span>));

    expect(screen.getByText("18")).toBeDefined();
    expect(screen.queryByText("plugin tasks crashed")).toBeNull();
  });

  it("shows every plugin directly by default", () => {
    const labels = ["One", "Two", "Three", "Four", "Five", "Six"];
    labels.forEach((label, index) => registerPanel(`plugin-${index}`, label));

    renderSidebarItems();

    expect(panelRowNames(labels)).toEqual(labels);
    expect(screen.queryByTestId("sidebar-navigation-more-row")).toBeNull();
  });

  it("hides only Search by default and offers it under More", async () => {
    const labels = ["One", "Two", "Three", "Four"];
    labels.forEach((label, index) => registerPanel(`plugin-${index}`, label));
    const onSearch = vi.fn();
    renderSidebarItems({
      builtInEntries: [
        builtInEntry("new-thread", "New thread"),
        builtInEntry("search-threads", "Search threads", onSearch),
      ],
      storedOrder: [
        "plugin-0/main",
        "__bb__/new-thread",
        "plugin-1/main",
        "__bb__/search-threads",
        "plugin-2/main",
        "plugin-3/main",
      ],
    });

    expect(visibleRowKeys()).toEqual([
      "plugin-0/main",
      "__bb__/new-thread",
      "plugin-1/main",
      "plugin-2/main",
      "plugin-3/main",
    ]);
    expect(
      screen.getByTestId("plugin-nav-sidebar-items").lastElementChild,
    ).toBe(screen.getByTestId("sidebar-navigation-more-row"));

    const items = await openMoreMenu();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Search threads",
      "Customize sidebar",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Search threads" }));

    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch.mock.calls[0]?.[0]).toEqual({
      metaKey: false,
      ctrlKey: false,
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("opens a hidden plugin in a split on modifier-click from More", async () => {
    registerPanel("docs", "Docs");
    const { store } = renderSidebarItems({
      splitEnabled: true,
      storedOrder: ["docs/main"],
      storedVisibleKeys: [],
    });

    await openMoreMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Docs" }), {
      metaKey: true,
    });

    const layout = store.get(splitLayoutAtom);
    expect(layout).not.toBeNull();
    expect(countPanes(layout!.root)).toBe(2);
    expect(
      findPaneByContent(layout!.root, {
        kind: "plugin-panel",
        pluginId: "docs",
        panelPath: "main",
        subPath: "",
      }),
    ).not.toBeNull();
  });

  it("keeps launch and visibility as distinct targets with a clear row hover state", async () => {
    const labels = ["One", "Two", "Three", "Four"];
    labels.forEach((label, index) => registerPanel(`plugin-${index}`, label));
    const { store, unmount } = renderSidebarItems();

    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "One" }),
    );
    const choices = screen.getAllByRole("checkbox");
    await waitFor(() =>
      expect(
        document.activeElement?.getAttribute(
          "data-sidebar-navigation-customize-launch",
        ),
      ).toBe("plugin-0/main"),
    );
    expect(choices.map((choice) => choice.getAttribute("data-state"))).toEqual([
      "checked",
      "checked",
      "checked",
      "checked",
    ]);
    expect(
      document.querySelectorAll("[data-plugin-nav-customize-drag-handle]"),
    ).toHaveLength(4);
    expect(
      customizeRows()[0]?.classList.contains("hover:bg-sidebar-accent"),
    ).toBe(true);

    fireEvent.click(choices[0]!);
    expect(
      screen.getByRole("list", { name: "Sidebar navigation" }),
    ).not.toBeNull();
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "plugin-1/main",
      "plugin-2/main",
      "plugin-3/main",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(panelRowNames(labels)).toEqual(["Two", "Three", "Four"]);
    expect(screen.getByTestId("sidebar-navigation-more-row")).not.toBeNull();

    unmount();
    renderSidebarItems();
    expect(panelRowNames(labels)).toEqual(["Two", "Three", "Four"]);
    expect(screen.queryByRole("button", { name: "One" })).toBeNull();

    const items = await openMoreMenu();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "One",
      "Customize sidebar",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "One" }));

    expect(screen.getByTestId("location-path").textContent).toBe(
      getPluginPanelRoutePath({ pluginId: "plugin-0", path: "main" }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(panelRowNames(labels)).toEqual(["Two", "Three", "Four"]);
  });

  it("seeds newly introduced built-ins without overriding existing plugin visibility", () => {
    registerPanel("docs", "Docs");
    registerPanel("tasks", "Tasks");
    const { store } = renderSidebarItems({
      builtInEntries: [
        builtInEntry("new-thread", "New thread"),
        builtInEntry("search-threads", "Search threads"),
      ],
      storedOrder: ["tasks/main", "docs/main"],
      storedVisibleKeys: ["docs/main"],
    });

    expect(visibleRowKeys()).toEqual(["__bb__/new-thread", "docs/main"]);
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "__bb__/new-thread",
      "docs/main",
    ]);
  });

  it("shows a newly installed plugin without touching existing choices", () => {
    registerPanel("docs", "Docs");
    registerPanel("tasks", "Tasks");
    const { store } = renderSidebarItems({
      builtInEntries: [builtInEntry("new-thread", "New thread")],
      storedOrder: ["__bb__/new-thread", "docs/main"],
      storedVisibleKeys: ["__bb__/new-thread"],
    });

    expect(visibleRowKeys()).toEqual(["__bb__/new-thread", "tasks/main"]);
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "tasks/main",
      "__bb__/new-thread",
    ]);
    expect(store.get(pluginNavPanelOrderAtom)).toEqual([
      "__bb__/new-thread",
      "docs/main",
      "tasks/main",
    ]);
  });

  it("respects a stored choice to keep Search visible", () => {
    renderSidebarItems({
      builtInEntries: [
        builtInEntry("new-thread", "New thread"),
        builtInEntry("search-threads", "Search threads"),
      ],
      storedOrder: ["__bb__/new-thread", "__bb__/search-threads"],
      storedVisibleKeys: ["__bb__/new-thread", "__bb__/search-threads"],
    });

    expect(visibleRowKeys()).toEqual([
      "__bb__/new-thread",
      "__bb__/search-threads",
    ]);
    expect(screen.queryByTestId("sidebar-navigation-more-row")).toBeNull();
  });

  it("shows More only while something is hidden", async () => {
    renderSidebarItems({
      builtInEntries: [builtInEntry("new-thread", "New thread")],
    });

    expect(screen.queryByTestId("sidebar-navigation-more-row")).toBeNull();
    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "New thread" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Show New thread in sidebar" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(visibleRowKeys()).toEqual([]);
    expect(screen.getByTestId("sidebar-navigation-more-row")).not.toBeNull();

    await openMoreMenu();
    await openCustomizeFromMore();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Show New thread in sidebar" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(visibleRowKeys()).toEqual(["__bb__/new-thread"]);
    expect(screen.queryByTestId("sidebar-navigation-more-row")).toBeNull();
  });

  it("applies one persisted mixed order to direct rows and the menu", async () => {
    const labels = ["One", "Two", "Three", "Four"];
    labels.forEach((label, index) => registerPanel(`plugin-${index}`, label));
    const newThread = builtInEntry("new-thread", "New thread");
    const searchThreads = builtInEntry("search-threads", "Search threads");
    renderSidebarItems({
      builtInEntries: [newThread, searchThreads],
      storedOrder: [
        "plugin-3/main",
        "__bb__/search-threads",
        "plugin-1/main",
        "__bb__/new-thread",
        "plugin-0/main",
        "plugin-2/main",
      ],
      storedVisibleKeys: [
        "plugin-3/main",
        "__bb__/search-threads",
        "__bb__/new-thread",
        "plugin-0/main",
      ],
    });

    expect(visibleRowKeys()).toEqual([
      "plugin-3/main",
      "__bb__/search-threads",
      "__bb__/new-thread",
      "plugin-0/main",
    ]);

    const items = await openMoreMenu();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Two",
      "Three",
      "Customize sidebar",
    ]);
    await openCustomizeFromMore();
    expect(customizeRows().map((row) => row.textContent?.trim())).toEqual([
      "Four",
      "Search threads",
      "Two",
      "New thread",
      "One",
      "Three",
    ]);
    expect(
      screen
        .getAllByRole("checkbox")
        .map((choice) => choice.getAttribute("data-state")),
    ).toEqual([
      "checked",
      "checked",
      "unchecked",
      "checked",
      "checked",
      "unchecked",
    ]);
  });

  it("launches a built-in row from the menu without changing its visibility", async () => {
    const onActivate = vi.fn();
    renderSidebarItems({
      builtInEntries: [builtInEntry("new-thread", "New thread", onActivate)],
    });

    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "New thread" }),
    );
    const row = customizeRows()[0];
    expect(row).toBeDefined();
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "New thread" }),
    );

    expect(onActivate).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Sidebar navigation" }),
      ).toBeNull(),
    );
  });

  it("preserves modifier-click when launching a built-in from Customize", async () => {
    const onActivate = vi.fn();
    renderSidebarItems({
      builtInEntries: [builtInEntry("new-thread", "New thread", onActivate)],
    });

    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "New thread" }),
    );
    const row = customizeRows()[0];
    expect(row).toBeDefined();
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "New thread" }),
      { metaKey: true },
    );

    expect(onActivate).toHaveBeenCalledOnce();
    expect(onActivate.mock.calls[0]?.[0]).toMatchObject({ metaKey: true });
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Sidebar navigation" }),
      ).toBeNull(),
    );
  });

  it("preserves modifier-click when launching a plugin from Customize", async () => {
    registerPanel("docs", "Docs");
    const { store } = renderSidebarItems({ splitEnabled: true });

    await openCustomizeFromContextMenu(
      screen.getByRole("button", { name: "Docs" }),
    );
    const row = customizeRows()[0];
    expect(row).toBeDefined();
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Docs" }),
      { metaKey: true },
    );

    const layout = store.get(splitLayoutAtom);
    expect(layout).not.toBeNull();
    expect(countPanes(layout!.root)).toBe(2);
    expect(
      findPaneByContent(layout!.root, {
        kind: "plugin-panel",
        pluginId: "docs",
        panelPath: "main",
        subPath: "",
      }),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Sidebar navigation" }),
      ).toBeNull(),
    );
  });

  it("keeps Automations on the plugin row contract with a unified identity", () => {
    registerPanel(AUTOMATIONS_PLUGIN_ID, "Automations", () => (
      <span>Scheduled</span>
    ));
    const view = renderSidebarItems({ splitEnabled: true });

    expect(
      view.container.querySelector(
        '[data-sidebar-navigation-item="__bb__/automations"]',
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Automations panel options" }),
    ).not.toBeNull();
    expect(
      view.container.querySelector("[data-plugin-nav-sidebar-accessory]")
        ?.textContent,
    ).toBe("Scheduled");

    fireEvent.click(screen.getByRole("button", { name: "Automations" }), {
      metaKey: true,
    });
    const layout = view.store.get(splitLayoutAtom);
    expect(layout).not.toBeNull();
    expect(countPanes(layout!.root)).toBe(2);
    expect(
      findPaneByContent(layout!.root, {
        kind: "plugin-panel",
        pluginId: AUTOMATIONS_PLUGIN_ID,
        panelPath: "main",
        subPath: "",
      }),
    ).not.toBeNull();
  });
});

describe("ExtensionsNavSidebarItem", () => {
  it("is host-owned and has no plugin-panel options menu", () => {
    render(
      <MemoryRouter>
        <ExtensionsNavSidebarItem routePath="/extensions/plugins" />
      </MemoryRouter>,
    );

    const row = screen.getByRole("button", { name: "Extensions" });
    expect(row.querySelector(".bb-sidebar-row-icon-swap")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Extensions panel options" }),
    ).toBeNull();
  });
});
