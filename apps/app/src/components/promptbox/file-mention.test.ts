import { describe, expect, it } from "vitest";
import { findActiveFileMention, insertFileMention } from "./file-mention";

describe("file mention helpers", () => {
  it("detects an active mention at the current caret", () => {
    const value = "Please review @src/components/Pro";
    const mention = findActiveFileMention(value, value.length);

    expect(mention).toEqual({
      query: "src/components/Pro",
      start: 14,
      end: value.length,
    });
  });

  it("does not detect email-like tokens as file mentions", () => {
    const value = "Reach me at hello@example.com";
    const mention = findActiveFileMention(value, value.length);

    expect(mention).toBeNull();
  });

  it("supports empty query right after @", () => {
    const value = "Look at @";
    const mention = findActiveFileMention(value, value.length);

    expect(mention).toEqual({
      query: "",
      start: value.length - 1,
      end: value.length,
    });
  });

  it("replaces the active mention range with a selected file path", () => {
    const value = "Please check @src/com and update tests";
    const mention = findActiveFileMention(
      value,
      "Please check @src/com".length,
    );
    expect(mention).not.toBeNull();

    const result = insertFileMention(
      value,
      mention!,
      "src/components/PromptBoxInternal.tsx",
    );

    expect(result.value).toBe(
      "Please check @src/components/PromptBoxInternal.tsx and update tests",
    );
    expect(result.caretPosition).toBe(
      "Please check @src/components/PromptBoxInternal.tsx".length,
    );
  });
});
