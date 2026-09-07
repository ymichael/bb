import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = join(HERE, "..", "..");
const SRC_ROOT = join(MOBILE_ROOT, "src");
const APP_ROOT = join(MOBILE_ROOT, "app");

const ALLOWED_FILES = new Set([
  "src/ui/Icon.ios.tsx",
  "src/ui/sf-symbol-map.ts",
  "src/ui/platform-neutrality.test.ts",
]);

const IOS_ONLY_PATTERNS: readonly { label: string; regex: RegExp }[] = [
  { label: "@expo/ui/swift-ui import", regex: /@expo\/ui\/swift-ui/ },
  { label: "Color.ios palette", regex: /\bColor\.ios\b/ },
  { label: "Alert.prompt", regex: /\bAlert\.prompt\(/ },
  { label: "sf: image source", regex: /["'`]sf:/ },
];

const GLASS_IMPORT_REGEX = /["']expo-glass-effect["']/;

const GUARD_REGEX =
  /Platform\.select\s*\(|Platform\.OS\s*[!=]==?\s*["']ios["']|process\.env\.EXPO_OS\s*[!=]==?\s*["']ios["']/;

const GUARD_WINDOW_LINES = 40;

function listSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function isIosSibling(relPath: string): boolean {
  return /\.ios\.tsx?$/.test(relPath) && relPath.startsWith("src/");
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

interface Occurrence {
  file: string;
  line: number;
  label: string;
}

function unguardedOccurrences(): Occurrence[] {
  const problems: Occurrence[] = [];
  const files = [
    ...listSourceFiles(SRC_ROOT, []),
    ...listSourceFiles(APP_ROOT, []),
  ];
  for (const file of files) {
    const relPath = relative(MOBILE_ROOT, file);
    if (ALLOWED_FILES.has(relPath) || isIosSibling(relPath)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      for (const pattern of IOS_ONLY_PATTERNS) {
        if (!pattern.regex.test(line)) continue;
        const windowStart = Math.max(0, index - GUARD_WINDOW_LINES);
        const guarded = lines
          .slice(windowStart, index + 1)
          .some((candidate) => GUARD_REGEX.test(candidate));
        if (!guarded) {
          problems.push({
            file: relPath,
            line: index + 1,
            label: pattern.label,
          });
        }
      }
    });
  }
  return problems;
}

describe("platform neutrality", () => {
  it("keeps iOS-only APIs in *.ios.tsx siblings under src/ or behind a platform guard", () => {
    const problems = unguardedOccurrences().map(
      ({ file, line, label }) => `${file}:${line} ${label}`,
    );
    expect(problems).toEqual([]);
  });

  it("imports expo-glass-effect only from *.ios.tsx siblings under src/", () => {
    const offenders: string[] = [];
    const files = [
      ...listSourceFiles(SRC_ROOT, []),
      ...listSourceFiles(APP_ROOT, []),
    ];
    for (const file of files) {
      const relPath = relative(MOBILE_ROOT, file);
      if (ALLOWED_FILES.has(relPath) || isIosSibling(relPath)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (isCommentLine(line)) return;
          if (GLASS_IMPORT_REGEX.test(line)) {
            offenders.push(`${relPath}:${index + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("never puts platform siblings under app/ (expo-router would route them)", () => {
    const siblings = listSourceFiles(APP_ROOT, [])
      .map((file) => relative(MOBILE_ROOT, file))
      .filter((relPath) => /\.(ios|android|native|web)\.tsx?$/.test(relPath));
    expect(siblings).toEqual([]);
  });

  it("every *.ios.tsx sibling has a default twin so the Android bundle resolves", () => {
    const missing = listSourceFiles(SRC_ROOT, [])
      .filter((file) => /\.ios\.tsx?$/.test(file))
      .filter((file) => {
        const twin = file.replace(/\.ios\.(tsx?)$/, ".$1");
        try {
          return !statSync(twin).isFile();
        } catch {
          return true;
        }
      })
      .map((file) => relative(MOBILE_ROOT, file));
    expect(missing).toEqual([]);
  });

  it("no *.ios sibling imports its own basename (Metro resolves it to itself)", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT, [])) {
      const match = /([^/]+)\.ios\.tsx?$/.exec(file);
      if (!match) continue;
      const base = match[1];
      const source = readFileSync(file, "utf8");
      const selfImport = new RegExp(
        `from\\s+["']\\./${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']|require\\(["']\\./${base}["']\\)`,
      );
      source.split("\n").forEach((line, index) => {
        if (selfImport.test(line)) {
          offenders.push(`${relative(MOBILE_ROOT, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the scan sees the iOS adapters it exempts", () => {
    const files = listSourceFiles(SRC_ROOT, []).map((file) =>
      relative(MOBILE_ROOT, file),
    );
    expect(files).toContain("src/ui/Icon.ios.tsx");
    expect(files).toContain("src/ui/NativeMenu.ios.tsx");
    expect(files).toContain("src/ui/GlassSurface.ios.tsx");
    const iconSource = readFileSync(
      join(SRC_ROOT, "ui", "Icon.ios.tsx"),
      "utf8",
    );
    expect(IOS_ONLY_PATTERNS.some((p) => p.regex.test(iconSource))).toBe(true);
    const glassSource = readFileSync(
      join(SRC_ROOT, "ui", "GlassSurface.ios.tsx"),
      "utf8",
    );
    expect(GLASS_IMPORT_REGEX.test(glassSource)).toBe(true);
  });
});
