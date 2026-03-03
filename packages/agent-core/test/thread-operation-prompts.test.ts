import { describe, expect, it } from "vitest";
import { buildThreadOperationInstruction } from "../src/thread-operation-prompts.js";

describe("buildThreadOperationInstruction", () => {
  it("builds commit instructions with explicit options", () => {
    const prompt = buildThreadOperationInstruction({
      operation: "commit",
      options: {
        includeUnstaged: false,
        message: "feat: add tests",
      },
    });

    expect(prompt).toContain("commit request");
    expect(prompt).toContain("Commit only currently staged changes");
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
    expect(prompt).toContain("squash-merge request");
  });
});
