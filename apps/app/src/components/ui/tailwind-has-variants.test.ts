import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORBIDDEN_VARIANT = /\b(?:group|peer)-has-(?:\[|[a-z])/u;

const here = dirname(fileURLToPath(import.meta.url));
const roots = [
  join(here, "..", ".."),
  join(here, "..", "..", "..", "..", "..", "packages", "shared-ui", "src"),
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.(?:tsx?|css)$/u.test(entry) && !entry.endsWith(".test.ts")) {
      yield path;
    }
  }
}

describe("Tailwind has-variants", () => {
  it("does not use group-has-* or peer-has-* variants", () => {
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (FORBIDDEN_VARIANT.test(line)) {
            offenders.push(`${file}:${index + 1}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
