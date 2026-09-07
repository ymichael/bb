import type { FontWeightName, FontWeightValue } from "./fonts";

export const SANS_FAMILIES: Record<FontWeightName, string | undefined> = {
  regular: "sans-serif",
  medium: "sans-serif-medium",
  semibold: "sans-serif",
  bold: "sans-serif",
};

export const SANS_WEIGHTS: Record<FontWeightName, FontWeightValue> = {
  regular: "400",
  medium: "500",
  semibold: "700",
  bold: "700",
};

export const MONO_FAMILY: string = "monospace";
