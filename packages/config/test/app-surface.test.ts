import { describe, expect, it } from "vitest";
import { parseAppSurface, parseRequestAppSurface } from "../src/app-surface.js";

describe("app surface parsing", () => {
  it("accepts mobile and api only as request surfaces", () => {
    expect(parseRequestAppSurface("mobile")).toBe("mobile");
    expect(parseRequestAppSurface("api")).toBe("api");
    expect(parseRequestAppSurface(" web ")).toBe("web");
    expect(parseAppSurface("mobile")).toBeUndefined();
    expect(parseAppSurface("api")).toBeUndefined();
    expect(parseAppSurface("desktop")).toBe("desktop");
  });

  it("rejects unknown and empty values on both parsers", () => {
    expect(parseRequestAppSurface("tv")).toBeUndefined();
    expect(parseRequestAppSurface(null)).toBeUndefined();
    expect(parseAppSurface("")).toBeUndefined();
  });
});
