import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CUSTOM_THEME_CSS_MAX_LENGTH,
  customThemeNameSchema,
  defaultAppTheme,
  isBuiltInThemeId,
  resolveCodeTheme,
  type AppTheme,
  type DeclaredCodeTheme,
  type FaviconColorPreference,
} from "@bb/domain";
import { readCustomThemeCodeTheme } from "./code-themes.js";

const THEME_DIR_NAME = "theme";
const THEME_CSS_FILE_NAME = "theme.css";

export function resolveThemeRootPath(dataDir: string): string {
  return join(dataDir, THEME_DIR_NAME);
}

export function resolveCustomThemeCssPath(
  themeRoot: string,
  name: string,
): string {
  return join(themeRoot, name, THEME_CSS_FILE_NAME);
}

export function listCustomThemeNames(themeRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(themeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => customThemeNameSchema.safeParse(name).success)
    .filter((name) => existsSync(resolveCustomThemeCssPath(themeRoot, name)))
    .sort((a, b) => a.localeCompare(b));
}

export function readCustomThemeCss(
  themeRoot: string,
  name: string,
): string | null {
  if (!customThemeNameSchema.safeParse(name).success) return null;
  let css: string;
  try {
    css = readFileSync(resolveCustomThemeCssPath(themeRoot, name), "utf8");
  } catch {
    return null;
  }
  if (css.length > CUSTOM_THEME_CSS_MAX_LENGTH) return null;
  return css;
}

export function resolveAppTheme(
  themeRoot: string,
  themeId: string,
  faviconColor: FaviconColorPreference,
  declaredCodeTheme?: DeclaredCodeTheme | null,
): AppTheme {
  const declared =
    declaredCodeTheme !== undefined
      ? declaredCodeTheme
      : isBuiltInThemeId(themeId)
        ? null
        : readCustomThemeCodeTheme(themeRoot, themeId);
  const resolvedCodeTheme = resolveCodeTheme(declared, themeId);
  if (isBuiltInThemeId(themeId)) {
    return {
      themeId,
      customCss: null,
      faviconColor,
      resolvedCodeTheme,
    };
  }
  const customCss = readCustomThemeCss(themeRoot, themeId);
  if (customCss === null) {
    return {
      ...defaultAppTheme,
      faviconColor,
      resolvedCodeTheme: resolveCodeTheme(null, "default"),
    };
  }
  return { themeId, customCss, faviconColor, resolvedCodeTheme };
}
