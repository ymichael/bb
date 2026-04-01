import { describe, expect, it } from "vitest";
import { shouldSyncSelectedMergeBaseBranch } from "./useEnvironmentMergeBase";

describe("shouldSyncSelectedMergeBaseBranch", () => {
  it("syncs when the environment changes", () => {
    expect(
      shouldSyncSelectedMergeBaseBranch({
        previousStateKey: "env-1",
        nextStateKey: "env-2",
        persistedMergeBaseBranch: "release",
        selectedMergeBaseBranch: "main",
        updatePending: false,
      }),
    ).toBe(true);
  });

  it("syncs when the persisted merge base changes for the same environment", () => {
    expect(
      shouldSyncSelectedMergeBaseBranch({
        previousStateKey: "env-1",
        nextStateKey: "env-1",
        persistedMergeBaseBranch: "release",
        selectedMergeBaseBranch: "main",
        updatePending: false,
      }),
    ).toBe(true);
  });

  it("does not overwrite the local selection while the current environment update is pending", () => {
    expect(
      shouldSyncSelectedMergeBaseBranch({
        previousStateKey: "env-1",
        nextStateKey: "env-1",
        persistedMergeBaseBranch: null,
        selectedMergeBaseBranch: "release",
        updatePending: true,
      }),
    ).toBe(false);
  });

  it("does not resync when the same persisted value is already selected", () => {
    expect(
      shouldSyncSelectedMergeBaseBranch({
        previousStateKey: "env-1",
        nextStateKey: "env-1",
        persistedMergeBaseBranch: null,
        selectedMergeBaseBranch: undefined,
        updatePending: false,
      }),
    ).toBe(false);
  });
});
