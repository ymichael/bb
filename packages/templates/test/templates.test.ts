import { describe, expect, it } from "vitest";
import {
  getTemplateMetadata,
  listTemplates,
  renderTemplate,
  type TemplateId,
  type TemplateVariables,
} from "../src/index.js";

describe("@bb/templates", () => {
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

  it("renders managerAgentInstructions with partial resolution", () => {
    const rendered = renderTemplate("managerAgentInstructions", {
      managerPreferencesContent: "No preferences yet.",
      managerThreadId: "test-thread-123",
      managerWorkspacePath: "/tmp/test-workspace",
      projectId: "test-project-id",
      projectName: "Test Project",
      projectRootPath: "/tmp/test-project",
    });

    // Verify the rendered output contains content from sub-template partials
    // bbCliGuide partial content
    expect(rendered).toContain("The `bb` CLI is the primary interface");
    expect(rendered).toContain("bb thread spawn");
    // bbSystemOverview partial content
    expect(rendered).toContain("agent orchestration tool");
    expect(rendered).toContain("Core concepts");
    // bbManagerWorkflows partial content
    expect(rendered).toContain("common workflows and how to handle them");
    expect(rendered).toContain("Simple delegation");

    // Verify the leaf variables are also rendered
    expect(rendered).toContain("test-thread-123");
    expect(rendered).toContain("Test Project");
    expect(rendered).toContain("/tmp/test-workspace");
  });

  it("renders all templates without error", () => {
    const templates = listTemplates();

    // Build placeholder variables for each template
    const placeholderVariables: Record<string, Record<string, string>> = {};
    for (const template of templates) {
      const vars: Record<string, string> = {};
      for (const varName of Object.keys(template.variables)) {
        vars[varName] = `__placeholder_${varName}__`;
      }
      placeholderVariables[template.id] = vars;
    }

    for (const template of templates) {
      const vars = placeholderVariables[template.id] as TemplateVariables[TemplateId];
      expect(() => renderTemplate(template.id as TemplateId, vars)).not.toThrow();
    }
  });
});
