import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildThemeVars, tokenKeyToCssVar } from "./theme-vars";
import { nativeRadii, nativeThemes, nativeTypography } from "./theme.native";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = join(HERE, "..", "..");
const GLOBAL_CSS = readFileSync(join(MOBILE_ROOT, "global.css"), "utf8");
const WEB_THEME_CSS = readFileSync(
  join(MOBILE_ROOT, "..", "app", "src", "components", "ui", "theme.css"),
  "utf8",
);
const MOBILE_OVERRIDES_CSS = readFileSync(
  join(HERE, "mobile-overrides.css"),
  "utf8",
);

const MOBILE_ONLY_TOKENS = new Set(["surface-grouped", "surface-grouped-cell"]);

const MOBILE_ONLY_COLOR_UTILITIES = new Set([
  "canvas",
  "ink",
  "pill-foreground",
  "pill-icon",
  "pill-surface-border",
  "pill-surface-selected-border",
  "sidebar-search-match",
  "sidebar-search-match-border",
  "shadow-color",
  "surface-grouped",
  "surface-grouped-cell",
]);

function colorMappings(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of css.matchAll(/@theme inline\s*\{([\s\S]*?)\n\}/g)) {
    for (const match of block[1].matchAll(
      /--color-([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g,
    )) {
      map.set(match[1], match[2]);
    }
  }
  return map;
}

function declaredVars(css: string): Set<string> {
  return new Set(
    Array.from(css.matchAll(/^\s*--([a-z0-9-]+):/gm), (match) => match[1]),
  );
}

describe("theme vars", () => {
  const tokens = nativeThemes.default.light;

  it("maps every generated token key to a theme.css property or a documented mobile-only one", () => {
    const webVars = declaredVars(WEB_THEME_CSS);
    const mobileVars = declaredVars(MOBILE_OVERRIDES_CSS);
    for (const name of MOBILE_ONLY_TOKENS) {
      expect(mobileVars.has(name), `--${name} in mobile-overrides.css`).toBe(
        true,
      );
      expect(
        webVars.has(name),
        `--${name} is now in theme.css; drop it from MOBILE_ONLY_TOKENS`,
      ).toBe(false);
    }
    const generatedMobileOnly = Object.keys(tokens)
      .map((key) => tokenKeyToCssVar(key).slice(2))
      .filter((name) => !webVars.has(name))
      .sort();
    expect(generatedMobileOnly).toEqual([...MOBILE_ONLY_TOKENS].sort());
  });

  it("handles the digit-bearing ansi names", () => {
    expect(tokenKeyToCssVar("ansi0")).toBe("--ansi-0");
    expect(tokenKeyToCssVar("ansi15")).toBe("--ansi-15");
    expect(tokenKeyToCssVar("ansiBgFg10")).toBe("--ansi-bg-fg-10");
    expect(tokenKeyToCssVar("surfaceRecessedSoftSolid")).toBe(
      "--surface-recessed-soft-solid",
    );
  });

  it("builds one variable per token with the token's color", () => {
    const vars = buildThemeVars(tokens);
    expect(Object.keys(vars)).toHaveLength(Object.keys(tokens).length);
    expect(vars["--background"]).toBe(tokens.background);
    expect(vars["--sidebar-accent-foreground"]).toBe(
      tokens.sidebarAccentForeground,
    );
  });

  it("global.css exposes every web --color-* utility and only tokens the provider supplies", () => {
    const web = colorMappings(WEB_THEME_CSS);
    const mobile = colorMappings(GLOBAL_CSS);
    expect(web.size).toBeGreaterThan(40);
    const supplied = new Set(Object.keys(buildThemeVars(tokens)));
    for (const [utility, cssVar] of web) {
      expect(mobile.get(utility), `--color-${utility}`).toBe(cssVar);
    }
    for (const [utility, cssVar] of mobile) {
      expect(
        supplied.has(`--${cssVar}`),
        `--color-${utility} → --${cssVar}`,
      ).toBe(true);
    }
    const extra = [...mobile.keys()].filter((utility) => !web.has(utility));
    expect(extra.sort()).toEqual([...MOBILE_ONLY_COLOR_UTILITIES].sort());
  });

  it("global.css radii and type scale match the generated native values", () => {
    const px = (name: string): number => {
      const match = GLOBAL_CSS.match(new RegExp(`--${name}:\\s*(\\d+)px`));
      if (!match) throw new Error(`global.css lacks --${name}`);
      return Number(match[1]);
    };
    expect(px("radius-sm")).toBe(nativeRadii.sm);
    expect(px("radius-md")).toBe(nativeRadii.md);
    expect(px("radius-lg")).toBe(nativeRadii.lg);
    expect(px("radius-xl")).toBe(nativeRadii.xl);
    expect(px("radius-2xl")).toBe(nativeRadii.xl2);
    expect(px("radius-full")).toBe(nativeRadii.full);
    const ratio = (name: string): { lineHeight: number; fontSize: number } => {
      const match = GLOBAL_CSS.match(
        new RegExp(`--${name}:\\s*calc\\((\\d+)\\s*/\\s*(\\d+)\\)`),
      );
      if (!match) throw new Error(`global.css lacks a ratio for --${name}`);
      return { lineHeight: Number(match[1]), fontSize: Number(match[2]) };
    };
    for (const [size, style] of Object.entries(nativeTypography)) {
      expect(px(`text-${size}`), size).toBe(style.fontSize);
      expect(ratio(`text-${size}--line-height`), size).toEqual({
        lineHeight: style.lineHeight,
        fontSize: style.fontSize,
      });
    }
  });
});
