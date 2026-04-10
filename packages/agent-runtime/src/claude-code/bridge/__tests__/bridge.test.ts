import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import {
  buildSessionOptions,
} from "../bridge.js";
import { listClaudeCodeBridgeModels } from "../model-list.js";

describe("bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        account: {},
        models: [
          {
            value: "default",
            displayName: "Default (recommended)",
            description: "Opus 4.6 with 1M context",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "max"],
          },
          {
            value: "sonnet[1m]",
            displayName: "Sonnet (1M context)",
            description: "Sonnet 4.6 with 1M context",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "haiku",
            displayName: "Haiku",
            description: "Haiku 4.5",
          },
        ],
      }),
      close: vi.fn(),
    });
  });

  it("leaves manager sessions on the default Claude built-in tool set", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a manager.",
        cwd: "/tmp/worktree",
        instructionMode: "replace",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
    expect(options.cwd).toBe("/tmp/worktree");
  });

  it("leaves standard sessions on the default Claude tool preset", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
    expect(options.cwd).toBe("/tmp/worktree");
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a coder.",
    });
  });

  it("keeps manager sessions on a plain string system prompt", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a manager.",
        cwd: "/tmp/worktree",
        instructionMode: "replace",
      },
      {},
    );

    expect(options.systemPrompt).toBe("You are a manager.");
  });

  it("returns the bridge-owned Claude model list from the SDK probe", async () => {
    await expect(listClaudeCodeBridgeModels()).resolves.toEqual([
      expect.objectContaining({ id: "default", isDefault: true }),
      expect.objectContaining({ id: "sonnet[1m]", isDefault: false }),
      expect.objectContaining({ id: "haiku", isDefault: false }),
    ]);
  });
});
