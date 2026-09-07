import { describe, expect, it } from "vitest";
import * as defaultPlatform from "./font-platform";
import * as iosPlatform from "./font-platform.ios";
import {
  FONT_FAMILIES,
  FONT_WEIGHT_VALUES,
  type FontWeightName,
  resolveFont,
  resolveItalicFont,
} from "./fonts";

const WEIGHTS: readonly FontWeightName[] = [
  "regular",
  "medium",
  "semibold",
  "bold",
];

describe("font platform modules", () => {
  it("export the same names so Metro's .ios pick cannot drift from the default", () => {
    expect(Object.keys(iosPlatform).sort()).toEqual(
      Object.keys(defaultPlatform).sort(),
    );
    for (const weight of WEIGHTS) {
      expect(typeof iosPlatform.SANS_WEIGHTS[weight]).toBe("string");
      expect(typeof defaultPlatform.SANS_WEIGHTS[weight]).toBe("string");
    }
  });

  it("default (Android / node) names a real medium family and sends semibold as bold", () => {
    expect(defaultPlatform.SANS_FAMILIES).toEqual({
      regular: "sans-serif",
      medium: "sans-serif-medium",
      semibold: "sans-serif",
      bold: "sans-serif",
    });
    expect(defaultPlatform.SANS_WEIGHTS).toEqual({
      regular: "400",
      medium: "500",
      semibold: "700",
      bold: "700",
    });
    expect(defaultPlatform.MONO_FAMILY).toBe("monospace");
  });

  it("iOS leaves sans unset for the system font with exact weights, and uses Menlo for mono", () => {
    for (const weight of WEIGHTS) {
      expect(iosPlatform.SANS_FAMILIES[weight]).toBeUndefined();
    }
    expect(iosPlatform.SANS_WEIGHTS).toEqual({
      regular: "400",
      medium: "500",
      semibold: "600",
      bold: "700",
    });
    expect(iosPlatform.MONO_FAMILY).toBe("Menlo");
  });

  it("derives the font tables from the platform module", () => {
    for (const weight of WEIGHTS) {
      expect(FONT_FAMILIES.sans[weight]).toBe(
        defaultPlatform.SANS_FAMILIES[weight],
      );
      expect(FONT_FAMILIES.mono[weight]).toBe(defaultPlatform.MONO_FAMILY);
      expect(FONT_WEIGHT_VALUES[weight]).toBe(
        defaultPlatform.SANS_WEIGHTS[weight],
      );
    }
  });
});

describe("resolveFont", () => {
  it("defaults to the regular sans face with no italic", () => {
    const font = resolveFont({});
    expect(font).toEqual({
      fontFamily: FONT_FAMILIES.sans.regular,
      fontWeight: "400",
    });
    expect(font).not.toHaveProperty("fontStyle");
  });

  it("always carries the fontFamily key so it overrides a class family", () => {
    expect(Object.keys(resolveFont({}))).toContain("fontFamily");
  });

  it("derives weight and family from web-style utility classes", () => {
    expect(resolveFont({ className: "text-sm font-medium" })).toEqual({
      fontFamily: FONT_FAMILIES.sans.medium,
      fontWeight: "500",
    });
    expect(
      resolveFont({ className: "font-mono text-xs font-semibold" }),
    ).toEqual({
      fontFamily: FONT_FAMILIES.mono.semibold,
      fontWeight: FONT_WEIGHT_VALUES.semibold,
    });
    expect(resolveFont({ className: "font-bold" }).fontWeight).toBe("700");
  });

  it("mono always resolves to a concrete family name", () => {
    for (const weight of WEIGHTS) {
      expect(typeof resolveFont({ mono: true, weight }).fontFamily).toBe(
        "string",
      );
    }
  });

  it("does not match class prefixes loosely", () => {
    expect(resolveFont({ className: "font-mono-medium" })).toEqual({
      fontFamily: FONT_FAMILIES.sans.regular,
      fontWeight: "400",
    });
    expect(resolveFont({ className: "font-boldish" }).fontWeight).toBe("400");
  });

  it("lets explicit props override classes", () => {
    expect(
      resolveFont({
        className: "font-mono font-bold",
        weight: "regular",
        mono: false,
      }),
    ).toEqual({ fontFamily: FONT_FAMILIES.sans.regular, fontWeight: "400" });
    expect(resolveFont({ className: "font-sans", mono: true }).fontFamily).toBe(
      FONT_FAMILIES.mono.regular,
    );
  });

  it("prefers the heaviest weight when a merged class string carries several", () => {
    expect(resolveFont({ className: "font-medium font-bold" }).fontWeight).toBe(
      "700",
    );
  });
});

describe("resolveItalicFont", () => {
  it("keeps the sans family and exact weight and adds fontStyle italic", () => {
    for (const weight of WEIGHTS) {
      const font = resolveItalicFont(weight);
      expect(font.fontFamily).toBe(FONT_FAMILIES.sans[weight]);
      expect(font.fontStyle).toBe("italic");
      expect(font.fontWeight).toBe(resolveFont({ weight }).fontWeight);
    }
  });

  it("never switches to the mono family", () => {
    expect(resolveItalicFont("semibold").fontFamily).not.toBe(
      FONT_FAMILIES.mono.semibold,
    );
  });
});
