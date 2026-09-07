import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, isIconName, type IconName } from "./icon-map";
import {
  SF_SYMBOL_MAP,
  SF_SYMBOL_WEIGHT,
  SF_SYMBOL_WEIGHTS,
  sfSymbolFor,
} from "./sf-symbol-map";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN_ROOTS = [join(HERE, ".."), join(HERE, "..", "..", "app")];
const SELF_FILES = new Set([
  "icon-map.ts",
  "icon-map.test.ts",
  "sf-symbol-map.ts",
  "sf-symbol-map.test.ts",
]);

const BRAND_MARKS: readonly IconName[] = ["Discord", "Github"];

const MAX_SF_SYMBOLS_VERSION = "4.2";

function listSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (/\.tsx?$/.test(entry) && !SELF_FILES.has(entry)) out.push(path);
  }
  return out;
}

function usedIconNames(): Map<IconName, string[]> {
  const used = new Map<IconName, string[]>();
  const record = (candidate: string, location: string) => {
    if (!isIconName(candidate)) return;
    const locations = used.get(candidate) ?? [];
    locations.push(location);
    used.set(candidate, locations);
  };
  for (const file of SCAN_ROOTS.flatMap((root) => listSourceFiles(root, []))) {
    const source = readFileSync(file, "utf8");
    const typed = source.includes("IconName");
    source.split("\n").forEach((line, index) => {
      const location = `${file}:${index + 1}`;
      for (const match of line.matchAll(
        /\b(?:name|icon|leading|trailing|glyph|leadingIcon|trailingIcon)=\{?"([A-Z][A-Za-z0-9]*)"/g,
      )) {
        record(match[1], location);
      }
      for (const match of line.matchAll(
        /\b(?:icon|leading|glyph|leadingIcon|trailingIcon|statusIcon|iconName)\??:\s*"([A-Z][A-Za-z0-9]*)"/g,
      )) {
        record(match[1], location);
      }
      if (!typed) return;
      for (const match of line.matchAll(/"([A-Z][A-Za-z0-9]*)"/g)) {
        record(match[1], location);
      }
    });
  }
  return used;
}

function sfSymbolCatalog(): Map<string, string> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("sf-symbols-typescript/package.json");
  const source = readFileSync(
    join(dirname(packageJson), "dist", "index.d.ts"),
    "utf8",
  );
  const catalog = new Map<string, string>();
  let version: string | null = null;
  for (const line of source.split("\n")) {
    const block = line.match(/^export type SFSymbols(\d+)_(\d+) =/);
    if (block) {
      version = `${block[1]}.${block[2]}`;
      continue;
    }
    const entry = line.match(/^\s*\|\s*'([^']+)'/);
    if (entry && version && !catalog.has(entry[1])) {
      catalog.set(entry[1], version);
    }
  }
  return catalog;
}

function versionTuple(version: string): [number, number] {
  const [major = "0", minor = "0"] = version.split(".");
  return [Number(major), Number(minor)];
}

function isAtMost(version: string, limit: string): boolean {
  const [major, minor] = versionTuple(version);
  const [limitMajor, limitMinor] = versionTuple(limit);
  return major < limitMajor || (major === limitMajor && minor <= limitMinor);
}

describe("SF_SYMBOL_MAP", () => {
  it("maps every icon name except the brand marks", () => {
    const unmapped = ICON_NAMES.filter(
      (name) => sfSymbolFor(name) === undefined,
    );
    expect(unmapped.sort()).toEqual([...BRAND_MARKS].sort());
    for (const key of Object.keys(SF_SYMBOL_MAP)) {
      expect(isIconName(key), key).toBe(true);
    }
  });

  it("covers every icon name the app renders", () => {
    const used = usedIconNames();
    expect(used.size).toBeGreaterThan(12);
    const missing = [...used]
      .filter(
        ([name]) =>
          sfSymbolFor(name) === undefined && !BRAND_MARKS.includes(name),
      )
      .map(([name, locations]) => `${name} (${locations[0]})`);
    expect(missing).toEqual([]);
  });

  it("uses bare symbol names that exist by the deployment target's SF Symbols release", () => {
    const catalog = sfSymbolCatalog();
    expect(catalog.size).toBeGreaterThan(4000);
    const problems: string[] = [];
    for (const [name, symbol] of Object.entries(SF_SYMBOL_MAP)) {
      if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(symbol)) {
        problems.push(`${name}: "${symbol}" is not a bare symbol name`);
        continue;
      }
      const since = catalog.get(symbol);
      if (since === undefined) {
        problems.push(`${name}: "${symbol}" is not in the SF Symbols catalog`);
      } else if (!isAtMost(since, MAX_SF_SYMBOLS_VERSION)) {
        problems.push(
          `${name}: "${symbol}" needs SF Symbols ${since} (max ${MAX_SF_SYMBOLS_VERSION})`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("sfSymbolFor returns the mapped symbol and nothing for brand marks", () => {
    expect(sfSymbolFor("Plus")).toBe("plus");
    expect(sfSymbolFor("Trash2")).toBe("trash");
    expect(sfSymbolFor("Github")).toBeUndefined();
    expect(sfSymbolFor("Discord")).toBeUndefined();
  });

  it("symbol weights are the numeric fontWeight strings expo-image parses", () => {
    expect(Object.values(SF_SYMBOL_WEIGHTS)).toEqual([
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
    ]);
    expect(SF_SYMBOL_WEIGHTS[SF_SYMBOL_WEIGHT]).toBe("500");
  });
});
