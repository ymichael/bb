// @vitest-environment jsdom

import { useEffect, useState, type MouseEventHandler } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalSidebarNavigationProps } from "@get-bb/plugin-sdk";
import { SidebarProvider } from "@/components/ui/sidebar";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  getNotifications,
  resetNotificationStore,
} from "@/lib/notifications/notification-store";
import { SidebarNavigationRegion } from "./SidebarNavigationRegion";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  openNewThreadInSplit: vi.fn(),
  onSearchThreads: vi.fn(),
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({
    dispatch: mocks.dispatch,
    isCommandAvailable: () => true,
  }),
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));
vi.mock("@/components/plugin/PluginNavSidebarItems", () => ({
  ExtensionsNavSidebarItem: () => <div>Extensions</div>,
  PluginNavSidebarItems: ({
    builtInEntries = [],
    entries = [],
  }: {
    builtInEntries?: Array<{
      id: string;
      title: string;
      onActivate: MouseEventHandler<HTMLButtonElement>;
    }>;
    entries?: Array<{ chrome: { pluginId: string; title: string } }>;
  }) => (
    <div>
      {builtInEntries.map((entry) => (
        <button key={entry.id} type="button" onClick={entry.onActivate}>
          {entry.title}
        </button>
      ))}
      {entries.map(({ chrome }) => (
        <div key={chrome.pluginId} data-testid="built-in-plugin-entry">
          {chrome.title}
        </div>
      ))}
    </div>
  ),
}));
vi.mock("./usePaneContentSplitDrag", () => ({
  usePaneContentSplitActions: () => ({
    beginDrag: vi.fn(),
    isCompact: false,
    openInSplit: vi.fn(),
  }),
}));

function Replacement({
  experimental_Original: Original,
  experimental_activate,
  items,
}: ExperimentalSidebarNavigationProps) {
  const [delegate, setDelegate] = useState(false);
  const [crash, setCrash] = useState(false);
  if (crash) throw new Error("navigation fixture crash");
  if (delegate) return <Original />;
  return (
    <div data-testid="replacement-navigation">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          {...item.experimental_splitProps}
          onClick={(event) =>
            experimental_activate(item.id, {
              openInSplit: event.metaKey || event.ctrlKey,
            })
          }
        >
          {item.label}
        </button>
      ))}
      <button type="button" onClick={() => setDelegate(true)}>
        Delegate to BB
      </button>
      <button type="button" onClick={() => setCrash(true)}>
        Crash replacement
      </button>
    </div>
  );
}

function LocationProbe() {
  return <output data-testid="pathname">{useLocation().pathname}</output>;
}

function RetainedOwner({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div data-testid="retained-owner">Retained thread list</div>;
}

function Harness({ onOwnerMount }: { onOwnerMount: () => void }) {
  return (
    <>
      <SidebarNavigationRegion
        splitEnabled
        newThreadSplit={{ openInSplit: mocks.openNewThreadInSplit }}
        onNavigate={vi.fn()}
        onNewChat={vi.fn()}
        onSearchThreads={mocks.onSearchThreads}
        toolsRoutePath="/tools/plugins"
      />
      <RetainedOwner onMount={onOwnerMount} />
      <LocationProbe />
    </>
  );
}

function renderHarness(onOwnerMount = vi.fn()) {
  return render(
    <Provider store={createStore()}>
      <MemoryRouter>
        <SidebarProvider>
          <Harness onOwnerMount={onOwnerMount} />
        </SidebarProvider>
      </MemoryRouter>
    </Provider>,
  );
}

function registerFixture() {
  setPluginSlotRegistrations(
    "garden",
    registrationSet({
      navPanels: [
        {
          id: "docs",
          title: "Docs",
          icon: "BookOpen",
          path: "docs",
          component: () => null,
        },
      ],
      experimentalSidebarNavigations: [
        {
          id: "navbar",
          title: "Garden Navbar",
          component: Replacement,
        },
      ],
    }),
  );
}

afterEach(() => {
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  resetPluginSlotStoreForTest();
  resetNotificationStore();
  window.localStorage.clear();
  vi.restoreAllMocks();
  mocks.dispatch.mockReset();
  mocks.openNewThreadInSplit.mockReset();
  mocks.onSearchThreads.mockReset();
});

describe("SidebarNavigationRegion", () => {
  it("preserves modifier-click for New thread in BB navigation", () => {
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "New thread" }), {
      metaKey: true,
    });

    expect(mocks.openNewThreadInSplit).toHaveBeenCalledOnce();
  });

  it("passes Automations through the plugin navigation row path", () => {
    setPluginSlotRegistrations(
      "automations",
      registrationSet({
        navPanels: [
          {
            id: "automations",
            title: "Automations",
            icon: "Calendar",
            path: "automations",
            component: () => null,
          },
        ],
      }),
    );
    renderHarness();

    expect(screen.getByTestId("built-in-plugin-entry").textContent).toBe(
      "Automations",
    );
  });

  it("routes Search through the quick palette without inline search UI", () => {
    registerFixture();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Search threads" }));

    expect(mocks.onSearchThreads).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledWith("thread.search", null);
    expect(
      screen.queryByRole("combobox", { name: "Search threads" }),
    ).toBeNull();
    expect(screen.getByTestId("replacement-navigation")).toBeDefined();
  });

  it("navigates to a current plugin destination through the host", () => {
    registerFixture();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Docs" }));

    expect(screen.getByTestId("pathname").textContent).toBe(
      "/plugins/garden/docs",
    );
  });

  it("delegates and falls back after a crash without owner remounts", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerFixture();
    const ownerMount = vi.fn();
    renderHarness(ownerMount);
    expect(ownerMount).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Delegate to BB" }));
    expect(screen.getByTestId("built-in-sidebar-navigation")).toBeDefined();
    expect(ownerMount).toHaveBeenCalledOnce();

    cleanup();
    resetAllCrashedPluginSlotsForTest();
    renderHarness(ownerMount);
    fireEvent.click(screen.getByRole("button", { name: "Crash replacement" }));
    expect(screen.getByTestId("built-in-sidebar-navigation")).toBeDefined();
    expect(ownerMount).toHaveBeenCalledTimes(2);
    expect(getNotifications()).toEqual([
      expect.objectContaining({
        title: "Sidebar navigation plugin crashed",
        description:
          "Garden Navbar (garden) stopped working, so bb's own navigation is back.",
      }),
    ]);
  });
});
