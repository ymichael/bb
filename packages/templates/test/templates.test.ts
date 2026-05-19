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

  it("renders scheduled nudges in block form so the [bb system] prefix sits on its own line", () => {
    const rendered = renderTemplate("systemMessageScheduledNudge", {
      name: "daily-recap",
    });

    expect(rendered).toBe(
      ["[bb system]", "", "Scheduled nudge: daily-recap. Check ASYNC.md."].join(
        "\n",
      ),
    );
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
      "You are a manager in a project inside bb, a futuristic IDE",
    );
    expect(rendered).toContain("agents collaborate to complete tasks");
    expect(rendered).toContain("Delegate substantive work by default");
    expect(rendered).toContain(
      "All user-facing output goes through the user-message tool",
    );
    expect(rendered).toContain("mcp__bb-bridge__message_user");
    expect(rendered).toContain("bb thread spawn");
    expect(rendered).toContain("Simple delegation");
    expect(rendered).toContain("write to `STATUS.html` instead");
    expect(rendered).toContain("the UI renders it in an unsandboxed iframe");
    expect(rendered).toContain(
      "Unless otherwise specified, make `STATUS.html` styled like bb and use Tailwind.",
    );
    expect(rendered).toContain("bb guide styling");
    expect(rendered).toContain("bb guide async");
    expect(rendered).not.toContain("Structure `ASYNC.md`");
    expect(rendered).not.toContain("--background: oklch(0.9551 0 0);");
    expect(rendered).not.toContain("starter/no-preferences content");

    // Variables rendered
    expect(rendered).toContain("test-thread-123");
    expect(rendered).toContain("test-host-id");
    expect(rendered).toContain("Test Project");
    expect(rendered).toContain("America/Los_Angeles");
    expect(rendered).toContain("/tmp/test-thread-storage");
    expect(rendered).toContain("No preferences yet.");
  });

  it("renders systemMessageManagerWelcome with first-boot guidance", () => {
    const rendered = renderTemplate("systemMessageManagerWelcome", {});

    expect(rendered).toContain("[bb system]");
    expect(rendered).toContain("Welcome. You just came online inside bb.");
    expect(rendered).toContain("First, inspect `PREFERENCES.md`");
    expect(rendered).toContain("Do not interrogate. Do not sound like a");
    expect(rendered).toContain("starter/no-preferences");
    expect(rendered).toContain("mcp__bb-bridge__message_user");
    expect(rendered).toContain("name, vibe, or other identity details");
    expect(rendered).toContain("Preserve any seeded structure");
  });

  it("renders bbGuideStyling", () => {
    const templates = listTemplates();
    expect(templates.some((template) => template.id === "bbGuideStyling")).toBe(
      true,
    );

    const rendered = renderTemplate("bbGuideStyling", {});

    expect(rendered).toContain("STATUS.html styling");
    expect(rendered).toContain(
      "Unless the user asks for a different visual direction, make `STATUS.html` look",
    );
    expect(rendered).toContain(
      '<script src="https://cdn.tailwindcss.com"></script>',
    );
    expect(rendered).toContain(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap",
    );
    expect(rendered).toContain("--background: oklch(0.9551 0 0);");
    expect(rendered).toContain(
      "@media (prefers-color-scheme: dark) {\n  :root {",
    );
    expect(rendered).toContain("--background: oklch(0.195 0 0);");
    expect(rendered).toContain("--text-base: 0.9375rem;");
  });

  it("renders bbGuideAsync", () => {
    const templates = listTemplates();
    expect(templates.some((template) => template.id === "bbGuideAsync")).toBe(
      true,
    );

    const rendered = renderTemplate("bbGuideAsync", {});

    expect(rendered).toContain("Async scheduled nudges");
    expect(rendered).toContain("Use `ASYNC.md` in thread storage");
    expect(rendered).toContain("timezone: America/Los_Angeles");
    expect(rendered).toContain("No more than 20 schedules.");
    expect(rendered).toContain("The cron month field must stay `*`.");
  });

  it("renders standardAgentInstructions without user-question guidance", () => {
    const rendered = renderTemplate("standardAgentInstructions", {});

    expect(rendered).toContain("You are a coding agent");
    expect(rendered).not.toContain(
      "Ask the user a blocking question only when",
    );
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
