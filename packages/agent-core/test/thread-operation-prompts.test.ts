import { describe, expect, it } from "vitest";
import {
  buildSquashMergeConflictFollowUpInstruction,
  buildThreadOperationInstruction,
} from "../src/thread-operation-prompts.js";

describe("buildThreadOperationInstruction", () => {
  it("builds commit instructions with explicit options", () => {
    const prompt = buildThreadOperationInstruction({
      operation: "commit",
      options: {
        includeUnstaged: false,
        message: "feat: add tests",
      },
    });

    expect(prompt).toContain("Please commit the changes");
    expect(prompt).toContain("Please commit only currently staged changes");
    expect(prompt).toContain("feat: add tests");
  });

  it("builds squash instructions for project-main commit threads", () => {
    const prompt = buildThreadOperationInstruction(
      {
        operation: "squash_merge",
        options: {
          mergeBaseBranch: "release",
          commitIfNeeded: true,
        },
      },
      { target: "project_main" },
    );

    expect(prompt).toContain("project primary checkout");
    expect(prompt).toContain("release");
    expect(prompt).toContain("Please squash-merge the changes");
  });

  it("builds squash conflict follow-up instructions with conflicted files", () => {
    const prompt = buildSquashMergeConflictFollowUpInstruction(
      {
        operation: "squash_merge",
        options: {
          mergeBaseBranch: "main",
          squashMessage: "feat: merge thread work",
        },
      },
      {
        conflictFiles: ["src/app.ts", "README.md"],
      },
    );

    expect(prompt).toContain("Squash merge to main failed with conflicts.");
    expect(prompt).toContain("Conflicted files: src/app.ts, README.md.");
    expect(prompt).toContain("Please resolve them and try the squash merge again.");
    expect(prompt).toContain("whether the retry succeeded");
  });
});
