import type * as MonacoNs from "monaco-editor";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";

const TOKEN_COLOR = /^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/;
const WORKBENCH_COLOR = /^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export function monacoThemeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9-]/g, "-");
  return `bb-${safe}`;
}

function tokenColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hex = value.startsWith("#") ? value.slice(1) : value;
  const expanded =
    hex.length === 3 || hex.length === 4
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  return TOKEN_COLOR.test(expanded) ? expanded : undefined;
}

function tokenRules(
  theme: PluginCodeThemeData,
): MonacoNs.editor.ITokenThemeRule[] {
  const rules: MonacoNs.editor.ITokenThemeRule[] = [];
  const base = tokenColor(theme.fg);
  if (base !== undefined) rules.push({ token: "", foreground: base });
  for (const rule of theme.tokenColors) {
    const foreground = tokenColor(rule.settings.foreground);
    const background = tokenColor(rule.settings.background);
    const fontStyle = fontStyleFor(rule.settings.fontStyle);
    if (
      foreground === undefined &&
      background === undefined &&
      fontStyle === undefined
    ) {
      continue;
    }
    const scopes =
      rule.scope === undefined
        ? [""]
        : typeof rule.scope === "string"
          ? rule.scope.split(",")
          : rule.scope;
    for (const scope of scopes) {
      const token = scope.trim();
      if (rule.scope !== undefined && token === "") continue;
      rules.push({
        token,
        ...(foreground === undefined ? {} : { foreground }),
        ...(background === undefined ? {} : { background }),
        ...(fontStyle === undefined ? {} : { fontStyle }),
      });
    }
  }
  return rules;
}

function fontStyleFor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const styles = value
    .split(/\s+/)
    .filter(
      (style) =>
        style === "italic" || style === "bold" || style === "underline",
    );
  return styles.join(" ");
}

function workbenchColors(theme: PluginCodeThemeData): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [id, value] of Object.entries(theme.colors)) {
    if (typeof value === "string" && WORKBENCH_COLOR.test(value)) {
      colors[id] = value;
    }
  }
  if (
    colors["editor.background"] === undefined &&
    WORKBENCH_COLOR.test(theme.bg)
  ) {
    colors["editor.background"] = theme.bg;
  }
  if (
    colors["editor.foreground"] === undefined &&
    WORKBENCH_COLOR.test(theme.fg)
  ) {
    colors["editor.foreground"] = theme.fg;
  }
  return colors;
}

export function editorBackground(
  theme: PluginCodeThemeData | null,
): string | null {
  if (theme === null) return null;
  return workbenchColors(theme)["editor.background"] ?? null;
}

export function toMonacoTheme(
  theme: PluginCodeThemeData,
): MonacoNs.editor.IStandaloneThemeData {
  return {
    base: theme.type === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: tokenRules(theme),
    colors: workbenchColors(theme),
  };
}

export function defineMonacoTheme(
  monaco: typeof MonacoNs,
  theme: PluginCodeThemeData,
): string {
  const name = monacoThemeName(theme.name);
  monaco.editor.defineTheme(name, toMonacoTheme(theme));
  return name;
}

export interface AppliedMonacoTheme {
  name: string;
  base: "vs" | "vs-dark";
}

export function applyCodeTheme(
  monaco: typeof MonacoNs,
  state: { mode: "light" | "dark"; theme: PluginCodeThemeData | null },
): AppliedMonacoTheme {
  if (state.theme === null) {
    const base = state.mode === "dark" ? "vs-dark" : "vs";
    return { name: base, base };
  }
  return {
    name: defineMonacoTheme(monaco, state.theme),
    base: state.theme.type === "light" ? "vs" : "vs-dark",
  };
}
