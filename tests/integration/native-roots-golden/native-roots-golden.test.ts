import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_VARIANTS } from "./fixtures.js";
import { type ApplyEnv, captureVariant, readGolden } from "./golden.js";
import { pipeline } from "./pipeline.js";

const applyStubbedEnv: ApplyEnv = (env) => {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return () => vi.unstubAllEnvs();
};

describe("native roots golden", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const variant of FIXTURE_VARIANTS) {
    it(`${variant.providerId} (${variant.variant}) lists the golden commands and skills`, async () => {
      const golden = await readGolden(variant);
      const actual = await captureVariant(variant, pipeline, applyStubbedEnv);
      expect(actual).toEqual(golden);
    });
  }
});
