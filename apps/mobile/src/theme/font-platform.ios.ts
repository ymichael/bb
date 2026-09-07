import type { FontWeightName, FontWeightValue } from "./fonts";

export const SANS_FAMILIES: Record<FontWeightName, string | undefined> = {
  regular: undefined,
  medium: undefined,
  semibold: undefined,
  bold: undefined,
};

export const SANS_WEIGHTS: Record<FontWeightName, FontWeightValue> = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
};

export const MONO_FAMILY: string = "Menlo";
