import { describe, expect, it, vi } from "vitest";

// Mock the Agent SDK before importing bridge modules
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { buildSessionOptions } from "../bridge.js";

describe("bridge", () => {
  it("restricts manager sessions to coordination-safe built-in tools", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a manager.",
        managerMode: true,
      },
      {},
    );

    expect(options.tools).toEqual(["Bash", "Read", "Grep", "Glob", "LS"]);
  });

  it("leaves standard sessions on the default Claude tool preset", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
  });
});
