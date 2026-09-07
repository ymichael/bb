import { describe, expect, it } from "vitest";
import { blendOver } from "@/theme/colors";
import { scrimBaseColor } from "./scrim";
import { nativeThemes } from "./theme.native";

function luminance(color: string): number {
  const match = /^rgb\((\d+), (\d+), (\d+)\)$/u.exec(color);
  if (!match) throw new Error(`unexpected color ${color}`);
  return (
    0.2126 * Number(match[1]) +
    0.7152 * Number(match[2]) +
    0.0722 * Number(match[3])
  );
}

describe("scrimBaseColor", () => {
  it("darkens the page and its lifted surfaces in every palette and mode", () => {
    for (const [palette, modes] of Object.entries(nativeThemes)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = modes[mode];
        const scrim = scrimBaseColor(mode, tokens);
        for (const key of ["background", "surfaceGroupedCell"] as const) {
          const before = luminance(blendOver(tokens[key], scrim, 0));
          const after = luminance(blendOver(tokens[key], scrim, 0.35));
          const label = `${palette}/${mode}/${key}`;
          if (before === 0) {
            expect(key, label).toBe("background");
            expect(after, label).toBe(0);
          } else {
            expect(after, label).toBeLessThan(before);
          }
        }
      }
    }
  });
});
