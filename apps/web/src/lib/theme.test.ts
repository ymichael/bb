import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { THEME_INIT } from "./theme";

const landingCss = readFileSync(
  new URL("../landing/landing.css", import.meta.url),
  "utf8",
);

function runThemeInit(osDark: boolean): Set<string> {
  const classes = new Set<string>();
  const document = {
    documentElement: {
      classList: { add: (name: string) => classes.add(name) },
    },
  };
  const matchMedia = (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" ? osDark : false,
  });
  new Function("document", "matchMedia", THEME_INIT)(document, matchMedia);
  return classes;
}

describe("THEME_INIT", () => {
  it("applies the dark palette from the dark media query alone", () => {
    expect(runThemeInit(true)).toEqual(new Set(["dark"]));
    expect(runThemeInit(false)).toEqual(new Set());
    expect(THEME_INIT).not.toContain("localStorage");
    expect(landingCss).toMatch(/\n\.dark \{\n  color-scheme: dark;\n  --bg: /u);
  });
});
