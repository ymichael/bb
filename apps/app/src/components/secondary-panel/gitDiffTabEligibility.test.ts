import { describe, expect, it } from "vitest";
import { resolveGitDiffTabStatus } from "./gitDiffTabEligibility";

describe("resolveGitDiffTabStatus", () => {
  it("keeps eligibility unresolved while thread or environment data loads", () => {
    expect(
      resolveGitDiffTabStatus({
        environmentId: null,
        environmentIsGitRepo: undefined,
        environmentLoadFailed: false,
        environmentOwnsPath: undefined,
        hasResolvedThread: false,
        threadArchived: false,
      }),
    ).toBe("loading");
    expect(
      resolveGitDiffTabStatus({
        environmentId: "env-1",
        environmentIsGitRepo: undefined,
        environmentLoadFailed: false,
        environmentOwnsPath: undefined,
        hasResolvedThread: true,
        threadArchived: false,
      }),
    ).toBe("loading");
  });

  it("removes Diff only after the environment is definitively ineligible", () => {
    expect(
      resolveGitDiffTabStatus({
        environmentId: null,
        environmentIsGitRepo: undefined,
        environmentLoadFailed: false,
        environmentOwnsPath: undefined,
        hasResolvedThread: true,
        threadArchived: false,
      }),
    ).toBe("ineligible");
    expect(
      resolveGitDiffTabStatus({
        environmentId: "env-1",
        environmentIsGitRepo: false,
        environmentLoadFailed: false,
        environmentOwnsPath: true,
        hasResolvedThread: true,
        threadArchived: false,
      }),
    ).toBe("ineligible");
  });

  it("keeps the tab present when environment eligibility cannot be loaded", () => {
    expect(
      resolveGitDiffTabStatus({
        environmentId: "env-1",
        environmentIsGitRepo: undefined,
        environmentLoadFailed: true,
        environmentOwnsPath: undefined,
        hasResolvedThread: true,
        threadArchived: false,
      }),
    ).toBe("error");
  });

  it("hides git surfaces for an archived checkout whose provider does not own its path", () => {
    expect(
      resolveGitDiffTabStatus({
        environmentId: "env-checkout",
        environmentIsGitRepo: true,
        environmentLoadFailed: false,
        environmentOwnsPath: false,
        hasResolvedThread: true,
        threadArchived: true,
      }),
    ).toBe("ineligible");
  });
});
