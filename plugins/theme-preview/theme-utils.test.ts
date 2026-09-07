import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { LatestRequest, contrastRatio } from "./theme-utils";

describe("contrastRatio", () => {
  it("composites translucent foregrounds over their comparison surface", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(21, 5);
    expect(contrastRatio("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)")).toBeCloseTo(3.98, 2);
  });

  it("composites translucent surfaces over their rendered backdrop", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)")).toBeCloseTo(5.28, 2);
  });
});

describe("LatestRequest", () => {
  it("accepts only the newest request when responses arrive out of order", () => {
    const requests = new LatestRequest();
    const stale = requests.begin();
    const latest = requests.begin();
    expect(requests.isLatest(latest)).toBe(true);
    expect(requests.isLatest(stale)).toBe(false);
  });
});

describe("bb theme preference integration", () => {
  it("leaves color-scheme ownership with bb's theme CSS", () => {
    const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source.match(/MODE_KEY/g)).toHaveLength(4);
    expect(source).not.toContain("style.colorScheme");
  });
});
