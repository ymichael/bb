import { describe, expect, it } from "vitest";
import {
  MOBILE_BRIDGE_VERSION,
  compareBridgeVersions,
  isBridgeUsable,
} from "../src/index.js";

describe("compareBridgeVersions", () => {
  it("matches the shell's own version", () => {
    expect(compareBridgeVersions(MOBILE_BRIDGE_VERSION)).toEqual({
      kind: "supported",
    });
  });

  it("keeps working when the server serves an older page", () => {
    const compatibility = compareBridgeVersions(1, 3);
    expect(compatibility.kind).toBe("older-peer");
    expect(isBridgeUsable(compatibility)).toBe(true);
  });

  it("keeps working when a phone lags behind the server", () => {
    const compatibility = compareBridgeVersions(4, 2);
    expect(compatibility.kind).toBe("newer-peer");
    expect(isBridgeUsable(compatibility)).toBe(true);
  });

  it("treats a nonsense version as no bridge", () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      const compatibility = compareBridgeVersions(value, 1);
      expect(compatibility.kind, String(value)).toBe("unsupported");
      expect(isBridgeUsable(compatibility)).toBe(false);
    }
  });
});
