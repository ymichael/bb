import { describe, expect, it } from "vitest";
import { automaticHostLimit, resolveHostLimit } from "./limits.js";

describe("automaticHostLimit", () => {
  it.each([
    [null, 1],
    [1, 1],
    [2, 2],
    [4, 4],
    [8, 8],
    [16, 16],
    [32, 32],
  ])("maps %s available processors to %s threads", (processors, limit) => {
    expect(automaticHostLimit(processors)).toBe(limit);
  });
});

describe("resolveHostLimit", () => {
  it("uses each host's detected automatic limit by default", () => {
    const configuration = { globalLimit: null, hostOverrides: [] };

    expect(resolveHostLimit(configuration, "host-a", 8)).toEqual({
      limit: 8,
      mode: "automatic",
    });
    expect(resolveHostLimit(configuration, "host-b", 16)).toEqual({
      limit: 16,
      mode: "automatic",
    });
  });

  it("uses an explicit host override, including zero", () => {
    const configuration = {
      globalLimit: null,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
    };

    expect(resolveHostLimit(configuration, "host-a", 16)).toEqual({
      limit: 0,
      mode: "override",
    });
  });
});
