import { describe, expect, it } from "vitest";
import type { PromptInput } from "@bb/domain";
import {
  deriveTitleFallback,
  sanitizeGeneratedTitle,
} from "../../src/services/threads/title-generation.js";

function textInput(text: string): PromptInput {
  return {
    type: "text",
    text,
    mentions: [],
  };
}

describe("thread title generation", () => {
  it("limits generated titles to 36 characters at a word boundary", () => {
    expect(
      sanitizeGeneratedTitle(
        "Investigate Extremely Long Generated Thread Title Output",
      ),
    ).toBe("Investigate Extremely Long Generated");
  });

  it("returns null for empty generated titles", () => {
    expect(sanitizeGeneratedTitle("   ")).toBeNull();
  });

  it("keeps the immediate fallback limited to 80 characters", () => {
    const input = [textInput("x".repeat(100))];

    expect(deriveTitleFallback(input)).toBe(`${"x".repeat(77)}...`);
  });
});
