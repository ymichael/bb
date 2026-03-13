import { describe, expect, it } from "vitest";
import {
  getTemplateMetadata,
  listTemplates,
  renderTemplate,
} from "../src/index.js";

describe("@beanbag/templates", () => {
  it("lists template metadata", () => {
    const templates = listTemplates();
    expect(templates.some((template) => template.id === "threadOperationCommit")).toBe(true);
    expect(templates.some((template) => template.kind === "instruction")).toBe(true);
  });

  it("returns metadata for an individual template", () => {
    const metadata = getTemplateMetadata("codexCommitMessage");
    expect(metadata.title).toBe("Commit Message Generator");
    expect(metadata.variables.diffDescription).toContain("diff snapshot");
  });

  it("renders a template with variables", () => {
    const rendered = renderTemplate("threadOperationCommit", {
      targetDescription: "this thread workspace",
      stageInstruction: "Please commit only currently staged changes and leave unstaged edits untouched.",
      commitMessageInstruction: 'Please use this commit message exactly: "feat: add tests".',
    });

    expect(rendered).toContain("Please commit the changes in this thread workspace.");
    expect(rendered).toContain("feat: add tests");
  });
});
