import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

interface MockBashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface MockBashSpawnHook {
  (context: MockBashSpawnContext): MockBashSpawnContext;
}

interface MockBashToolOptions {
  spawnHook?: MockBashSpawnHook;
}

interface MockBashToolTextContent {
  type: "text";
  text: string;
}

interface MockBashToolExecutionResult {
  content: MockBashToolTextContent[];
  details: Record<string, never>;
}

interface MockBashToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, never>;
  execute: () => Promise<MockBashToolExecutionResult>;
}

interface MockCreateBashToolDefinition {
  (cwd: string, options?: MockBashToolOptions): MockBashToolDefinition;
}

const {
  mockGetActiveToolNames,
  mockSetActiveToolsByName,
  mockCreateBashToolDefinition,
  mockDefineTool,
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
  const mockCreateBashToolDefinition = vi.fn<MockCreateBashToolDefinition>(
    (_cwd, _options) => ({
      name: "bash",
      label: "bash",
      description: "Execute a bash command",
      parameters: {},
      execute: vi.fn(
        async (): Promise<MockBashToolExecutionResult> => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
      ),
    }),
  );
  const mockDefineTool = vi.fn(<TTool>(tool: TTool): TTool => tool);
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
    mockCreateBashToolDefinition,
    mockDefineTool,
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
  createBashToolDefinition: mockCreateBashToolDefinition,
  defineTool: mockDefineTool,
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
    const session = new PiSdkSession({ cwd: "/tmp/project" }, vi.fn(), vi.fn());

    await session.start();

    expect(mockInMemory).toHaveBeenCalledWith("/tmp/project");
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("leaves Pi's built-in bash active when no shell env overrides are configured", async () => {
    const session = new PiSdkSession({ cwd: "/tmp/project" }, vi.fn(), vi.fn());

    await session.start();

    expect(mockCreateBashToolDefinition).not.toHaveBeenCalled();
  });

  it("resolves openai-codex subscription models", async () => {
    const session = new PiSdkSession(
      {
        cwd: "/tmp/project",
        model: "openai-codex/gpt-5.5",
      },
      vi.fn(),
      vi.fn(),
    );

    await session.start();

    expect(mockGetModel).toHaveBeenCalledWith("openai-codex", "gpt-5.5");
    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "gpt-5.5",
          provider: "openai-codex",
        },
      }),
    );
  });

  it("rejects unresolved explicit models before opening a Pi session", async () => {
    const session = new PiSdkSession(
      {
        cwd: "/tmp/project",
        model: "unsupported/model",
      },
      vi.fn(),
      vi.fn(),
    );

    await expect(session.start()).rejects.toThrow(
      'Failed to resolve Pi model "unsupported/model"',
    );
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
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

  it("scopes shell env overrides to the bash spawn hook without mutating process.env", async () => {
    const sessionEnvKey = "BB_PI_UNIT_SESSION_ENV";
    const processOnlyEnvKey = "BB_PI_UNIT_PROCESS_ONLY_ENV";
    const previousSessionEnvValue = process.env[sessionEnvKey];
    const previousProcessOnlyEnvValue = process.env[processOnlyEnvKey];
    delete process.env[sessionEnvKey];
    process.env[processOnlyEnvKey] = "daemon-secret";

    try {
      const session = new PiSdkSession(
        {
          cwd: "/tmp/project",
          shellEnvOverrides: {
            BB_THREAD_ID: "t1",
            [sessionEnvKey]: "thread-a",
          },
        },
        vi.fn(),
        vi.fn(),
      );

      await session.start();

      expect(process.env[sessionEnvKey]).toBeUndefined();
      expect(process.env[processOnlyEnvKey]).toBe("daemon-secret");
      expect(mockCreateBashToolDefinition).toHaveBeenCalledTimes(1);

      const bashToolCall = mockCreateBashToolDefinition.mock.calls[0];
      if (!bashToolCall) {
        throw new Error("Expected Pi bash tool to be created");
      }

      const bashToolOptions = bashToolCall[1];
      if (!bashToolOptions?.spawnHook) {
        throw new Error("Expected Pi bash tool to receive a spawn hook");
      }

      const spawnContext: MockBashSpawnContext = {
        command: "printf ok",
        cwd: "/tmp/project",
        env: {
          PATH: "/bin",
          BB_THREAD_ID: "base-thread",
        },
      };

      expect(bashToolOptions.spawnHook(spawnContext)).toEqual({
        command: "printf ok",
        cwd: "/tmp/project",
        env: {
          PATH: "/bin",
          BB_THREAD_ID: "t1",
          [sessionEnvKey]: "thread-a",
        },
      });
    } finally {
      if (previousSessionEnvValue === undefined) {
        delete process.env[sessionEnvKey];
      } else {
        process.env[sessionEnvKey] = previousSessionEnvValue;
      }
      if (previousProcessOnlyEnvValue === undefined) {
        delete process.env[processOnlyEnvKey];
      } else {
        process.env[processOnlyEnvKey] = previousProcessOnlyEnvValue;
      }
    }
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
    mockAbort.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAbort = resolve;
        }),
    );
    const session = new PiSdkSession({ cwd: "/tmp/project" }, vi.fn(), vi.fn());

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
