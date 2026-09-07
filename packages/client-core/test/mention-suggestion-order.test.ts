import { describe, expect, it } from "vitest";
import {
  orderMentionCandidates,
  type MentionCandidate,
  type OrderedMentionSuggestions,
  type PromptMentionSuggestion,
} from "../src/index.js";

interface CandidateOptions {
  name: string;
  visibleTitle: string;
  identityTerms?: readonly string[];
  supportingTerms?: readonly string[];
  groupKey?: string;
  groupLabel?: string;
}

function thread(name: string): PromptMentionSuggestion {
  return {
    kind: "thread",
    path: `thread:${name}`,
    replacement: name,
    projectId: "p",
    threadId: name,
    title: name,
  };
}

function candidate(options: CandidateOptions): MentionCandidate {
  return {
    suggestion: thread(options.name),
    visibleTitle: options.visibleTitle,
    identityTerms: options.identityTerms ?? [],
    supportingTerms: options.supportingTerms ?? [],
    groupKey: options.groupKey ?? options.name,
    groupLabel: options.groupLabel ?? options.groupKey ?? options.name,
  };
}

function suggestionNames(results: OrderedMentionSuggestions): string[] {
  return results.suggestions.map((suggestion) => suggestion.replacement);
}

describe("orderMentionCandidates", () => {
  it("orders exact, prefix, substring, and supporting-text matches", () => {
    const candidates = [
      candidate({
        name: "supporting",
        visibleTitle: "Migration notes",
        supportingTerms: ["Plugin documentation"],
        groupKey: "results",
      }),
      candidate({
        name: "substring",
        visibleTitle: "At Plugin Toolkit",
        groupKey: "results",
      }),
      candidate({
        name: "prefix",
        visibleTitle: "Plugin migration",
        groupKey: "results",
      }),
      candidate({
        name: "exact",
        visibleTitle: "Plugin",
        groupKey: "results",
      }),
    ];

    expect(
      suggestionNames(orderMentionCandidates(candidates, "  PLUGIN ")),
    ).toEqual(["exact", "prefix", "substring", "supporting"]);
  });

  it("treats caller-supplied aliases as identities for any suggestion kind", () => {
    const candidates = [
      candidate({
        name: "title-prefix",
        visibleTitle: "At Plugin migration",
      }),
      candidate({
        name: "alias-exact",
        visibleTitle: "Plugin Focus",
        identityTerms: ["at-plugin"],
      }),
    ];

    expect(
      suggestionNames(orderMentionCandidates(candidates, "at-plugin")),
    ).toEqual(["alias-exact", "title-prefix"]);
  });

  it("orders intact groups by their strongest candidate", () => {
    const candidates = [
      candidate({
        name: "early-supporting",
        visibleTitle: "Migration notes",
        supportingTerms: ["Plugin"],
        groupKey: "early",
        groupLabel: "Early",
      }),
      candidate({
        name: "strong-prefix",
        visibleTitle: "Plugin guide",
        groupKey: "strong",
        groupLabel: "Strong",
      }),
      candidate({
        name: "strong-weak",
        visibleTitle: "Unrelated",
        groupKey: "strong",
        groupLabel: "Strong",
      }),
      candidate({
        name: "early-substring",
        visibleTitle: "My Plugin notes",
        groupKey: "early",
        groupLabel: "Early",
      }),
    ];

    const results = orderMentionCandidates(candidates, "plugin");

    expect(results.groups.map((group) => group.key)).toEqual([
      "strong",
      "early",
    ]);
    expect(
      results.groups.map((group) =>
        group.suggestions.map((item) => item.replacement),
      ),
    ).toEqual([
      ["strong-prefix", "strong-weak"],
      ["early-substring", "early-supporting"],
    ]);
  });

  it("uses the same exact order for groups and keyboard navigation", () => {
    const results = orderMentionCandidates(
      [
        candidate({
          name: "first-prefix",
          visibleTitle: "Plugin guide",
          groupKey: "first",
          groupLabel: "First label",
        }),
        candidate({
          name: "first-exact",
          visibleTitle: "Plugin",
          groupKey: "first",
          groupLabel: "First label",
        }),
        candidate({
          name: "second-substring",
          visibleTitle: "My Plugin",
          groupKey: "second",
          groupLabel: "Second label",
        }),
      ],
      "plugin",
    );

    expect(
      results.groups.map((group) => [group.key, group.label, group.startIndex]),
    ).toEqual([
      ["first", "First label", 0],
      ["second", "Second label", 2],
    ]);
    expect(suggestionNames(results)).toEqual(
      results.groups
        .flatMap((group) => group.suggestions)
        .map((suggestion) => suggestion.replacement),
    );
  });

  it("preserves source group and candidate order for an empty query", () => {
    const candidates = [
      candidate({
        name: "first-a",
        visibleTitle: "Zed",
        groupKey: "first",
      }),
      candidate({
        name: "first-b",
        visibleTitle: "Alpha",
        groupKey: "first",
      }),
      candidate({
        name: "second-a",
        visibleTitle: "Beta",
        groupKey: "second",
      }),
    ];

    expect(suggestionNames(orderMentionCandidates(candidates, "  "))).toEqual([
      "first-a",
      "first-b",
      "second-a",
    ]);
  });
});
