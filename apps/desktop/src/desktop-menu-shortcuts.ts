import {
  type AppCommandId,
  type AppKeybindings,
  type AppShortcut,
} from "@bb/domain";

export interface ApplicationMenuAccelerators {
  closeWindowOrSideTab: string | undefined;
  createNewWindow: string | undefined;
  openNewTab: string | undefined;
  openNewThread: string | undefined;
  openSettings: string | undefined;
  reopenClosedTab: string | undefined;
}

export const DEFAULT_APPLICATION_MENU_ACCELERATORS: ApplicationMenuAccelerators =
  {
    closeWindowOrSideTab: "CommandOrControl+W",
    createNewWindow: "CommandOrControl+Shift+N",
    openNewTab: "CommandOrControl+T",
    openNewThread: "CommandOrControl+N",
    openSettings: "CommandOrControl+,",
    reopenClosedTab: "CommandOrControl+Shift+T",
  };

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Escape: "Esc",
  " ": "Space",
};

const ELECTRON_NAMED_KEYS = new Set([
  "Backspace",
  "Delete",
  "Down",
  "End",
  "Enter",
  "Esc",
  "Home",
  "Insert",
  "Left",
  "PageDown",
  "PageUp",
  "Right",
  "Space",
  "Tab",
  "Up",
]);

export function formatElectronAccelerator(
  shortcut: AppShortcut,
): string | undefined {
  const parts: string[] = [];
  if (shortcut.mod) parts.push("CommandOrControl");
  if (shortcut.control) parts.push("Control");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.meta) parts.push("Command");
  const rawKey = ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key;
  const key = rawKey === "+" ? "Plus" : rawKey;
  if (
    key.length !== 1 &&
    !/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(key) &&
    !ELECTRON_NAMED_KEYS.has(key)
  ) {
    return undefined;
  }
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

function acceleratorForCommand(
  keybindings: AppKeybindings,
  command: AppCommandId,
): string | undefined {
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (binding?.command === command) {
      return formatElectronAccelerator(binding.shortcut);
    }
  }
  return undefined;
}

export function resolveApplicationMenuAccelerators(
  keybindings: AppKeybindings,
): ApplicationMenuAccelerators {
  return {
    closeWindowOrSideTab: acceleratorForCommand(keybindings, "panel.close"),
    createNewWindow: acceleratorForCommand(keybindings, "window.new"),
    openNewTab: acceleratorForCommand(keybindings, "panel.newTab"),
    openNewThread: acceleratorForCommand(keybindings, "thread.new"),
    openSettings: acceleratorForCommand(keybindings, "settings.open"),
    reopenClosedTab: acceleratorForCommand(
      keybindings,
      "panel.reopenClosedTab",
    ),
  };
}
