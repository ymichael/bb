import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const {
  mockGetActiveToolNames,
  mockSetActiveToolsByName,
  mockOpen,
  mockInMemory,
  mockSettingsInMemory,
  mockCreateAgentSession,
} = vi.hoisted(() => {
  const mockSubscribe = vi.fn(() => () => {});
  const mockPrompt = vi.fn();
  const mockDispose = vi.fn();
  const mockGetSessionStats = vi.fn();
  const mockGetContextUsage = vi.fn();
  const mockGetActiveToolNames = vi.fn<() => string[]>(() => []);
  const mockSetActiveToolsByName = vi.fn<(toolNames: string[]) => void>();
  const mockOpen = vi.fn((path: string) => ({ kind: "open", path }));
  const mockInMemory = vi.fn((cwd?: string) => ({ kind: "in-memory", cwd }));
  const mockSettingsInMemory = vi.fn(() => ({ kind: "settings" }));
  const mockCreateAgentSession = vi.fn(async () => ({
    session: {
      subscribe: mockSubscribe,
      prompt: mockPrompt,
      dispose: mockDispose,
      getSessionStats: mockGetSessionStats,
      getContextUsage: mockGetContextUsage,
      getActiveToolNames: mockGetActiveToolNames,
      setActiveToolsByName: mockSetActiveToolsByName,
      isStreaming: false,
    },
  }));

  return {
    mockGetActiveToolNames,
    mockSetActiveToolsByName,
    mockOpen,
    mockInMemory,
    mockSettingsInMemory,
    mockCreateAgentSession,
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    open: mockOpen,
    inMemory: mockInMemory,
  },
  SettingsManager: {
    inMemory: mockSettingsInMemory,
  },
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(),
}));

import { PiSdkSession } from "../sdk-session.js";

describe("PiSdkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveToolNames.mockReturnValue([]);
  });

  it("opens a persistent session file when provided", async () => {
    const session = new PiSdkSession(
      {
        cwd: "/tmp/project",
        sessionFilePath: "/tmp/pi-sessions/thread-1.jsonl",
      },
      vi.fn(),
      vi.fn(),
    );

    await session.start();

    expect(mockOpen).toHaveBeenCalledWith(
      "/tmp/pi-sessions/thread-1.jsonl",
      "/tmp/pi-sessions",
    );
    expect(mockInMemory).not.toHaveBeenCalled();
  });

  it("falls back to an in-memory session when no file path is provided", async () => {
    const session = new PiSdkSession(
      { cwd: "/tmp/project" },
      vi.fn(),
      vi.fn(),
    );

    await session.start();

    expect(mockInMemory).toHaveBeenCalledWith("/tmp/project");
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("re-activates missing custom tools before later prompts", async () => {
    mockGetActiveToolNames
      .mockReturnValueOnce(["read", "bash"])
      .mockReturnValueOnce(["read", "bash"])
      .mockReturnValueOnce(["read", "bash", "message_user"]);

    const session = new PiSdkSession(
      {
        cwd: "/tmp/project",
        customTools: [
          {
            name: "message_user",
            label: "message_user",
            description: "Send a message to the user",
            parameters: {} as ToolDefinition["parameters"],
            execute: vi.fn(async () => ({
              content: [{ type: "text" as const, text: "ok" }],
              details: {},
            })),
          } satisfies ToolDefinition,
        ],
      },
      vi.fn(),
      vi.fn(),
    );

    await session.start();
    await session.prompt("first follow-up");
    await session.prompt("second follow-up");

    expect(mockSetActiveToolsByName).toHaveBeenCalledTimes(2);
    expect(mockSetActiveToolsByName).toHaveBeenNthCalledWith(1, [
      "read",
      "bash",
      "message_user",
    ]);
    expect(mockSetActiveToolsByName).toHaveBeenNthCalledWith(2, [
      "read",
      "bash",
      "message_user",
    ]);
  });
});
