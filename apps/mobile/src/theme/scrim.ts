import type { ThemeMode } from "./theme-preference";
import type { NativeThemeTokens } from "./theme.native";

export function scrimBaseColor(
  mode: ThemeMode,
  tokens: Pick<NativeThemeTokens, "ink">,
): string {
  return mode === "dark" ? "#000000" : tokens.ink;
}
