// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { sidebarNavigationProviderAtom } from "@/components/sidebar/sidebarNavigationProvider";
import {
  AUTOMATIC_REPLACEMENT_PROVIDER,
  BUILT_IN_REPLACEMENT_PROVIDER,
} from "@/lib/plugin-replacement-preference";
import { SidebarNavigationSetting } from "./SidebarNavigationSetting";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetPluginSlotStoreForTest();
});

describe("SidebarNavigationSetting", () => {
  it("defaults to automatic and lets the user pin the built-in navigation", async () => {
    setPluginSlotRegistrations(
      "navbar",
      makePluginRegistrationSet({
        experimentalSidebarNavigations: [
          {
            id: "grid",
            title: "Navigation grid",
            component: () => null,
          },
        ],
      }),
    );
    const store = createStore();
    render(
      <Provider store={store}>
        <SidebarNavigationSetting />
      </Provider>,
    );

    expect(store.get(sidebarNavigationProviderAtom)).toBe(
      AUTOMATIC_REPLACEMENT_PROVIDER,
    );
    const trigger = screen.getByRole("button", {
      name: "Sidebar navigation",
    });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: /built-in/u }));
    expect(store.get(sidebarNavigationProviderAtom)).toBe(
      BUILT_IN_REPLACEMENT_PROVIDER,
    );
  });
});
