import { describe, expect, it } from "vitest";
import { getAppKeybindingOverrides } from "@bb/db";
import {
  PANE_FOCUS_APP_COMMAND_IDS,
  THREAD_JUMP_APP_COMMAND_IDS,
  applyAppKeybindingOverrides,
  appKeybindingOverridesSchema,
  isAppKeybindingAvailableForClient,
} from "@bb/domain";
import { systemConfigResponseSchema } from "@bb/server-contract";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/services/system/app-keybindings.js";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

const DEFAULT_KEYBINDING_CLIENTS = [
  { name: "desktop-mac", isDesktop: true, isMac: true },
  { name: "desktop-other", isDesktop: true, isMac: false },
  { name: "web-mac", isDesktop: false, isMac: true },
  { name: "web-other", isDesktop: false, isMac: false },
] as const;

function shortcutIdentity(
  binding: ReturnType<typeof applyAppKeybindingOverrides>[number],
  isMac: boolean,
): string {
  const { shortcut } = binding;
  return JSON.stringify({
    key: shortcut.key.toLowerCase(),
    meta: shortcut.meta || (shortcut.mod && isMac),
    control: shortcut.control || (shortcut.mod && !isMac),
    alt: shortcut.alt,
    shift: shortcut.shift,
  });
}

function bindingContextsOverlap(
  left: ReturnType<typeof applyAppKeybindingOverrides>[number],
  right: ReturnType<typeof applyAppKeybindingOverrides>[number],
): boolean {
  const leftAll = new Set(left.when.all);
  const rightAll = new Set(right.when.all);
  return (
    !left.when.none.some((context) => rightAll.has(context)) &&
    !right.when.none.some((context) => leftAll.has(context))
  );
}

function commandPair(left: string, right: string): string {
  return [left, right].sort().join("+");
}

