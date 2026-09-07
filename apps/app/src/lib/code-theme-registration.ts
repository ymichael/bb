import type { registerCustomTheme } from "@pierre/diffs";
import { stampRegisteredThemeName } from "@bb/domain";
import { getResolvedCodeTheme } from "@/lib/code-theme";

const registeredFileNames = new Set<string>();

export function registerResolvedCodeThemeFiles(
  register: typeof registerCustomTheme,
): void {
  const resolved = getResolvedCodeTheme();
  for (const [name, theme] of Object.entries(resolved.files)) {
    if (registeredFileNames.has(name)) continue;
    registeredFileNames.add(name);
    const stamped = stampRegisteredThemeName(name, theme);
    register(name, () => Promise.resolve(stamped));
  }
}
