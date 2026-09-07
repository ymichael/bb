import { describe, expect, it } from "vitest";
import { fastServiceTierLabel, reasoningLevelLabel } from "./reasoning-labels";
import { getProviderIconTintStyle } from "./provider-icon";

describe("declared provider labels", () => {
  const declared = {
    reasoningLevels: [
      { id: "low", label: "Quick" },
      { id: "high", label: "Deep", description: "Slow but thorough." },
    ],
    serviceTiers: [
      { id: "default", label: "Standard" },
      { id: "fast", label: "Priority" },
    ],
    strings: {
      signInHint: "x",
      expiredHint: "y",
      installUrl: "https://example.test",
      iconTint: { light: "#111827", dark: "#F5F5F5" },
    },
  };

  it("labels a reasoning level from the declaration, else the fallback table", () => {
    expect(reasoningLevelLabel("low", declared)).toBe("Quick");
    expect(reasoningLevelLabel("high", declared)).toBe("Deep");
    expect(reasoningLevelLabel("xhigh", declared)).toBe("Extra High");
    expect(reasoningLevelLabel("xhigh", undefined)).toBe("Extra High");
  });

  it("labels the fast tier from the declaration, else 'Fast'", () => {
    expect(fastServiceTierLabel(declared)).toBe("Priority");
    expect(fastServiceTierLabel({ serviceTiers: undefined })).toBe("Fast");
    expect(fastServiceTierLabel(undefined)).toBe("Fast");
  });

  it("paints the declared icon tint per theme and refuses non-colour values", () => {
    expect(getProviderIconTintStyle(declared)).toEqual({
      color: "light-dark(#111827, #F5F5F5)",
    });
    expect(getProviderIconTintStyle({ strings: undefined })).toBeUndefined();
    expect(
      getProviderIconTintStyle({
        strings: {
          ...declared.strings,
          iconTint: { light: "url(evil)", dark: "#fff" },
        },
      }),
    ).toBeUndefined();
  });
});
