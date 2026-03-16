import { describe, expect, it } from "vitest";
import type { EnvironmentCapabilities } from "@bb/core";
import { supportsPrimaryCheckoutMetadata } from "./thread-primary-checkout";

function makeCapabilities(
  overrides: Partial<EnvironmentCapabilities>,
): EnvironmentCapabilities {
  return {
    host_filesystem: true,
    isolated_workspace: false,
    promote_primary_checkout: false,
    demote_primary_checkout: false,
    squash_merge: false,
    ...overrides,
  };
}

describe("thread-primary-checkout", () => {
  it("returns false when the workspace is already the project root", () => {
    expect(
      supportsPrimaryCheckoutMetadata(
        makeCapabilities({
          isolated_workspace: false,
          promote_primary_checkout: false,
          demote_primary_checkout: false,
        }),
      ),
    ).toBe(false);
  });

  it("returns true for environments that can promote into primary checkout", () => {
    expect(
      supportsPrimaryCheckoutMetadata(
        makeCapabilities({
          isolated_workspace: true,
          promote_primary_checkout: true,
        }),
      ),
    ).toBe(true);
  });

  it("returns true for environments that can demote from primary checkout", () => {
    expect(
      supportsPrimaryCheckoutMetadata(
        makeCapabilities({
          demote_primary_checkout: true,
        }),
      ),
    ).toBe(true);
  });
});
