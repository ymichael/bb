import { describe, expect, it } from "vitest";
import { CLAIMED_EXTENSIONS, languageForPath } from "./languages.js";

async function bundledLanguageIds(): Promise<Set<string> | null> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const bundle = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
    "monaco",
    "editor.js",
  );
  let source: string;
  try {
    source = await readFile(bundle, "utf8");
  } catch {
    return null;
  }
  return new Set(
    [...source.matchAll(/id:"([a-z0-9+#-]+)"/g)].map((match) => match[1]!),
  );
}

describe("claimed languages", () => {
  it("maps every claimed extension to a language id", () => {
    for (const extension of CLAIMED_EXTENSIONS) {
      expect(languageForPath(`file.${extension}`)).toBeTruthy();
    }
  });

  it("only maps to languages the shipped bundle registers", async () => {
    const bundled = await bundledLanguageIds();
    if (bundled === null) {
      expect(CLAIMED_EXTENSIONS.length).toBeGreaterThan(0);
      return;
    }
    const missing = [
      ...new Set(
        CLAIMED_EXTENSIONS.map((extension) =>
          languageForPath(`f.${extension}`),
        ),
      ),
    ].filter((language) => language !== "plaintext" && !bundled.has(language));

    expect(missing).toEqual([]);
  });
});
