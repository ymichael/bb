import { describe, expect, it } from "vitest";
import { extractConventionalCommitLine } from "../codex-commit-message-generator.js";

describe("extractConventionalCommitLine", () => {
  it("extracts and normalizes a conventional commit line", () => {
    const extracted = extractConventionalCommitLine("  fix(parser):   handle null response payload  ");
    expect(extracted).toBe("fix(parser): handle null response payload");
  });

  it("extracts the first valid conventional commit line from mixed output", () => {
    const extracted = extractConventionalCommitLine([
      "Sure - here's a suggestion:",
      "```",
      "feat(api): support includeUnstaged in commit generation",
      "```",
      "Let me know if you want alternatives.",
    ].join("\n"));

    expect(extracted).toBe("feat(api): support includeUnstaged in commit generation");
  });

  it("returns undefined when no conventional commit line is present", () => {
    const extracted = extractConventionalCommitLine("Here is JSON only: {\"message\":\"hello\"}");
    expect(extracted).toBeUndefined();
  });
});
