import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const landingCss = readFileSync(
  new URL("../landing/landing.css", import.meta.url),
  "utf8",
);
const marketplaceCss = readFileSync(
  new URL("./marketplace.css", import.meta.url),
  "utf8",
);

function tokens(input: string, pattern: RegExp): Set<string> {
  return new Set(
    Array.from(input.matchAll(pattern), (match) => match[1] ?? ""),
  );
}

describe("marketplace theme tokens", () => {
  it("resolves every Marketplace token in light and dark themes", () => {
    const referenced = tokens(marketplaceCss, /var\((--[a-z0-9-]+)/gu);
    const light = tokens(landingCss, /(--[a-z0-9-]+)\s*:/gu);
    const darkBlock = /\.dark\s*\{(?<body>[\s\S]*?)\n\}/u.exec(landingCss);
    const dark = new Set([
      ...light,
      ...tokens(darkBlock?.groups?.body ?? "", /(--[a-z0-9-]+)\s*:/gu),
    ]);
    expect([...referenced].filter((token) => !light.has(token))).toEqual([]);
    expect([...referenced].filter((token) => !dark.has(token))).toEqual([]);
    expect(referenced.has("--canvas")).toBe(false);
  });
});
