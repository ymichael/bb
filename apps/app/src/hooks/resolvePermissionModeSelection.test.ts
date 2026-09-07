import { describe, expect, it } from "vitest";
import { resolvePermissionModeSelection } from "./useThreadCreationOptions";

describe("resolvePermissionModeSelection", () => {
  it("chooses the raw permission mode when supported", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "accept-edits",
        permissionModes: ["accept-edits", "auto", "full"],
      }),
    ).toBe("accept-edits");
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "full",
        permissionModes: ["accept-edits", "full"],
      }),
    ).toBe("full");
  });

  it("falls back to full when auto is unsupported", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "auto",
        permissionModes: ["accept-edits", "full"],
      }),
    ).toBe("full");
  });

  it("prefers the auto default when the raw mode is unsupported", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "accept-edits",
        permissionModes: ["auto", "full"],
      }),
    ).toBe("auto");
  });

  it("uses the only supported mode for full-only providers", () => {
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "accept-edits",
        permissionModes: ["full"],
      }),
    ).toBe("full");
    expect(
      resolvePermissionModeSelection({
        rawPermissionMode: "accept-edits",
        permissionModes: [],
      }),
    ).toBe("auto");
  });
});
