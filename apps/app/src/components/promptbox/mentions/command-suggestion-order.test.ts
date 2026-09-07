import { describe, expect, it } from "vitest";
import {
  orderCommandSuggestions,
  type ComposerCommandSuggestion,
} from "@bb/client-core";

function skill(
  name: string,
  description: string | null = null,
): ComposerCommandSuggestion {
  return {
    kind: "command",
    name,
    source: "skill",
    origin: "user",
    description,
    argumentHint: null,
  };
}

function userCommand(name: string): ComposerCommandSuggestion {
  return {
    kind: "command",
    name,
    source: "command",
    origin: "user",
    description: null,
    argumentHint: null,
  };
}

function projectCommand(name: string): ComposerCommandSuggestion {
  return {
    kind: "command",
    name,
    source: "command",
    origin: "project",
    description: null,
    argumentHint: null,
  };
}

function orderedNames(
  suggestions: readonly ComposerCommandSuggestion[],
  query: string,
): string[] {
  return orderCommandSuggestions(suggestions, query).map(
    (suggestion) => suggestion.name,
  );
}

describe("orderCommandSuggestions", () => {
  it("keeps section order when every row matches the query as directly", () => {
    expect(
      orderedNames(
        [userCommand("plan"), skill("planner"), projectCommand("plan-review")],
        "pla",
      ),
    ).toEqual(["planner", "plan-review", "plan"]);
  });

  it("hoists a user-command name prefix above description-only matches", () => {
    expect(
      orderedNames(
        [
          skill("sprint", "Plan a sprint"),
          skill("scope", "Planning helper"),
          userCommand("plan"),
        ],
        "pla",
      ),
    ).toEqual(["plan", "sprint", "scope"]);
  });

  it("ranks an exact match above a prefix match from an earlier section", () => {
    expect(
      orderedNames([skill("planner"), userCommand("plan")], "plan"),
    ).toEqual(["plan", "planner"]);
  });

  it("hoists an exact user-command match above every non-exact match", () => {
    expect(
      orderedNames(
        [skill("planner"), skill("planning-doc"), userCommand("plan")],
        "plan",
      ),
    ).toEqual(["plan", "planner", "planning-doc"]);
  });

  it("keeps each section contiguous so rendering cannot reshuffle rows", () => {
    expect(
      orderedNames(
        [skill("planner"), userCommand("plan-b"), userCommand("plan")],
        "plan",
      ),
    ).toEqual(["plan", "plan-b", "planner"]);
  });

  it("treats a namespaced skill's bare name as an exact match", () => {
    expect(
      orderedNames(
        [projectCommand("review-pr"), skill("ottonomous:review")],
        "review",
      ),
    ).toEqual(["ottonomous:review", "review-pr"]);
  });

  it("ranks a literal command above a namespaced skill's bare alias", () => {
    expect(
      orderedNames([skill("plugin:plan"), userCommand("plan")], "plan"),
    ).toEqual(["plan", "plugin:plan"]);
  });

  it("falls back to section order when several sections match exactly", () => {
    expect(orderedNames([userCommand("plan"), skill("plan")], "plan")).toEqual([
      "plan",
      "plan",
    ]);
    expect(
      orderCommandSuggestions([userCommand("plan"), skill("plan")], "plan").map(
        (suggestion) => suggestion.source,
      ),
    ).toEqual(["skill", "command"]);
  });

  it("ignores query whitespace and casing when detecting an exact match", () => {
    expect(
      orderedNames([skill("planner"), userCommand("plan")], "  PLAN "),
    ).toEqual(["plan", "planner"]);
  });

  it("leaves pure section order for an empty query", () => {
    expect(
      orderedNames(
        [userCommand("plan"), projectCommand("ship"), skill("planner")],
        "",
      ),
    ).toEqual(["planner", "ship", "plan"]);
  });
});
