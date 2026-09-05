import { describe, expect, it } from "vitest";
import {
  encodeProviderValue,
  parseEnvironmentValue,
} from "./environment-picker-value";

describe("provider environment values", () => {
  it("round-trips a provider id containing dashes", () => {
    const value = encodeProviderValue("docker-sandbox");
    expect(value).toBe("provider:docker-sandbox");
    expect(parseEnvironmentValue(value)).toEqual({
      type: "provider",
      environmentProviderId: "docker-sandbox",
    });
  });

  it("round-trips provider ids with underscores and digits", () => {
    const value = encodeProviderValue("wt_2");
    expect(parseEnvironmentValue(value)).toEqual({
      type: "provider",
      environmentProviderId: "wt_2",
    });
  });

  it("rejects malformed provider values", () => {
    expect(parseEnvironmentValue("provider:")).toBeNull();
    expect(parseEnvironmentValue("provider:a/b")).toBeNull();
    expect(parseEnvironmentValue("provider:bad*id")).toBeNull();
    expect(parseEnvironmentValue(`provider:${"a".repeat(65)}`)).toBeNull();
  });
});