describe("app keybindings", () => {
  it("limits overlapping default chords to intentional scoped navigation", () => {
    const assignedDefaults = applyAppKeybindingOverrides(
      DEFAULT_APP_KEYBINDINGS,
      [],
    );
    const actualCollisions = new Set<string>();

    for (const client of DEFAULT_KEYBINDING_CLIENTS) {
      const availableBindings = assignedDefaults.filter((binding) =>
        isAppKeybindingAvailableForClient(binding, client),
      );
      for (const [index, left] of availableBindings.entries()) {
        for (const right of availableBindings.slice(index + 1)) {
          if (
            left.command === right.command ||
            shortcutIdentity(left, client.isMac) !==
              shortcutIdentity(right, client.isMac) ||
            !bindingContextsOverlap(left, right)
          ) {
            continue;
          }
          actualCollisions.add(
            `${client.name}:${commandPair(left.command, right.command)}`,
          );
        }
      }
    }

    const intentionalCommandPairs = PANE_FOCUS_APP_COMMAND_IDS.map(
      (paneCommand, index) =>
        commandPair(paneCommand, THREAD_JUMP_APP_COMMAND_IDS[index]),
    );
    const allowedCollisions = DEFAULT_KEYBINDING_CLIENTS.flatMap((client) =>
      intentionalCommandPairs.map((pair) => `${client.name}:${pair}`),
    );
    expect([...actualCollisions].sort()).toEqual(allowedCollisions.sort());
  });

  it("serves validated explicit defaults from system config", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const config = systemConfigResponseSchema.parse(await readJson(response));
      const assignedDefaultKeybindings = applyAppKeybindingOverrides(
        config.defaultKeybindings,
        [],
      );
      expect(config.keybindingOverrides).toEqual([]);
      expect(assignedDefaultKeybindings).toEqual(config.keybindings);
      for (const command of ["thread.rename", "thread.archive"] as const) {
        expect(
          config.defaultKeybindings.find(
            (binding) => binding.command === command,
          ),
        ).toMatchObject({
          desktopOnly: false,
          shortcut: null,
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        });
        expect(
          config.keybindings.some((binding) => binding.command === command),
        ).toBe(false);
      }
      for (const command of [
        "pane.focus.previous",
        "pane.focus.next",
      ] as const) {
        expect(
          config.defaultKeybindings.find(
            (binding) => binding.command === command,
          ),
        ).toMatchObject({
          desktopOnly: false,
          shortcut: null,
          when: {
            all: ["mainSurface", "splitActive"],
            none: ["modalOpen"],
          },
        });
        expect(
          config.keybindings.some((binding) => binding.command === command),
        ).toBe(false);
      }
      expect(
        config.keybindings
          .filter((binding) => binding.command === "thread.new")
          .map((binding) => ({
            desktopOnly: binding.desktopOnly,
            key: binding.shortcut.key,
            shift: binding.shortcut.shift,
          })),
      ).toEqual([
        { desktopOnly: false, key: "o", shift: true },
        { desktopOnly: true, key: "n", shift: false },
      ]);
      expect(
        config.keybindings.find((binding) => binding.command === "window.new"),
      ).toMatchObject({
        desktopOnly: true,
        shortcut: { key: "n", mod: true, shift: true },
      });
      expect(
        config.keybindings.find((binding) => binding.command === "app.back"),
      ).toMatchObject({
        desktopOnly: false,
        shortcut: {
          key: "Escape",
          mod: false,
          meta: false,
          control: false,
          alt: false,
          shift: false,
        },
        when: { all: ["mainSurface"], none: ["modalOpen"] },
      });
      expect(
        config.keybindings.find(
          (binding) => binding.command === "panel.reopenClosedTab",
        ),
      ).toMatchObject({
        desktopOnly: true,
        shortcut: { key: "t", mod: true, shift: true },
      });
      expect(
        config.keybindings.filter(
          (binding) => binding.command === "terminal.open",
        ),
      ).toMatchObject([
        {
          desktopOnly: false,
          shortcut: { key: "Enter", mod: true, shift: true },
        },
      ]);
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.command === "thread.previous")
          .map((binding) => ({
            desktopOnly: binding.desktopOnly,
            key: binding.shortcut.key,
            mod: binding.shortcut.mod,
            control: binding.shortcut.control,
            shift: binding.shortcut.shift,
            when: binding.when,
          })),
      ).toEqual([
        {
          desktopOnly: false,
          key: "[",
          mod: false,
          control: true,
          shift: true,
          when: {
            all: ["mainSurface", "webSurface"],
            none: ["modalOpen"],
          },
        },
        {
          desktopOnly: true,
          key: "[",
          mod: true,
          control: false,
          shift: true,
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ]);
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.command === "thread.next")
          .map((binding) => ({
            desktopOnly: binding.desktopOnly,
            key: binding.shortcut.key,
            mod: binding.shortcut.mod,
            control: binding.shortcut.control,
            shift: binding.shortcut.shift,
            when: binding.when,
          })),
      ).toEqual([
        {
          desktopOnly: false,
          key: "]",
          mod: false,
          control: true,
          shift: true,
          when: {
            all: ["mainSurface", "webSurface"],
            none: ["modalOpen"],
          },
        },
        {
          desktopOnly: true,
          key: "]",
          mod: true,
          control: false,
          shift: true,
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ]);
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.command.startsWith("thread.jump."))
          .map((binding) => ({
            command: binding.command,
            desktopOnly: binding.desktopOnly,
            key: binding.shortcut.key,
            mod: binding.shortcut.mod,
            control: binding.shortcut.control,
            shift: binding.shortcut.shift,
            when: binding.when,
          })),
      ).toEqual(
        THREAD_JUMP_APP_COMMAND_IDS.flatMap((command, index) => [
          {
            command,
            desktopOnly: false,
            key: String(index + 1),
            mod: false,
            control: true,
            shift: false,
            when: {
              all: ["mainSurface", "webSurface", "macPlatform"],
              none: ["modalOpen"],
            },
          },
          {
            command,
            desktopOnly: false,
            key: String(index + 1),
            mod: true,
            control: false,
            shift: true,
            when: {
              all: ["mainSurface", "webSurface"],
              none: ["modalOpen", "macPlatform"],
            },
          },
          {
            command,
            desktopOnly: true,
            key: String(index + 1),
            mod: true,
            control: false,
            shift: false,
            when: {
              all: ["mainSurface"],
              none: ["modalOpen"],
            },
          },
        ]),
      );
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.command === "terminal.open")
          .map((binding) => ({
            desktopOnly: binding.desktopOnly,
            key: binding.shortcut.key,
          })),
      ).toEqual([
        { desktopOnly: false, key: "Enter" },
      ]);
      expect(
        assignedDefaultKeybindings.find(
          (binding) => binding.command === "composer.focus",
        ),
      ).toMatchObject({
        desktopOnly: false,
        shortcut: { key: "c", mod: true, shift: true },
        when: {
          all: ["mainSurface", "promptAvailable"],
          none: ["modalOpen", "terminalFocus", "browserFocus"],
        },
      });
      const composerWhen = {
        all: ["mainSurface", "promptAvailable"],
        none: ["modalOpen", "terminalFocus", "browserFocus"],
      };
      const pickerOpenWhen = {
        all: ["mainSurface", "modelPickerOpen"],
        none: [],
      };
      const altChord = (
        command: string,
        key: string,
        shift: boolean,
        when: { all: string[]; none: string[] },
      ) => ({
        command,
        shortcut: {
          key,
          mod: false,
          meta: false,
          control: false,
          alt: true,
          shift,
        },
        when,
      });
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.command.startsWith("modelPicker.cycle"))
          .map((binding) => ({
            command: binding.command,
            shortcut: binding.shortcut,
            when: binding.when,
          })),
      ).toEqual([
        altChord("modelPicker.cycleModel", "m", false, composerWhen),
        altChord("modelPicker.cycleModelBackward", "m", true, composerWhen),
        altChord("modelPicker.cycleProvider", "p", false, composerWhen),
        altChord("modelPicker.cycleProviderBackward", "p", true, composerWhen),
        altChord("modelPicker.cycleReasoning", "t", false, composerWhen),
        altChord("modelPicker.cycleReasoningBackward", "t", true, composerWhen),
        altChord("modelPicker.cycleModel", "m", false, pickerOpenWhen),
        altChord("modelPicker.cycleModelBackward", "m", true, pickerOpenWhen),
        altChord("modelPicker.cycleProvider", "p", false, pickerOpenWhen),
        altChord(
          "modelPicker.cycleProviderBackward",
          "p",
          true,
          pickerOpenWhen,
        ),
        altChord("modelPicker.cycleReasoning", "t", false, pickerOpenWhen),
        altChord(
          "modelPicker.cycleReasoningBackward",
          "t",
          true,
          pickerOpenWhen,
        ),
      ]);
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.shortcut.alt)
          .map((binding) => ({
            command: binding.command,
            shift: binding.shortcut.shift,
          })),
      ).toEqual([
        { command: "modelPicker.cycleModel", shift: false },
        { command: "modelPicker.cycleModelBackward", shift: true },
        { command: "modelPicker.cycleProvider", shift: false },
        { command: "modelPicker.cycleProviderBackward", shift: true },
        { command: "modelPicker.cycleReasoning", shift: false },
        { command: "modelPicker.cycleReasoningBackward", shift: true },
        { command: "modelPicker.cycleModel", shift: false },
        { command: "modelPicker.cycleModelBackward", shift: true },
        { command: "modelPicker.cycleProvider", shift: false },
        { command: "modelPicker.cycleProviderBackward", shift: true },
        { command: "modelPicker.cycleReasoning", shift: false },
        { command: "modelPicker.cycleReasoningBackward", shift: true },
      ]);
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.command.startsWith("pane."))
          .map((binding) => ({
            command: binding.command,
            desktopOnly: binding.desktopOnly,
            key: binding.shortcut.key,
            mod: binding.shortcut.mod,
            control: binding.shortcut.control,
            shift: binding.shortcut.shift,
            when: binding.when,
          })),
      ).toEqual([
        ...PANE_FOCUS_APP_COMMAND_IDS.flatMap((command, index) => [
          {
            command,
            desktopOnly: false,
            key: String(index + 1),
            mod: false,
            control: true,
            shift: false,
            when: {
              all: ["mainSurface", "splitActive", "webSurface", "macPlatform"],
              none: ["modalOpen"],
            },
          },
          {
            command,
            desktopOnly: false,
            key: String(index + 1),
            mod: true,
            control: false,
            shift: true,
            when: {
              all: ["mainSurface", "splitActive", "webSurface"],
              none: ["modalOpen", "macPlatform"],
            },
          },
          {
            command,
            desktopOnly: true,
            key: String(index + 1),
            mod: true,
            control: false,
            shift: false,
            when: {
              all: ["mainSurface", "splitActive"],
              none: ["modalOpen"],
            },
          },
        ]),
        {
          command: "pane.maximize.toggle",
          desktopOnly: false,
          key: "e",
          mod: true,
          control: false,
          shift: true,
          when: { all: ["mainSurface", "splitActive"], none: ["modalOpen"] },
        },
        {
          command: "pane.close",
          desktopOnly: false,
          key: "x",
          mod: true,
          control: false,
          shift: true,
          when: { all: ["mainSurface", "splitActive"], none: ["modalOpen"] },
        },
      ]);
      expect(
        assignedDefaultKeybindings
          .filter((binding) => binding.desktopOnly)
          .map((binding) => binding.command),
      ).toEqual([
        "thread.new",
        "thread.previous",
        "thread.next",
        ...THREAD_JUMP_APP_COMMAND_IDS,
        ...PANE_FOCUS_APP_COMMAND_IDS,
        "panel.reopenClosedTab",
        "browser.focusLocation",
        "browser.reload",
        "browser.find",
        "window.new",
      ]);
    });
  });

  it("persists command overrides and resolves every scoped binding", async () => {
    await withTestHarness(async (harness) => {
      const shortcut = {
        key: "u",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      };
      const overrides = [
        { command: "thread.new" as const, shortcut },
        { command: "modelPicker.toggle" as const, shortcut },
      ];
      const response = await harness.app.request("/api/v1/settings/keyboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(overrides),
      });
      expect(response.status).toBe(200);
      expect(
        appKeybindingOverridesSchema.parse(await readJson(response)),
      ).toEqual(overrides);
      expect(getAppKeybindingOverrides(harness.db)).toEqual(overrides);

      const configResponse = await harness.app.request("/api/v1/system/config");
      const config = systemConfigResponseSchema.parse(
        await readJson(configResponse),
      );
      expect(config.keybindingOverrides).toEqual(overrides);
      expect(
        config.keybindings.find((binding) => binding.command === "thread.new"),
      ).toMatchObject({ shortcut });
      expect(
        config.keybindings.filter(
          (binding) => binding.command === "modelPicker.toggle",
        ),
      ).toHaveLength(2);
      expect(
        config.keybindings
          .filter((binding) => binding.command === "modelPicker.toggle")
          .every((binding) => binding.shortcut.key === "u"),
      ).toBe(true);
    });
  });

  it("activates an assignable command without a default shortcut", async () => {
    await withTestHarness(async (harness) => {
      const shortcut = {
        key: "r",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      };
      const response = await harness.app.request("/api/v1/settings/keyboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ command: "thread.rename", shortcut }]),
      });
      expect(response.status).toBe(200);

      const configResponse = await harness.app.request("/api/v1/system/config");
      const config = systemConfigResponseSchema.parse(
        await readJson(configResponse),
      );
      expect(
        config.keybindings.filter(
          (binding) => binding.command === "thread.rename",
        ),
      ).toEqual([
        {
          command: "thread.rename",
          desktopOnly: false,
          shortcut,
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ]);
    });
  });

  it("activates the archive command after assigning a shortcut", async () => {
    await withTestHarness(async (harness) => {
      const shortcut = {
        key: "a",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: true,
      };
      const response = await harness.app.request("/api/v1/settings/keyboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ command: "thread.archive", shortcut }]),
      });
      expect(response.status).toBe(200);

      const configResponse = await harness.app.request("/api/v1/system/config");
      const config = systemConfigResponseSchema.parse(
        await readJson(configResponse),
      );
      expect(
        config.keybindings.filter(
          (binding) => binding.command === "thread.archive",
        ),
      ).toEqual([
        {
          command: "thread.archive",
          desktopOnly: false,
          shortcut,
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ]);
    });
  });

  it("uses null overrides to disable a command", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/settings/keyboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ command: "panel.newTab", shortcut: null }]),
      });
      expect(response.status).toBe(200);

      const configResponse = await harness.app.request("/api/v1/system/config");
      const config = systemConfigResponseSchema.parse(
        await readJson(configResponse),
      );
      expect(
        config.keybindings.some(
          (binding) => binding.command === "panel.newTab",
        ),
      ).toBe(false);
      expect(
        config.defaultKeybindings.some(
          (binding) => binding.command === "panel.newTab",
        ),
      ).toBe(true);
    });
  });

  it("rejects duplicate command overrides", async () => {
    await withTestHarness(async (harness) => {
      const shortcut = {
        key: "n",
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      };
      const response = await harness.app.request("/api/v1/settings/keyboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { command: "thread.new", shortcut },
          { command: "thread.new", shortcut },
        ]),
      });
      expect(response.status).toBe(400);
    });
  });

  it("falls back to defaults when stored overrides are corrupt", async () => {
    await withTestHarness(async (harness) => {
      harness.db.$client
        .prepare(
          `INSERT INTO app_settings_values (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run("keybindingOverrides", "not-json", Date.now());

      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const config = systemConfigResponseSchema.parse(await readJson(response));
      expect(config.keybindingOverrides).toEqual([]);
      expect(config.keybindings).toEqual(
        applyAppKeybindingOverrides(config.defaultKeybindings, []),
      );
    });
  });
});
