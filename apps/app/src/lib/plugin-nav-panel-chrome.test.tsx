// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  markPluginFrontendBootStarted,
  markPluginFrontendSettleFloorReached,
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "./plugin-frontend-boot-state";
import {
  readLastKnownPluginNavPanelChrome,
  usePluginNavPanelChrome,
  useRememberPluginNavPanelChrome,
  writeLastKnownPluginNavPanelChrome,
} from "./plugin-nav-panel-chrome";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "./plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

function Body() {
  return null;
}

function registrations(
  navPanels: PluginRegistrationSet["navPanels"],
): PluginRegistrationSet {
  return makePluginRegistrationSet({
    navPanels,
  });
}

const TASKS = {
  pluginId: "tasks",
  id: "tasks",
  path: "tasks",
  title: "Tasks",
  icon: "ListTodo",
};
const DOCS = {
  pluginId: "docs",
  id: "docs",
  path: "docs",
  title: "Docs",
  icon: "Book",
};

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginFrontendBootStateForTest();
  window.localStorage.clear();
});

describe("usePluginNavPanelChrome", () => {
  it("draws remembered chrome before boot and swaps to the live registration in place", () => {
    writeLastKnownPluginNavPanelChrome([TASKS, DOCS]);
    const { result } = renderHook(() => usePluginNavPanelChrome());
    expect(result.current.map((entry) => entry.chrome.title)).toEqual([
      "Tasks",
      "Docs",
    ]);
    expect(result.current.every((entry) => entry.panel === null)).toBe(true);

    act(() =>
      setPluginSlotRegistrations(
        "tasks",
        registrations([
          {
            id: "tasks",
            path: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            component: Body,
          },
        ]),
      ),
    );
    expect(result.current.map((entry) => entry.chrome.title)).toEqual([
      "Tasks",
      "Docs",
    ]);
    expect(result.current[0]!.panel).not.toBeNull();
    expect(result.current[1]!.panel).toBeNull();
  });

  it("forgets remembered panels that never registered once frontends settle", () => {
    writeLastKnownPluginNavPanelChrome([TASKS, DOCS]);
    act(() =>
      setPluginSlotRegistrations(
        "tasks",
        registrations([
          {
            id: "tasks",
            path: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            component: Body,
          },
        ]),
      ),
    );
    const { result } = renderHook(() => usePluginNavPanelChrome());
    expect(result.current).toHaveLength(2);
    act(() => markPluginFrontendsSettled());
    expect(result.current.map((entry) => entry.chrome.title)).toEqual([
      "Tasks",
    ]);
  });

  it("appends live panels the profile had not seen before", () => {
    writeLastKnownPluginNavPanelChrome([TASKS]);
    act(() =>
      setPluginSlotRegistrations(
        "docs",
        registrations([
          {
            id: "docs",
            path: "docs",
            title: "Docs",
            icon: "Book",
            component: Body,
          },
        ]),
      ),
    );
    const { result } = renderHook(() => usePluginNavPanelChrome());
    expect(result.current.map((entry) => entry.chrome.title)).toEqual([
      "Tasks",
      "Docs",
    ]);
  });
});

describe("useRememberPluginNavPanelChrome", () => {
  it("writes the live panels only after frontends have settled, and follows later changes", () => {
    act(() =>
      setPluginSlotRegistrations(
        "tasks",
        registrations([
          {
            id: "tasks",
            path: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            component: Body,
          },
        ]),
      ),
    );
    renderHook(() => useRememberPluginNavPanelChrome());
    expect(readLastKnownPluginNavPanelChrome()).toEqual([]);

    act(() => markPluginFrontendsSettled());
    expect(readLastKnownPluginNavPanelChrome()).toEqual([TASKS]);

    act(() => setPluginSlotRegistrations("tasks", registrations([])));
    expect(readLastKnownPluginNavPanelChrome()).toEqual([]);
  });

  it("does not overwrite remembered chrome on the settle floor or during a boot", () => {
    writeLastKnownPluginNavPanelChrome([TASKS, DOCS]);
    renderHook(() => useRememberPluginNavPanelChrome());

    act(() => markPluginFrontendSettleFloorReached());
    expect(readLastKnownPluginNavPanelChrome()).toEqual([TASKS, DOCS]);

    act(() => markPluginFrontendBootStarted());
    act(() =>
      setPluginSlotRegistrations(
        "tasks",
        registrations([
          {
            id: "tasks",
            path: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            component: Body,
          },
        ]),
      ),
    );
    expect(readLastKnownPluginNavPanelChrome()).toEqual([TASKS, DOCS]);

    act(() => markPluginFrontendsSettled());
    expect(readLastKnownPluginNavPanelChrome()).toEqual([TASKS]);
  });
});
