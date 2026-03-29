import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importFixtureCorpus } from "../src/fixtures.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("importFixtureCorpus", () => {
  it("rejects corpus ids that escape the fixture root", () => {
    const fixtureRoot = createTempDir("provider-audit-fixtures-");
    const sourceRoot = createTempDir("provider-audit-source-");

    expect(() =>
      importFixtureCorpus({
        fixtureRoot,
        sourceRoot,
        corpusId: "../escape",
      })).toThrow("Invalid corpus id");
  });

  it("allows corpus ids inside the fixture root", () => {
    const fixtureRoot = createTempDir("provider-audit-fixtures-");
    const sourceRoot = createTempDir("provider-audit-source-");
    const bundleDir = join(sourceRoot, "bundle");
    mkdirSync(bundleDir, { recursive: true });

    expect(() =>
      importFixtureCorpus({
        fixtureRoot,
        sourceRoot,
        corpusId: "excalidraw",
      })).not.toThrow();
  });
});
