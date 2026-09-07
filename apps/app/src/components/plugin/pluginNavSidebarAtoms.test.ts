// @vitest-environment jsdom

import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("pluginNavPanelOrderAtom migration", () => {
  it("converts legacy hidden keys into positional overflow order", async () => {
    window.localStorage.setItem(
      "bb.sidebar.pluginPanelOrder",
      JSON.stringify(["docs/main", "tasks/main", "github/main"]),
    );
    window.localStorage.setItem(
      "bb.sidebar.hiddenPluginPanels",
      JSON.stringify(["tasks/main", "docs/main"]),
    );

    const { pluginNavPanelOrderAtom, pluginNavVisiblePanelKeysAtom } =
      await import("./pluginNavSidebarAtoms");
    const store = createStore();

    expect(store.get(pluginNavPanelOrderAtom)).toEqual([
      "github/main",
      "docs/main",
      "tasks/main",
    ]);
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "github/main",
    ]);
    expect(
      window.localStorage.getItem("bb.sidebar.hiddenPluginPanels"),
    ).toBeNull();
  });

  it("migrates visibility when it is read before order", async () => {
    window.localStorage.setItem(
      "bb.sidebar.pluginPanelOrder",
      JSON.stringify(["docs/main", "tasks/main", "github/main"]),
    );
    window.localStorage.setItem(
      "bb.sidebar.hiddenPluginPanels",
      JSON.stringify(["tasks/main"]),
    );

    const { pluginNavPanelOrderAtom, pluginNavVisiblePanelKeysAtom } =
      await import("./pluginNavSidebarAtoms");
    const store = createStore();

    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "docs/main",
      "github/main",
    ]);
    expect(store.get(pluginNavPanelOrderAtom)).toEqual([
      "docs/main",
      "github/main",
      "tasks/main",
    ]);
  });

  it("migrates hidden Automations into the unified visibility preference", async () => {
    window.localStorage.setItem(
      "bb.sidebar.pluginPanelOrder",
      JSON.stringify(["docs/main"]),
    );
    window.localStorage.setItem(
      "bb.sidebar.hiddenPluginPanels",
      JSON.stringify(["docs/main", "automations/main"]),
    );

    const { pluginNavPanelOrderAtom, pluginNavVisiblePanelKeysAtom } =
      await import("./pluginNavSidebarAtoms");
    const store = createStore();

    expect(store.get(pluginNavPanelOrderAtom)).toEqual([
      "docs/main",
      "__bb__/automations",
    ]);
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([]);
    expect(
      window.localStorage.getItem("bb.sidebar.hiddenPluginPanels"),
    ).toBeNull();
  });

  it("maps legacy built-in order and visibility keys to unified keys", async () => {
    window.localStorage.setItem(
      "bb.sidebar.pluginPanelOrder",
      JSON.stringify(["__builtin__/tools", "automations/main", "docs/main"]),
    );
    window.localStorage.setItem(
      "bb.sidebar.visiblePluginPanels",
      JSON.stringify(["automations/main", "__builtin__/tools"]),
    );

    const { pluginNavPanelOrderAtom, pluginNavVisiblePanelKeysAtom } =
      await import("./pluginNavSidebarAtoms");
    const store = createStore();

    expect(store.get(pluginNavPanelOrderAtom)).toEqual([
      "__bb__/extensions",
      "__bb__/automations",
      "docs/main",
    ]);
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "__bb__/automations",
      "__bb__/extensions",
    ]);
  });

  it("keeps fresh visibility unset so defaults can follow available rows", async () => {
    const { pluginNavPanelOrderAtom, pluginNavVisiblePanelKeysAtom } =
      await import("./pluginNavSidebarAtoms");
    const store = createStore();

    expect(store.get(pluginNavPanelOrderAtom)).toEqual([]);
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toBeNull();
  });

  it("does not overwrite an existing visibility preference during migration", async () => {
    window.localStorage.setItem(
      "bb.sidebar.pluginPanelOrder",
      JSON.stringify(["docs/main", "tasks/main", "github/main"]),
    );
    window.localStorage.setItem(
      "bb.sidebar.visiblePluginPanels",
      JSON.stringify(["tasks/main"]),
    );
    window.localStorage.setItem(
      "bb.sidebar.hiddenPluginPanels",
      JSON.stringify(["docs/main"]),
    );

    const { pluginNavPanelOrderAtom, pluginNavVisiblePanelKeysAtom } =
      await import("./pluginNavSidebarAtoms");
    const store = createStore();

    expect(store.get(pluginNavPanelOrderAtom)).toEqual([
      "tasks/main",
      "github/main",
      "docs/main",
    ]);
    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual(["tasks/main"]);
  });

  it("persists an explicit empty visible list", async () => {
    const { pluginNavVisiblePanelKeysAtom } = await import(
      "./pluginNavSidebarAtoms"
    );
    const store = createStore();

    store.set(pluginNavVisiblePanelKeysAtom, []);

    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([]);
    expect(
      window.localStorage.getItem("bb.sidebar.visiblePluginPanels"),
    ).toBe("[]");
  });

  it("normalizes persisted visible keys without discarding unregistered keys", async () => {
    window.localStorage.setItem(
      "bb.sidebar.visiblePluginPanels",
      JSON.stringify(["docs/main", "future/main", "docs/main"]),
    );

    const { pluginNavVisiblePanelKeysAtom } = await import(
      "./pluginNavSidebarAtoms"
    );
    const store = createStore();

    expect(store.get(pluginNavVisiblePanelKeysAtom)).toEqual([
      "docs/main",
      "future/main",
    ]);
  });
});
