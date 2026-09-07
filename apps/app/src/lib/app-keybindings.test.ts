// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  matchesAppShortcut,
  type AppCommandContext,
  type AppKeybinding,
  type AppShortcut,
} from "@bb/domain";
import {
  formatAppShortcut,
  formatAppShortcutAria,
  isEditableKeyboardTarget,
  matchesAppCommandContext,
} from "./app-keybindings";

const MOD_N: AppShortcut = {
  key: "n",
  mod: true,
  meta: false,
  control: false,
  alt: false,
  shift: false,
};

const ALT_P: AppShortcut = {
  key: "p",
  mod: false,
  meta: false,
  control: false,
  alt: true,
  shift: false,
};

const CONTEXT: AppCommandContext = {
  mainSurface: true,
  modalOpen: false,
  editableFocus: false,
  terminalFocus: false,
  browserFocus: false,
  modelPickerOpen: false,
  questionOpen: false,
  promptAvailable: false,
  splitActive: false,
  webSurface: false,
  macPlatform: false,
};

describe("app keybindings", () => {
  it("maps mod to the platform primary modifier and rejects extras", () => {
    const base = {
      key: "N",
      code: "KeyN",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    expect(matchesAppShortcut(base, MOD_N, true)).toBe(true);
    expect(
      matchesAppShortcut(
        { ...base, metaKey: false, ctrlKey: true },
        MOD_N,
        false,
      ),
    ).toBe(true);
    expect(matchesAppShortcut({ ...base, shiftKey: true }, MOD_N, true)).toBe(
      false,
    );
  });

  it("matches shifted punctuation against its unshifted binding key", () => {
    expect(
      matchesAppShortcut(
        {
          key: "{",
          code: "BracketLeft",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        },
        { ...MOD_N, key: "[", shift: true },
        true,
      ),
    ).toBe(true);
  });

  it.each([
    ["m", "µ", "KeyM"],
    ["p", "π", "KeyP"],
    ["t", "†", "KeyT"],
  ])(
    "matches Alt+%s by physical key when macOS reports %s",
    (key, composed, code) => {
      const shortcut: AppShortcut = {
        key,
        mod: false,
        meta: false,
        control: false,
        alt: true,
        shift: false,
      };
      expect(
        matchesAppShortcut(
          {
            key: composed,
            code,
            metaKey: false,
            ctrlKey: false,
            altKey: true,
            shiftKey: false,
          },
          shortcut,
          true,
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["m", "Â", "KeyM"],
    ["p", "∏", "KeyP"],
    ["t", "ˇ", "KeyT"],
  ])(
    "matches Alt+Shift+%s by physical key when macOS reports %s",
    (key, composed, code) => {
      expect(
        matchesAppShortcut(
          {
            key: composed,
            code,
            metaKey: false,
            ctrlKey: false,
            altKey: true,
            shiftKey: true,
          },
          { ...ALT_P, key, shift: true },
          true,
        ),
      ).toBe(true);
    },
  );

  it("keeps forward and backward Alt cycles mutually exclusive", () => {
    const input = {
      key: "m",
      code: "KeyM",
      metaKey: false,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    };
    const forward = { ...ALT_P, key: "m" };
    const backward = { ...forward, shift: true };

    expect(matchesAppShortcut(input, forward, false)).toBe(true);
    expect(matchesAppShortcut(input, backward, false)).toBe(false);
    expect(
      matchesAppShortcut(
        { ...input, key: "M", shiftKey: true },
        forward,
        false,
      ),
    ).toBe(false);
    expect(
      matchesAppShortcut(
        { ...input, key: "M", shiftKey: true },
        backward,
        false,
      ),
    ).toBe(true);
  });

  it("matches an uncomposed alt chord by key across platforms", () => {
    expect(
      matchesAppShortcut(
        {
          key: "m",
          code: "KeyM",
          metaKey: false,
          ctrlKey: false,
          altKey: true,
          shiftKey: false,
        },
        { ...ALT_P, key: "m" },
        false,
      ),
    ).toBe(true);
    expect(
      matchesAppShortcut(
        {
          key: "a",
          code: "KeyQ",
          metaKey: false,
          ctrlKey: false,
          altKey: true,
          shiftKey: false,
        },
        { ...ALT_P, key: "a" },
        false,
      ),
    ).toBe(true);
    expect(
      matchesAppShortcut(
        {
          key: "a",
          code: "KeyQ",
          metaKey: false,
          ctrlKey: false,
          altKey: true,
          shiftKey: false,
        },
        { ...ALT_P, key: "q" },
        false,
      ),
    ).toBe(false);
  });

  it("requires every positive context and excludes every negative context", () => {
    const binding: AppKeybinding = {
      command: "diff.toggle",
      desktopOnly: false,
      shortcut: MOD_N,
      when: {
        all: ["mainSurface"],
        none: ["editableFocus", "terminalFocus"],
      },
    };
    expect(matchesAppCommandContext(binding, CONTEXT)).toBe(true);
    expect(
      matchesAppCommandContext(binding, { ...CONTEXT, editableFocus: true }),
    ).toBe(false);
    expect(
      matchesAppCommandContext(binding, { ...CONTEXT, mainSurface: false }),
    ).toBe(false);
  });

  it("recognizes form controls and contenteditable descendants", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    expect(isEditableKeyboardTarget(input)).toBe(true);
    expect(isEditableKeyboardTarget(child)).toBe(true);
    expect(isEditableKeyboardTarget(document.createElement("button"))).toBe(
      false,
    );
  });

  it("formats platform-specific shortcut labels", () => {
    expect(formatAppShortcut(MOD_N, "MacIntel")).toBe("⌘ N");
    expect(formatAppShortcut(MOD_N, "Win32")).toBe("Ctrl + N");
    expect(formatAppShortcutAria(MOD_N, "MacIntel")).toBe("Meta+N");
    expect(formatAppShortcutAria(MOD_N, "Win32")).toBe("Control+N");

    expect(formatAppShortcut(ALT_P, "MacIntel")).toBe("⌥ P");
    expect(formatAppShortcut(ALT_P, "Win32")).toBe("Alt + P");
    expect(formatAppShortcutAria(ALT_P, "MacIntel")).toBe("Alt+P");
  });
});
