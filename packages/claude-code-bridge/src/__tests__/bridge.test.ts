import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Agent SDK before importing bridge modules
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { BRIDGE_METHODS, buildSessionOptions } from "../bridge.js";

describe("bridge", () => {
  it("exports expected RPC methods", () => {
    expect(BRIDGE_METHODS).toContain("initialize");
    expect(BRIDGE_METHODS).toContain("thread/start");
    expect(BRIDGE_METHODS).toContain("thread/resume");
    expect(BRIDGE_METHODS).toContain("turn/start");
    expect(BRIDGE_METHODS).toContain("turn/steer");
    expect(BRIDGE_METHODS).toContain("thread/stop");
  });

  it("restricts manager sessions to coordination-safe built-in tools", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a manager.",
        cwd: "/tmp/manager",
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
        cwd: "/tmp/thread",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
  });
});
