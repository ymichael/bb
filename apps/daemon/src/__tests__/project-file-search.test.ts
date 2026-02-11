import { describe, expect, it } from "vitest";
import { rankProjectFiles } from "../project-file-search.js";

describe("project file search ranking", () => {
  it("prioritizes exact filename matches", () => {
    const ranked = rankProjectFiles(
      [
        "src/components/PromptBox.tsx",
        "src/views/promptbox-helper.ts",
        "docs/prompt-notes.md",
      ],
      "PromptBox.tsx",
      3,
    );

    expect(ranked[0]?.path).toBe("src/components/PromptBox.tsx");
  });

  it("supports fuzzy matching when direct contains match is unavailable", () => {
    const ranked = rankProjectFiles(
      [
        "src/components/PromptBox.tsx",
        "src/components/ProjectMainView.tsx",
        "README.md",
      ],
      "pbx",
      3,
    );

    expect(ranked).toEqual([{ path: "src/components/PromptBox.tsx" }]);
  });

  it("applies result limits", () => {
    const ranked = rankProjectFiles(
      [
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ],
      "src",
      2,
    );

    expect(ranked).toHaveLength(2);
  });

  it("filters OS metadata files from results", () => {
    const ranked = rankProjectFiles(
      [
        "plans/.DS_Store",
        "plans/orchestrator-task-model.md",
      ],
      "plans/",
      5,
    );

    expect(ranked).toEqual([
      { path: "plans/orchestrator-task-model.md" },
    ]);
  });
});
