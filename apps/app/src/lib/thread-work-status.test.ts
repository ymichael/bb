import { describe, expect, it } from "vitest";
import type { ThreadWorkStatus } from "@beanbag/agent-core";
import {
  threadWorkStatusVariant,
  threadWorktreeCleanLabel,
} from "./thread-work-status";

function makeStatus(state: ThreadWorkStatus["state"]): ThreadWorkStatus {
  return {
    state,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    workspaceChangedFiles: 0,
    workspaceInsertions: 0,
    workspaceDeletions: 0,
    hasUncommittedChanges: false,
    hasCommittedUnmergedChanges: false,
    aheadCount: 0,
    behindCount: 0,
  };
}

describe("thread-work-status", () => {
  it("uses destructive deleted variant for active threads", () => {
    expect(threadWorkStatusVariant(makeStatus("deleted"))).toBe("destructive");
  });

  it("uses neutral deleted variant for archived threads", () => {
    expect(
      threadWorkStatusVariant(makeStatus("deleted"), { isArchivedThread: true }),
    ).toBe("outline");
  });

  it("shows up-to-date clean label when branch is clean and synchronized", () => {
    expect(threadWorktreeCleanLabel(makeStatus("clean"))).toBe("Clean, Up to date");
  });

  it("shows clean label when branch is clean but behind merge base", () => {
    expect(
      threadWorktreeCleanLabel({
        ...makeStatus("clean"),
        behindCount: 4,
      }),
    ).toBe("Clean");
  });

  it("shows untracked label for non-git workspaces", () => {
    expect(threadWorktreeCleanLabel(makeStatus("untracked"))).toBe("Untracked");
    expect(threadWorkStatusVariant(makeStatus("untracked"))).toBe("outline");
  });
});
