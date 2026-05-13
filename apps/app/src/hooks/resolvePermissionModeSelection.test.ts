import { describe, expect, it } from "vitest";
import { resolvePermissionModeSelection } from "./useThreadCreationOptions";

describe("resolvePermissionModeSelection", () => {
  it("keeps the raw mode when the provider supports it", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "readonly",
        supportedPermissionModes: ["full", "readonly"],
      }),
    ).toBe("readonly");
  });

  it("falls back to 'full' when the raw mode is unsupported and 'full' is supported", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "readonly",
        supportedPermissionModes: ["full"],
      }),
    ).toBe("full");
  });

  it("falls back to the first supported mode when 'full' is unsupported", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "readonly",
        supportedPermissionModes: ["bypass"],
      }),
    ).toBe("bypass");
  });

  it("returns 'full' when no modes are supported", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "readonly",
        supportedPermissionModes: [],
      }),
    ).toBe("full");
  });
});
