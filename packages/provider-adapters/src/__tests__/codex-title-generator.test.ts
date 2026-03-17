import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateCodexThreadTitle } from "../codex-title-generator.js";
import { generateOpenAIResponsesText } from "../openai-responses-model.js";

vi.mock("../openai-responses-model.js", () => ({
  generateOpenAIResponsesText: vi.fn(),
}));

const mockedGenerateOpenAIResponsesText = vi.mocked(generateOpenAIResponsesText);

describe("generateCodexThreadTitle", () => {
  beforeEach(() => {
    mockedGenerateOpenAIResponsesText.mockReset();
  });

  it("returns undefined when the prompt has no text content", async () => {
    const generated = await generateCodexThreadTitle({
      cwd: "/tmp",
      input: [{ type: "image", url: "/tmp/screenshot.png" }],
    });

    expect(generated).toBeUndefined();
    expect(mockedGenerateOpenAIResponsesText).not.toHaveBeenCalled();
  });

  it("parses the title from model JSON output", async () => {
    mockedGenerateOpenAIResponsesText.mockResolvedValue({
      model: "gpt-5.1-codex-mini",
      text: "{\"title\":\"Fix Login Redirect Loop\",\"worktreeName\":\"fix/login-redirect-loop\"}",
    });

    const generated = await generateCodexThreadTitle({
      cwd: "/tmp",
      input: [{ type: "text", text: "Fix the login redirect loop after OAuth callback." }],
    });

    expect(generated).toBe("Fix Login Redirect Loop");
  });

  it("suppresses missing API key errors", async () => {
    mockedGenerateOpenAIResponsesText.mockRejectedValue(
      new Error("OpenAI API key is missing. Set OPENAI_API_KEY."),
    );

    const generated = await generateCodexThreadTitle({
      cwd: "/tmp",
      input: [{ type: "text", text: "Investigate flaky CI check." }],
    });

    expect(generated).toBeUndefined();
  });

  it("rethrows non-recoverable model errors", async () => {
    mockedGenerateOpenAIResponsesText.mockRejectedValue(
      new Error("OpenAI responses request failed: unauthorized"),
    );

    await expect(
      generateCodexThreadTitle({
        cwd: "/tmp",
        input: [{ type: "text", text: "Add optimistic update for reactions." }],
      }),
    ).rejects.toThrow("unauthorized");
  });
});
