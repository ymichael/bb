import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const {
  mockGetActiveToolNames,
  mockSetActiveToolsByName,
  mockOpen,
  mockInMemory,
  mockSettingsInMemory,
  mockCreateAgentSession,
  mockAbort,
  mockDispose,
  mockGetModel,
} = vi.hoisted(() => {
  const mockSubscribe = vi.fn(() => () => {});
  const mockPrompt = vi.fn();
  const mockAbort = vi.fn(async () => {});
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
      abort: mockAbort,
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
  const mockGetModel = vi.fn((provider: string, modelId: string) => ({
    id: modelId,
    provider,
  }));

  return {
    mockGetActiveToolNames,
    mockSetActiveToolsByName,
    mockOpen,
    mockInMemory,
    mockSettingsInMemory,
    mockCreateAgentSession,
    mockAbort,
    mockDispose,
    mockGetModel,
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
  getModel: mockGetModel,
}));

import { PiSdkSession } from "../sdk-session.js";

describe("PiSdkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveToolNames.mockReturnValue([]);
    mockAbort.mockResolvedValue(undefined);
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

  it("resolves openai-codex subscription models", async () => {
    const session = new PiSdkSession(
      {
        cwd: "/tmp/project",
        model: "openai-codex/gpt-5.4",
      },
      vi.fn(),
      vi.fn(),
    );

    await session.start();

    expect(mockGetModel).toHaveBeenCalledWith("openai-codex", "gpt-5.4");
    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "gpt-5.4",
          provider: "openai-codex",
        },
      }),
    );
  });

  it("forwards thinking level to the SDK when configured", async () => {
    const session = new PiSdkSession(
      {
        cwd: "/tmp/project",
        thinkingLevel: "xhigh",
      },
      vi.fn(),
      vi.fn(),
    );

    await session.start();

    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        thinkingLevel: "xhigh",
      }),
    );
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

  it("waits for abort before disposing during graceful close", async () => {
    let resolveAbort: (() => void) | undefined;
    mockAbort.mockImplementation(() =>
      new Promise<void>((resolve) => {
        resolveAbort = resolve;
      })
    );
    const session = new PiSdkSession(
      { cwd: "/tmp/project" },
      vi.fn(),
      vi.fn(),
    );

    await session.start();
    const closePromise = session.closeGracefully(1_000);
    await Promise.resolve();

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockDispose).not.toHaveBeenCalled();
    if (!resolveAbort) {
      throw new Error("Expected Pi abort promise to be pending");
    }
    resolveAbort();
    await closePromise;

    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(session.getIsProcessing()).toBe(false);
  });
});
