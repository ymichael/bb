// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { BUILT_IN_FILE_OPENER_PREFERENCE } from "@/lib/file-opener-preference";
import { FileOpenersSettingsSection } from "./FileOpenersSettingsSection";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

function registerNotesOpener() {
  setPluginSlotRegistrations(
    "notes",
    makePluginRegistrationSet({
      fileOpeners: [
        {
          id: "editor",
          title: "Notes editor",
          extensions: ["md", "mdx"],
          component: () => null,
        },
      ],
    }),
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetPluginSlotStoreForTest();
});

describe("FileOpenersSettingsSection", () => {
  it("defaults to automatic and persists built-in, plugin, and automatic choices", async () => {
    registerNotesOpener();
    render(<FileOpenersSettingsSection />);

    expect(screen.getByText(".md files")).toBeDefined();
    expect(screen.getByText(".mdx files")).toBeDefined();
    const trigger = screen.getByRole("button", {
      name: "Default opener for .md files",
    });
    expect(trigger.textContent).toContain("Automatic");

    await selectOption(trigger, /Built-in preview/u);
    expect(storedPreference()).toEqual({
      md: BUILT_IN_FILE_OPENER_PREFERENCE,
    });

    await selectOption(trigger, /Notes editor \(notes\)/u);
    expect(storedPreference()).toEqual({ md: "notes:editor" });

    await selectOption(trigger, /Automatic/u);
    expect(storedPreference()).toEqual({});
  });
});

async function selectOption(trigger: HTMLElement, name: RegExp) {
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

function storedPreference(): Record<string, string> {
  return JSON.parse(
    window.localStorage.getItem("bb.fileOpenerByExtension") ?? "{}",
  ) as Record<string, string>;
}
