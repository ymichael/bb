import { z } from "zod";

export const THREAD_JUMP_APP_COMMAND_IDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const;

export const QUESTION_SELECT_APP_COMMAND_IDS = [
  "question.select.1",
  "question.select.2",
  "question.select.3",
  "question.select.4",
  "question.select.5",
  "question.select.6",
  "question.select.7",
  "question.select.8",
  "question.select.9",
] as const;

export const PANE_FOCUS_APP_COMMAND_IDS = [
  "pane.focus.1",
  "pane.focus.2",
  "pane.focus.3",
  "pane.focus.4",
  "pane.focus.5",
  "pane.focus.6",
  "pane.focus.7",
  "pane.focus.8",
] as const;

export const APP_COMMAND_IDS = [
  "palette.open",
  "thread.new",
  "thread.search",
  "thread.rename",
  "thread.archive",
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_APP_COMMAND_IDS,
  "pane.focus.previous",
  "pane.focus.next",
  ...PANE_FOCUS_APP_COMMAND_IDS,
  "pane.maximize.toggle",
  "pane.close",
  "window.new",
  "app.back",
  "settings.open",
  "settings.openServers",
  "sidebar.toggle",
  "panel.newTab",
  "panel.reopenClosedTab",
  "panel.close",
  "panel.toggle",
  "file.quickOpen",
  "diff.toggle",
  "terminal.open",
  "composer.focus",
  "modelPicker.toggle",
  "modelPicker.cycleModel",
  "modelPicker.cycleModelBackward",
  "modelPicker.cycleProvider",
  "modelPicker.cycleProviderBackward",
  "modelPicker.cycleReasoning",
  "modelPicker.cycleReasoningBackward",
  "browser.focusLocation",
  "browser.reload",
  "browser.find",
  "workspace.openPreferred",
  "logs.openServerDaemon",
  "notifications.open",
  ...QUESTION_SELECT_APP_COMMAND_IDS,
] as const;

export const appCommandIdSchema = z.enum(APP_COMMAND_IDS);
export type AppCommandId = z.infer<typeof appCommandIdSchema>;

const APP_COMMAND_CONTEXT_KEYS = [
  "mainSurface",
  "modalOpen",
  "editableFocus",
  "terminalFocus",
  "browserFocus",
  "modelPickerOpen",
  "questionOpen",
  "promptAvailable",
  "splitActive",
  "webSurface",
  "macPlatform",
] as const;

const appCommandContextKeySchema = z.enum(APP_COMMAND_CONTEXT_KEYS);
export type AppCommandContextKey = z.infer<typeof appCommandContextKeySchema>;
export type AppCommandContext = Record<AppCommandContextKey, boolean>;

export const appShortcutSchema = z
  .object({
    key: z.string().min(1).max(32),
    mod: z.boolean(),
    meta: z.boolean(),
    control: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
  })
  .strict();
export type AppShortcut = z.infer<typeof appShortcutSchema>;

export interface AppShortcutInput {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

const SHIFTED_KEY_BASES: Readonly<Record<string, string>> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

function baseKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  return null;
}

function isAsciiAlphanumeric(value: string): boolean {
  return /^[a-z0-9]$/iu.test(value);
}

export function normalizeAppShortcutInputKey(input: AppShortcutInput): string {
  if (input.key === " " || input.key === "Spacebar") {
    return "Space";
  }
  if (input.altKey && !isAsciiAlphanumeric(input.key)) {
    const fromCode = baseKeyFromCode(input.code);
    if (fromCode !== null) return fromCode;
  }
  return input.shiftKey
    ? (SHIFTED_KEY_BASES[input.key] ?? input.key)
    : input.key;
}

export function isMacKeyboardPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/u.test(platform);
}

export function matchesAppShortcut(
  input: AppShortcutInput,
  shortcut: AppShortcut,
  useMetaForMod: boolean,
): boolean {
  const expectedMeta = shortcut.meta || (shortcut.mod && useMetaForMod);
  const expectedControl = shortcut.control || (shortcut.mod && !useMetaForMod);
  return (
    normalizeAppShortcutInputKey(input).toLowerCase() ===
      shortcut.key.toLowerCase() &&
    input.metaKey === expectedMeta &&
    input.ctrlKey === expectedControl &&
    input.altKey === shortcut.alt &&
    input.shiftKey === shortcut.shift
  );
}

const appCommandWhenSchema = z
  .object({
    all: z.array(appCommandContextKeySchema),
    none: z.array(appCommandContextKeySchema),
  })
  .strict();

export const appKeybindingSchema = z
  .object({
    command: appCommandIdSchema,
    desktopOnly: z.boolean(),
    shortcut: appShortcutSchema,
    when: appCommandWhenSchema,
  })
  .strict();
export type AppKeybinding = z.infer<typeof appKeybindingSchema>;

const appDefaultKeybindingSchema = appKeybindingSchema.extend({
  shortcut: appShortcutSchema.nullable(),
});
export type AppDefaultKeybinding = z.infer<typeof appDefaultKeybindingSchema>;

export function isAppKeybindingAvailableForClient(
  binding: AppKeybinding | AppDefaultKeybinding,
  client: { isDesktop: boolean; isMac: boolean },
): boolean {
  if (binding.desktopOnly && !client.isDesktop) return false;
  if (binding.when.all.includes("webSurface") && client.isDesktop) return false;
  if (binding.when.none.includes("webSurface") && !client.isDesktop)
    return false;
  if (binding.when.all.includes("macPlatform") && !client.isMac) return false;
  if (binding.when.none.includes("macPlatform") && client.isMac) return false;
  return true;
}

export const appKeybindingsSchema = z.array(appKeybindingSchema).max(256);
export type AppKeybindings = z.infer<typeof appKeybindingsSchema>;

export const appDefaultKeybindingsSchema = z
  .array(appDefaultKeybindingSchema)
  .max(256);
export type AppDefaultKeybindings = z.infer<typeof appDefaultKeybindingsSchema>;

const appKeybindingOverrideSchema = z
  .object({
    command: appCommandIdSchema,
    shortcut: appShortcutSchema.nullable(),
  })
  .strict();

export const appKeybindingOverridesSchema = z
  .array(appKeybindingOverrideSchema)
  .max(APP_COMMAND_IDS.length)
  .superRefine((overrides, context) => {
    const seen = new Set<AppCommandId>();
    for (const [index, override] of overrides.entries()) {
      if (seen.has(override.command)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate override for ${override.command}`,
          path: [index, "command"],
        });
      }
      seen.add(override.command);
    }
  });
export type AppKeybindingOverrides = z.infer<
  typeof appKeybindingOverridesSchema
>;

export function applyAppKeybindingOverrides(
  defaults: AppDefaultKeybindings,
  overrides: AppKeybindingOverrides,
): AppKeybindings {
  return defaults.flatMap((binding) => {
    const override = overrides.find(
      (candidate) => candidate.command === binding.command,
    );
    const shortcut =
      override === undefined ? binding.shortcut : override.shortcut;
    return shortcut === null ? [] : [{ ...binding, shortcut }];
  });
}
