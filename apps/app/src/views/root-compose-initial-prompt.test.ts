import { describe, expect, it } from "vitest";
import {
  INITIAL_PROMPT_MAX_LENGTH,
  readInitialPromptFromSearch,
  stripInitialPromptFromSearch,
} from "./root-compose-initial-prompt";

describe("readInitialPromptFromSearch", () => {
  it("reads a shared prompt", () => {
    expect(readInitialPromptFromSearch("?initialPrompt=look%20at%20this")).toBe(
      "look at this",
    );
    expect(
      readInitialPromptFromSearch("?projectId=p1&initialPrompt=hello"),
    ).toBe("hello");
  });

  it("ignores an absent, empty, or whitespace-only value", () => {
    expect(readInitialPromptFromSearch("")).toBeNull();
    expect(readInitialPromptFromSearch("?projectId=p1")).toBeNull();
    expect(readInitialPromptFromSearch("?initialPrompt=")).toBeNull();
    expect(readInitialPromptFromSearch("?initialPrompt=%20%20")).toBeNull();
  });

  it("caps a hostile length", () => {
    const long = "a".repeat(INITIAL_PROMPT_MAX_LENGTH + 500);
    expect(readInitialPromptFromSearch(`?initialPrompt=${long}`)).toHaveLength(
      INITIAL_PROMPT_MAX_LENGTH,
    );
  });
});

describe("stripInitialPromptFromSearch", () => {
  it("removes only the seed, so a reload does not seed twice", () => {
    expect(stripInitialPromptFromSearch("?initialPrompt=hi")).toBe("");
    expect(stripInitialPromptFromSearch("?projectId=p1&initialPrompt=hi")).toBe(
      "?projectId=p1",
    );
    expect(stripInitialPromptFromSearch("?projectId=p1")).toBe("?projectId=p1");
  });
});
