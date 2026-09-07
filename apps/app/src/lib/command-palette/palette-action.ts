import type { AppShortcutPresentation } from "@/lib/app-keybindings";

export interface PaletteAction {
  id: string;
  group: string;
  title: string;
  shortcut: AppShortcutPresentation | null;
  run: () => void;
}
