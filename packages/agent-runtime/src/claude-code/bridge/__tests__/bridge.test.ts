import { describe, expect, it, vi } from "vitest";

// Mock the Agent SDK before importing bridge modules
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import {
  buildSessionOptions,
} from "../bridge.js";
import { listClaudeCodeBridgeModels } from "../model-list.js";

describe("bridge", () => {
  it("restricts manager sessions to coordination-safe built-in tools", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a manager.",
        cwd: "/tmp/worktree",
        managerMode: true,
      },
      {},
    );

    expect(options.tools).toEqual(["Bash", "Read", "Grep", "Glob", "LS"]);
    expect(options.cwd).toBe("/tmp/worktree");
  });

  it("leaves standard sessions on the default Claude tool preset", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
    expect(options.cwd).toBe("/tmp/worktree");
  });

  it("returns the bridge-owned Claude model list", () => {
    expect(listClaudeCodeBridgeModels().map((model) => model.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5",
    ]);
  });
});
