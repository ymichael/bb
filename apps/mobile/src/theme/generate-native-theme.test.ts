import { readFileSync } from "node:fs";
import { BUILTIN_THEME_IDS } from "@bb/domain";
import { converter, parse } from "culori";
import { describe, expect, it } from "vitest";
import {
  buildNativeThemeModel,
  generateNativeThemeSource,
  NATIVE_THEME_OUTPUT_PATH,
  renderNativeThemeSource,
} from "../../scripts/generate-native-theme";
import {
  nativeRadii,
  nativeThemes,
  nativeTypography,
  type NativeThemeTokens,
} from "./theme.native";

const MODES = ["light", "dark"] as const;
const toOklch = converter("oklch");

const MINIMAL_MOBILE_CSS = `
  @theme { --radius-2xl: 16px; --radius-full: 9999px; }
`;
const MINIMAL_THEME_CSS = `
  :root, .light { --canvas: #fff; --ink: #000; --radius: 8px; }
  .dark { --canvas: #000; --ink: #fff; }
  @theme inline { --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px; }
`;
const emptyPalettes = (): Map<(typeof BUILTIN_THEME_IDS)[number], string> =>
  new Map(BUILTIN_THEME_IDS.map((id) => [id, ""]));

function lightness(color: string): number {
  const parsed = parse(color);
  if (!parsed) throw new Error(`not a color: ${color}`);
  return toOklch(parsed).l;
}

function alpha(color: string): number {
  const match = color.match(/^rgba\(\d+, \d+, \d+, ([\d.]+)\)$/);
  if (!match) throw new Error(`expected rgba(): ${color}`);
  return Number(match[1]);
}

function contrastFromCanvas(
  tokens: NativeThemeTokens,
  key: keyof NativeThemeTokens,
): number {
  return Math.abs(lightness(tokens[key]) - lightness(tokens.canvas));
}

