import { describe, expect, it, vi } from "vitest";
import { createLlmCompletionService } from "../llm-completion.js";

describe("createLlmCompletionService", () => {
  it("normalizes generated titles", async () => {
    const service = createLlmCompletionService({
      threadTitleGenerator: vi
        .fn()
        .mockResolvedValue("   Fix   login   redirect   "),
      commitMessageGenerator: vi.fn().mockResolvedValue("chore: noop"),
    });

    await expect(
      service.generateThreadTitle({
        cwd: "/tmp",
        input: [{ type: "text", text: "Fix login redirect issue." }],
      }),
    ).resolves.toBe("Fix login redirect");
  });

  it("normalizes and clamps generated commit messages", async () => {
    const service = createLlmCompletionService({
      threadTitleGenerator: vi.fn().mockResolvedValue("Title"),
      commitMessageGenerator: vi
        .fn()
        .mockResolvedValue(`fix(parser): ${"x".repeat(140)}`),
    });

    const message = await service.generateCommitMessage({
      cwd: "/tmp",
      includeUnstaged: true,
    });

    expect(message).toBeDefined();
    expect(message!.length).toBeLessThanOrEqual(120);
    expect(message).toMatch(/^fix\(parser\):\s+\S/);
  });

  it("returns undefined when generators return empty strings", async () => {
    const service = createLlmCompletionService({
      threadTitleGenerator: vi.fn().mockResolvedValue("   "),
      commitMessageGenerator: vi.fn().mockResolvedValue(" "),
    });

    await expect(
      service.generateThreadTitle({
        cwd: "/tmp",
        input: [{ type: "text", text: "hello" }],
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.generateCommitMessage({
        cwd: "/tmp",
      }),
    ).resolves.toBeUndefined();
  });
});
