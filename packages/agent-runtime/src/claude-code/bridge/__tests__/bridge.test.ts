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
            description: "Opus 4.6 with 1M context [NEW] · Most capable for complex work",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "max"],
          },
          {
            value: "sonnet",
            displayName: "Sonnet",
            description: "Sonnet 4.6 · Best for everyday tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "sonnet[1m]",
            displayName: "Sonnet (1M context)",
            description: "Sonnet 4.6 with 1M context · Billed as extra usage",
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

  it("returns the static Claude model list with 1M aliases", async () => {
    await expect(listClaudeCodeBridgeModels()).resolves.toEqual([
      expect.objectContaining({
        id: "opus[1m]",
        model: "opus[1m]",
        displayName: "Opus 4.6 (1M)",
        isDefault: true,
      }),
      expect.objectContaining({
        id: "opus",
        model: "opus",
        displayName: "Opus 4.6",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "sonnet[1m]",
        model: "sonnet[1m]",
        displayName: "Sonnet 4.6 (1M)",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "sonnet",
        model: "sonnet",
        displayName: "Sonnet 4.6",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "haiku",
        model: "haiku",
        displayName: "Haiku 4.5",
        isDefault: false,
      }),
    ]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