describe("generate-native-theme", () => {
  it("matches the committed theme.native.ts (run theme:generate)", () => {
    expect(generateNativeThemeSource()).toBe(
      readFileSync(NATIVE_THEME_OUTPUT_PATH, "utf8"),
    );
  });

  it("emits every built-in palette in both modes with the default key set", () => {
    const defaultKeys = Object.keys(nativeThemes.default.light).sort();
    expect(defaultKeys.length).toBeGreaterThan(50);
    expect(defaultKeys).toContain("ansi0");
    expect(defaultKeys).toContain("ansiBgFg15");
    for (const id of BUILTIN_THEME_IDS) {
      for (const mode of MODES) {
        expect(
          Object.keys(nativeThemes[id][mode]).sort(),
          `${id}/${mode}`,
        ).toEqual(defaultKeys);
        for (const [key, value] of Object.entries(nativeThemes[id][mode])) {
          expect(value, `${id}/${mode}/${key}`).toMatch(
            /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, 0\.\d{1,3}\))$/,
          );
        }
      }
    }
  });

  it("re-tunes the default palette to the iOS system anchors and tint", () => {
    const { light, dark } = nativeThemes.default;
    expect(light.canvas).toBe("#ffffff");
    expect(light.background).toBe("#ffffff");
    expect(light.ink).toBe("#000000");
    expect(light.primary).toBe("#007aff");
    expect(light.primaryForeground).toBe("#ffffff");
    expect(light.destructive).toBe("#ff3b30");
    expect(dark.canvas).toBe("#000000");
    expect(dark.ink).toBe("#ffffff");
    expect(dark.primary).toBe("#0a84ff");
    expect(dark.primaryForeground).toBe("#ffffff");
    expect(dark.destructive).toBe("#ff453a");
    expect(lightness(light.ink)).toBeLessThan(0.5);
    expect(lightness(dark.canvas)).toBeLessThan(lightness(dark.ink));
  });

  it("lets palettes override the mobile layer's anchors and tint", () => {
    expect(nativeThemes.nord.light.primary).toBe("#5e81ac");
    expect(nativeThemes.nord.light.canvas).toBe("#eceff4");
    expect(nativeThemes.nord.dark.primary).toBe("#88c0d0");
    expect(nativeThemes.nord.dark.canvas).toBe("#2e3440");
    expect(nativeThemes.dracula.dark.ink).toBe("#f8f8f2");
  });

  for (const id of BUILTIN_THEME_IDS) {
    for (const mode of MODES) {
      describe(`${id} ${mode}`, () => {
        const tokens = nativeThemes[id][mode];

        it("keeps card and popover flush with the canvas", () => {
          expect(tokens.card).toBe(tokens.canvas);
          expect(tokens.popover).toBe(tokens.canvas);
          expect(tokens.background).toBe(tokens.canvas);
        });

        it("orders the ink ramp: sidebar < fills < border <= input", () => {
          const sidebar = contrastFromCanvas(tokens, "sidebar");
          const border = contrastFromCanvas(tokens, "border");
          for (const fill of ["secondary", "accent", "muted"] as const) {
            expect(sidebar).toBeLessThan(contrastFromCanvas(tokens, fill));
            expect(contrastFromCanvas(tokens, fill)).toBeLessThan(border);
          }
          expect(border).toBeLessThanOrEqual(
            contrastFromCanvas(tokens, "input"),
          );
        });

        it("makes the pressed fill stronger than hover, both translucent ink", () => {
          expect(alpha(tokens.stateActive)).toBeGreaterThan(
            alpha(tokens.stateHover),
          );
          const inkRgb = tokens.ink
            .match(/[0-9a-f]{2}/g)
            ?.map((part) => parseInt(part, 16));
          expect(
            tokens.stateHover.startsWith(`rgba(${inkRgb?.join(", ")}, `),
          ).toBe(true);
        });

        it("keeps one grouped surface flush with the canvas and lifts the other toward the ink", () => {
          const [flat, lifted] =
            mode === "light"
              ? [tokens.surfaceGroupedCell, tokens.surfaceGrouped]
              : [tokens.surfaceGrouped, tokens.surfaceGroupedCell];
          expect(flat).toBe(tokens.canvas);
          expect(lifted).not.toBe(tokens.canvas);
          const [low, high] = [
            lightness(tokens.canvas),
            lightness(tokens.ink),
          ].sort((a, b) => a - b);
          expect(lightness(lifted)).toBeGreaterThan(low);
          expect(lightness(lifted)).toBeLessThan(high);
        });
      });
    }
  }

  it("cascades theme.css → mobile overrides → palette", () => {
    const model = buildNativeThemeModel({
      themeCss: `
        :root, .light { --canvas: #fff; --ink: #333; --primary: #111111; --radius: 8px; }
        .dark { --canvas: #000; --ink: #ccc; --primary: #eeeeee; }
        @theme inline { --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px; }
      `,
      mobileCss: `
        :root, .light {
          --ink: #000;
          --primary: #007aff;
          --grouped: color-mix(in oklab, var(--ink) 4%, var(--canvas));
        }
        .dark { --ink: #fff; --primary: #0a84ff; --grouped: var(--canvas); }
        ${MINIMAL_MOBILE_CSS}
      `,
      paletteCss: new Map(
        BUILTIN_THEME_IDS.map((id) => [
          id,
          id === "nord"
            ? `:root, .light { --canvas: #eceff4; --ink: #2e3440; --primary: #5e81ac; }
               .dark { --canvas: #2e3440; --ink: #d8dee9; --primary: #88c0d0; }`
            : "",
        ]),
      ),
    });
    const base = model.themes.get("default");
    const nord = model.themes.get("nord");
    expect(base?.light.ink).toBe("#000000");
    expect(base?.light.primary).toBe("#007aff");
    expect(base?.dark.primary).toBe("#0a84ff");
    expect(base?.dark.ink).toBe("#ffffff");
    expect(nord?.light.primary).toBe("#5e81ac");
    expect(nord?.dark.primary).toBe("#88c0d0");
    expect(nord?.dark.grouped).toBe("#2e3440");
    expect(nord?.light.grouped).not.toBe(base?.light.grouped);
    expect(model.mobileOnlyTokens).toEqual(["grouped"]);
  });

  it("rejects a `:root` mobile override without a `.dark` twin", () => {
    expect(() =>
      buildNativeThemeModel({
        themeCss: MINIMAL_THEME_CSS,
        mobileCss: `:root, .light { --primary: #007aff; } ${MINIMAL_MOBILE_CSS}`,
        paletteCss: emptyPalettes(),
      }),
    ).toThrow(/sets --primary under `:root`/);
    const model = buildNativeThemeModel({
      themeCss: MINIMAL_THEME_CSS,
      mobileCss: `.dark { --ink: #cccccc; } ${MINIMAL_MOBILE_CSS}`,
      paletteCss: emptyPalettes(),
    });
    expect(model.themes.get("default")?.light.ink).toBe("#000000");
    expect(model.themes.get("default")?.dark.ink).toBe("#cccccc");
    expect(() =>
      buildNativeThemeModel({
        themeCss: MINIMAL_THEME_CSS,
        mobileCss: `.dark { --grouped: #111111; } ${MINIMAL_MOBILE_CSS}`,
        paletteCss: emptyPalettes(),
      }),
    ).toThrow(/one mode only: --grouped/);
  });

  it("resolves color-mix like Chrome: premultiplied alpha and carried hues", () => {
    const model = buildNativeThemeModel({
      themeCss: `
        :root, .light {
          color-scheme: light;
          --canvas: oklch(1 0 0);
          --ink: oklch(0.3211 0 0);
          --success: oklch(0.7 0.15 155);
          --hover: color-mix(in oklab, var(--ink) 5.9%, transparent);
          --border: color-mix(in oklch, var(--ink) 14%, var(--canvas));
          --success-foreground: color-mix(in oklch, var(--success) 45%, var(--ink));
          --scrim: color-mix(in oklab, var(--canvas) 92%, transparent);
          --radius: 0.5rem;
        }
        .dark {
          color-scheme: dark;
          --canvas: #2e3440;
          --ink: #eceff4;
          --success: #a3be8c;
          --hover: color-mix(in oklab, var(--ink) 13.8%, transparent);
          --border: color-mix(in oklch, var(--ink) 19.4%, var(--canvas));
          --success-foreground: color-mix(in oklch, var(--success) 45%, var(--ink));
          --scrim: color-mix(in oklab, var(--canvas) 92%, transparent);
        }
        @theme inline {
          --radius-sm: calc(var(--radius) - 4px);
          --radius-md: calc(var(--radius) - 2px);
          --radius-lg: var(--radius);
          --radius-xl: calc(var(--radius) + 4px);
        }
        @theme {
          --text-sm: 0.8125rem;
        }
        @media (max-width: 767px) and (pointer: coarse) {
          :root {
            --text-sm: 0.9375rem;
            --text-sm--line-height: 1.375rem;
          }
        }
      `,
      mobileCss: MINIMAL_MOBILE_CSS,
      paletteCss: emptyPalettes(),
    });
    const light = model.themes.get("default")?.light;
    const dark = model.themes.get("default")?.dark;
    expect(light?.hover).toBe("rgba(51, 51, 51, 0.059)");
    expect(light?.border).toBe("#dfdfdf");
    expect(light?.successForeground).toBe("#7a5a34");
    expect(light?.scrim).toBe("rgba(255, 255, 255, 0.92)");
    expect(dark?.border).toBe("#4f5460");
    expect(dark?.hover).toBe("rgba(236, 239, 244, 0.138)");
    expect(dark?.successForeground).toBe("#cbd9c0");
    expect(model.radii).toEqual({
      base: 8,
      sm: 4,
      md: 6,
      lg: 8,
      xl: 12,
      xl2: 16,
      full: 9999,
    });
    expect(model.typography).toEqual([
      ["sm", { fontSize: 15, lineHeight: 22 }],
    ]);
  });

  it("layers the mobile @theme type ramp over the web's touch scale", () => {
    const model = buildNativeThemeModel({
      themeCss: `
        ${MINIMAL_THEME_CSS}
        @theme { --text-sm: 0.8125rem; --text-sm--line-height: 1.25rem; }
        @media (max-width: 767px) and (pointer: coarse) {
          :root { --text-sm: 0.9375rem; --text-sm--line-height: 1.375rem; }
        }
      `,
      mobileCss: `
        @theme {
          --text-sm: 15px;
          --text-sm--line-height: 20px;
          --text-3xl: 34px;
          --text-3xl--line-height: 41px;
        }
        ${MINIMAL_MOBILE_CSS}
      `,
      paletteCss: emptyPalettes(),
    });
    expect(model.typography).toEqual([
      ["sm", { fontSize: 15, lineHeight: 20 }],
      ["3xl", { fontSize: 34, lineHeight: 41 }],
    ]);
  });

  it("rejects a token that only the dark block defines", () => {
    expect(() =>
      buildNativeThemeModel({
        themeCss: `
          :root, .light { --canvas: #fff; --ink: #000; --radius: 8px; }
          .dark { --canvas: #000; --ink: #fff; --only-dark: #123456; }
          @theme inline { --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px; }
        `,
        mobileCss: MINIMAL_MOBILE_CSS,
        paletteCss: emptyPalettes(),
      }),
    ).toThrow(/one mode only: --only-dark/);
  });

  it("rejects a palette that sets a token theme.css does not define", () => {
    expect(() =>
      buildNativeThemeModel({
        themeCss: MINIMAL_THEME_CSS,
        mobileCss: MINIMAL_MOBILE_CSS,
        paletteCss: new Map(
          BUILTIN_THEME_IDS.map((id) => [
            id,
            id === "nord" ? ":root, .light { --primary-fg: #fff; }" : "",
          ]),
        ),
      }),
    ).toThrow(/Palette "nord" declares --primary-fg/);
  });

  it("emits Oxfmt-stable, sorted output", () => {
    const source = renderNativeThemeSource(buildNativeThemeModel());
    const keys = [...source.matchAll(/^  ([A-Za-z0-9]+): string;$/gm)].map(
      (match) => match[1],
    );
    expect(keys).toEqual([...keys].sort());
    expect(
      source.startsWith(
        "/**\n * GENERATED FILE — run pnpm --filter @bb/mobile theme:generate",
      ),
    ).toBe(true);
    expect(source.endsWith("\n")).toBe(true);
  });

  it("exposes the Apple text-style ramp and the web radii plus 2xl/full", () => {
    expect(nativeTypography).toEqual({
      "2xs": { fontSize: 11, lineHeight: 13 },
      xs: { fontSize: 13, lineHeight: 18 },
      sm: { fontSize: 15, lineHeight: 20 },
      base: { fontSize: 17, lineHeight: 22 },
      lg: { fontSize: 20, lineHeight: 25 },
      xl: { fontSize: 22, lineHeight: 28 },
      "2xl": { fontSize: 28, lineHeight: 34 },
      "3xl": { fontSize: 34, lineHeight: 41 },
    });
    expect(nativeRadii).toEqual({
      base: 8,
      sm: 4,
      md: 6,
      lg: 8,
      xl: 12,
      xl2: 16,
      full: 9999,
    });
  });
});
