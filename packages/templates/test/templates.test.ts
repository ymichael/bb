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
    expect(
      templates.some(
        (template) => template.id === "threadOperationCommitFailureFollowUp",
      ),
    ).toBe(true);
    expect(templates.some((template) => template.kind === "instruction")).toBe(
      true,
    );
  });

  it("returns metadata for an individual template", () => {
    const metadata = getTemplateMetadata("generateCommitMessage");
    expect(metadata.title).toBe("Commit Message Generator");
    expect(metadata.variables.diffDescription).toContain("diff snapshot");
  });

  it("renders a template with variables", () => {
    const rendered = renderTemplate("threadOperationCommitFailureFollowUp", {
      errorMessage: "hooks/pre-commit exited with status 1",
    });

    expect(rendered).toContain("Commit in this thread workspace failed.");
    expect(rendered).toContain("hooks/pre-commit exited with status 1");
  });

  it("renders agent thread messages with inline reply guidance", () => {
    const rendered = renderTemplate("agentThreadMessage", {
      senderThreadId: "thr_sender",
      messageText: "Please check the failing test.",
    });

    expect(rendered).toBe(
      [
        '[bb message from thread:thr_sender; reply with `bb thread tell thr_sender "<your response>"`]',
        "",
        "Please check the failing test.",
      ].join("\n"),
    );
  });

  it("renders squash merge commit failure follow-up from structured variables", () => {
    const rendered = renderTemplate(
      "threadOperationSquashMergeCommitFailureFollowUp",
      {
        prepCommitMergeBaseBranch: "main",
        errorMessage: "nothing to commit",
      },
    );

    expect(rendered).toContain("could not create the prep commit");
    expect(rendered).toContain("main");
    expect(rendered).toContain("nothing to commit");
  });

  it("renders managerAgentInstructions with variables", () => {
    const rendered = renderTemplate("managerAgentInstructions", {
      hostId: "test-host-id",
      localTimezone: "America/Los_Angeles",
      managerPreferencesContent: "No preferences yet.",
      managerThreadId: "test-thread-123",
      threadStoragePath: "/tmp/test-thread-storage",
      projectId: "test-project-id",
      projectName: "Test Project",
      projectRootPath: "/tmp/test-project",
    });

    // Core structure
    expect(rendered).toContain(
      "You are a manager in a project inside bb, an agent orchestration tool.",
    );
    expect(rendered).toContain("agent orchestration tool");
    expect(rendered).toContain("Delegate substantive work by default");
    expect(rendered).toContain(
      "All user-facing output goes through the user-message tool",
    );
    expect(rendered).toContain("mcp__bb-bridge__message_user");
    expect(rendered).toContain("bb thread spawn");
    expect(rendered).toContain("Simple delegation");

    // Variables rendered
    expect(rendered).toContain("test-thread-123");
    expect(rendered).toContain("test-host-id");
    expect(rendered).toContain("Test Project");
    expect(rendered).toContain("America/Los_Angeles");
    expect(rendered).toContain("/tmp/test-thread-storage");
    expect(rendered).toContain("No preferences yet.");
  });

  it("renders standardAgentInstructions without user-question guidance", () => {
    const rendered = renderTemplate("standardAgentInstructions", {});

    expect(rendered).toContain("You are a coding agent");
    expect(rendered).not.toContain("Ask the user a blocking question only when");
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
      const vars = placeholderVariables[
        template.id
      ] as TemplateVariables[TemplateId];
      expect(() =>
        renderTemplate(template.id as TemplateId, vars),
      ).not.toThrow();
    }
  });
});
