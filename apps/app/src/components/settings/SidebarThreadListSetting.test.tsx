// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { threadListProviderAtom } from "@/components/sidebar/threadListProvider";
import {
  AUTOMATIC_REPLACEMENT_PROVIDER,
  BUILT_IN_REPLACEMENT_PROVIDER,
} from "@/lib/plugin-replacement-preference";
import { SidebarThreadListSetting } from "./SidebarThreadListSetting";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetPluginSlotStoreForTest();
});

describe("SidebarThreadListSetting", () => {
  it("defaults to automatic and lets the user pin BB's list", async () => {
    setPluginSlotRegistrations(
      "inbox",
      makePluginRegistrationSet({
        threadLists: [
          {
            id: "inbox",
            title: "Inbox",
            component: () => null,
          },
        ],
      }),
    );
    const store = createStore();
    render(
      <JotaiProvider store={store}>
        <SidebarThreadListSetting />
      </JotaiProvider>,
    );

    expect(store.get(threadListProviderAtom)).toBe(
      AUTOMATIC_REPLACEMENT_PROVIDER,
    );
    const trigger = screen.getByRole("button", {
      name: "Sidebar thread list",
    });
    expect(trigger.textContent).toContain("Automatic");

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: /built-in/u }));

    expect(store.get(threadListProviderAtom)).toBe(
      BUILT_IN_REPLACEMENT_PROVIDER,
    );
  });
});
