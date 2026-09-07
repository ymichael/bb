import {
  isBuiltInThemeId,
  type AppTheme,
  type BuiltInThemeId,
} from "@bb/domain";
import { catppuccinThemeCss } from "./catppuccin";
import { draculaThemeCss } from "./dracula";
import { gruvboxThemeCss } from "./gruvbox";
import { nordThemeCss } from "./nord";
import { solarizedThemeCss } from "./solarized";

const APP_THEME_STYLE_ELEMENT_ID = "bb-app-theme";
export const APP_THEME_CSS_STORAGE_KEY = "bb.appThemeCss";

const builtInThemeCss: Record<BuiltInThemeId, string> = {
  default: "",
  nord: nordThemeCss,
  dracula: draculaThemeCss,
  solarized: solarizedThemeCss,
  gruvbox: gruvboxThemeCss,
  catppuccin: catppuccinThemeCss,
};

export function resolveAppThemeCss(appearance: AppTheme): string {
  if (isBuiltInThemeId(appearance.themeId)) {
    return builtInThemeCss[appearance.themeId];
  }
  return appearance.customCss ?? "";
}

function getOrCreateStyleElement(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(APP_THEME_STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = document.createElement("style");
  style.id = APP_THEME_STYLE_ELEMENT_ID;
  document.head.appendChild(style);
  return style;
}

let appThemeEpoch = 0;
const appThemeSubscribers = new Set<() => void>();

export function subscribeAppThemeChange(callback: () => void): () => void {
  appThemeSubscribers.add(callback);
  return () => {
    appThemeSubscribers.delete(callback);
  };
}

export function getAppThemeEpoch(): number {
  return appThemeEpoch;
}

export function applyAppThemeCss(css: string): void {
  const style = getOrCreateStyleElement();
  if (!style) return;
  if (style.textContent !== css) {
    style.textContent = css;
    appThemeEpoch += 1;
    appThemeSubscribers.forEach((callback) => callback());
  }
  try {
    if (css) localStorage.setItem(APP_THEME_CSS_STORAGE_KEY, css);
    else localStorage.removeItem(APP_THEME_CSS_STORAGE_KEY);
  } catch {}
}

export function applyCachedAppThemeCss(): void {
  if (typeof document === "undefined") return;
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(APP_THEME_CSS_STORAGE_KEY);
  } catch {
    cached = null;
  }
  if (!cached) return;
  const style = getOrCreateStyleElement();
  if (style && style !== document.head.lastElementChild) {
    document.head.appendChild(style);
  }
  applyAppThemeCss(cached);
}
