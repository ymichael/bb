import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_MAP, ICON_NAMES, isIconName } from "./icon-map";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_UI_DIR = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "shared-ui",
  "src",
  "components",
  "ui",
);
const SHARED_UI_CORE_ICON_PATH = join(SHARED_UI_DIR, "icon.tsx");
const SHARED_UI_EXTENDED_ICON_PATH = join(SHARED_UI_DIR, "icon-extended.tsx");
const MOBILE_ICON_MAP_PATH = join(HERE, "icon-map.ts");

function iconMapEntries(
  source: string,
  { start: startMarker, end: endMarker }: { start: string; end: string },
): Map<string, string> {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`${startMarker} literal not found`);
  }
  const body = source.slice(start, end);
  return new Map(
    Array.from(
      body.matchAll(/^\s+([A-Za-z0-9]+):\s*([A-Za-z0-9]+),/gm),
      (m) => [m[1], m[2]],
    ),
  );
}

function webIconMapEntries(): Map<string, string> {
  const core = iconMapEntries(readFileSync(SHARED_UI_CORE_ICON_PATH, "utf8"), {
    start: "const CORE_ICON_MAP = {",
    end: "} as const satisfies",
  });
  const extended = iconMapEntries(
    readFileSync(SHARED_UI_EXTENDED_ICON_PATH, "utf8"),
    {
      start: "export const EXTENDED_ICON_MAP: ExtendedIconMap = {",
      end: "\n};",
    },
  );
  for (const [name, glyph] of extended) {
    if (core.has(name)) throw new Error(`icon ${name} in both web maps`);
    core.set(name, glyph);
  }
  return core;
}

describe("ICON_MAP", () => {
  it("has the same names bound to the same glyphs as @bb/shared-ui", () => {
    const web = webIconMapEntries();
    const mobile = iconMapEntries(readFileSync(MOBILE_ICON_MAP_PATH, "utf8"), {
      start: "const ICON_MAP = {",
      end: "} as const satisfies",
    });
    expect(web.size).toBeGreaterThan(100);
    expect([...mobile.keys()].sort()).toEqual([...web.keys()].sort());
    for (const [name, glyph] of web) {
      expect(mobile.get(name), name).toBe(glyph);
    }
    expect([...ICON_NAMES].sort()).toEqual([...web.keys()].sort());
  });

  it("every entry is non-empty svg element data", () => {
    for (const name of ICON_NAMES) {
      const glyph = ICON_MAP[name];
      expect(Array.isArray(glyph), name).toBe(true);
      expect(glyph.length, name).toBeGreaterThan(0);
      for (const [tag, attrs] of glyph) {
        expect(typeof tag).toBe("string");
        expect(typeof attrs).toBe("object");
      }
    }
  });

  it("isIconName narrows strings without walking the prototype", () => {
    expect(isIconName("Plus")).toBe(true);
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("")).toBe(false);
    expect(isIconName(42)).toBe(false);
  });
});
