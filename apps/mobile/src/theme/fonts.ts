import { MONO_FAMILY, SANS_FAMILIES, SANS_WEIGHTS } from "./font-platform";

export type FontFamilyKind = "sans" | "mono";
export type FontWeightName = "regular" | "medium" | "semibold" | "bold";
export type FontWeightValue = "400" | "500" | "600" | "700";

export interface FontFamilies {
  sans: Record<FontWeightName, string | undefined>;
  mono: Record<FontWeightName, string>;
}

export const FONT_FAMILIES: FontFamilies = {
  sans: SANS_FAMILIES,
  mono: {
    regular: MONO_FAMILY,
    medium: MONO_FAMILY,
    semibold: MONO_FAMILY,
    bold: MONO_FAMILY,
  },
};

export const FONT_WEIGHT_VALUES: Record<FontWeightName, FontWeightValue> =
  SANS_WEIGHTS;

const CLASS_WEIGHTS: readonly { token: string; weight: FontWeightName }[] = [
  { token: "font-bold", weight: "bold" },
  { token: "font-semibold", weight: "semibold" },
  { token: "font-medium", weight: "medium" },
  { token: "font-normal", weight: "regular" },
];

export interface ResolvedFont {
  fontFamily?: string;
  fontWeight: FontWeightValue;
  fontStyle?: "italic";
}

export function resolveItalicFont(weight: FontWeightName): ResolvedFont {
  return {
    fontFamily: FONT_FAMILIES.sans[weight],
    fontWeight: FONT_WEIGHT_VALUES[weight],
    fontStyle: "italic",
  };
}

export function resolveFont(options: {
  className?: string;
  weight?: FontWeightName;
  mono?: boolean;
}): ResolvedFont {
  const tokens = options.className ? options.className.split(/\s+/) : [];
  const has = (token: string) => tokens.includes(token);
  const mono = options.mono ?? (has("font-mono") && !has("font-sans"));
  const kind: FontFamilyKind = mono ? "mono" : "sans";
  const weight =
    options.weight ??
    CLASS_WEIGHTS.find((entry) => has(entry.token))?.weight ??
    "regular";
  return {
    fontFamily: FONT_FAMILIES[kind][weight],
    fontWeight: FONT_WEIGHT_VALUES[weight],
  };
}
