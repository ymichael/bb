import { describe, expect, it } from "vitest";
import {
  BROWSE_ARCHETYPES,
  archetypePrompt,
} from "@/components/plugin/browse-hero/browse-hero-archetypes";
import { getCreateExamples } from "./create-via-prompt-examples";

describe("getCreateExamples", () => {
  it("serves the Browse archetypes as the plugin templates, one source", () => {
    const { examples } = getCreateExamples("plugin");

    expect(examples.map((example) => example.label)).toEqual(
      BROWSE_ARCHETYPES.map((archetype) => archetype.title),
    );
    for (const [index, example] of examples.entries()) {
      expect(example.prompt).toBe(archetypePrompt(BROWSE_ARCHETYPES[index]!));
    }
  });
});
