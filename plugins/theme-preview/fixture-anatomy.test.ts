import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { FIXTURE_ANCHORS, VIEW_FIXTURE_ANCHORS } from "./fixture-anatomy";
import { MOCK_VIEWS } from "./taxonomy";

// Built-in plugins live at <repoRoot>/plugins/<name>, so the app source the
// fixture mirrors is two levels up. This test only runs in the source
// checkout (vitest), never in a packaged build.
const repoRoot = resolve(__dirname, "../..");

describe("Theme Preview fixture anatomy", () => {
  for (const view of MOCK_VIEWS) {
    it(`${view.label} has an explicit live-app source contract`, () => {
      expect(VIEW_FIXTURE_ANCHORS[view.id].length).toBeGreaterThan(0);
    });
  }

  for (const anchor of FIXTURE_ANCHORS) {
    it(`still matches ${anchor.file}`, () => {
      const source = readFileSync(resolve(repoRoot, anchor.file), "utf8");
      for (const needle of anchor.mustContain) {
        expect(source, `${anchor.because}\nExpected ${anchor.file} to contain: ${needle}`).toContain(needle);
      }
    });
  }
});
