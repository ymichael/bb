import { describe, expect, it } from "vitest";
import type { PromptMentionSuggestion } from "@bb/client-core";
import { buildPromptMentionResults } from "./promptMentionCandidates";

type ProjectMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "project" }
>;
type PluginMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "plugin" }
>;

function project(name: string): ProjectMentionSuggestion {
  return {
    kind: "project",
    path: "project:proj_automations",
    replacement: "project:proj_automations",
    projectId: "proj_automations",
    name,
  };
}

function plugin(title: string): PluginMentionSuggestion {
  return {
    kind: "plugin",
    pluginId: "at-plugin",
    providerId: "installed",
    itemId: "installed:automations",
    providerLabel: "Installed",
    title,
    subtitle: "Automation tools",
    icon: null,
    replacement: title,
  };
}

describe("buildPromptMentionResults", () => {
  it("ranks an exact plugin title ahead of a weaker built-in title", () => {
    const results = buildPromptMentionResults({
      query: "automations",
      paths: [],
      threads: [],
      projects: [project("Automations project")],
      sections: [],
      plugins: [plugin("Automations")],
    });

    expect(results.groups.map((group) => group.label)).toEqual([
      "Installed",
      "Projects",
    ]);
    expect(
      results.suggestions.map((suggestion) => suggestion.replacement),
    ).toEqual(["Automations", "project:proj_automations"]);
  });

  it("keeps provider sections distinct when their visible labels collide", () => {
    const first = plugin("First");
    const second: PluginMentionSuggestion = {
      ...plugin("Second"),
      pluginId: "other-plugin",
      itemId: "installed:second",
    };
    const results = buildPromptMentionResults({
      query: "",
      paths: [],
      threads: [],
      projects: [],
      sections: [],
      plugins: [first, second],
    });

    expect(results.groups.map((group) => group.key)).toEqual([
      "plugin:at-plugin:installed",
      "plugin:other-plugin:installed",
    ]);
  });
});
