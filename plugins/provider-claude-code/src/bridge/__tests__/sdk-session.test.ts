import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const mockQueryInstance = {
  applyFlagSettings: vi.fn(),
  close: vi.fn(),
  interrupt: vi.fn(),
  setModel: vi.fn(),
  setPermissionMode: vi.fn(),
  [Symbol.asyncIterator]: vi.fn(),
};
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

import { SdkSession, type SdkSessionOptions } from "../sdk-session.js";

const defaultOptions: SdkSessionOptions = {
  cwd: "/tmp/test",
  systemPrompt: "You are a test assistant.",
};

interface ClaudeQueryPromptCall {
  options: Options;
  prompt: AsyncIterable<SDKUserMessage>;
}

interface RejectSdkStreamArgs {
  error: Error;
}

function isClaudeQueryPromptCall(
  value: unknown,
): value is ClaudeQueryPromptCall {
  return (
    value !== null &&
    typeof value === "object" &&
    "options" in value &&
    "prompt" in value
  );
}

function getLatestQueryCall(): ClaudeQueryPromptCall {
  const latestCall = queryMock.mock.calls.at(-1)?.[0];
  if (!isClaudeQueryPromptCall(latestCall)) {
    throw new Error("Expected Claude SDK query call");
  }
  return latestCall;
}

function getLatestPrompt(): AsyncIterable<SDKUserMessage> {
  return getLatestQueryCall().prompt;
}

function rejectSdkStream(args: RejectSdkStreamArgs): void {
  mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
    next: vi.fn().mockRejectedValue(args.error),
    return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
  });
}

function keepSdkStreamOpen(): void {
  mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
    next: vi.fn(() => new Promise<IteratorResult<SDKMessage>>(() => {})),
    return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
  });
}

function mockProcessUid(uid: number): void {
  vi.spyOn(process, "getuid").mockReturnValue(uid);
}

function waitForAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SdkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(() => mockQueryInstance);
    mockQueryInstance.applyFlagSettings.mockResolvedValue(undefined);
    mockQueryInstance.setModel.mockResolvedValue(undefined);
    mockQueryInstance.setPermissionMode.mockResolvedValue(undefined);
    mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
      next: vi.fn().mockResolvedValue({ value: undefined, done: true }),
      return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with no session id", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(defaultOptions, onMessage, onDone);
    expect(session.getSessionId()).toBeUndefined();
  });

  it("applies model and mutable flag settings to the live query", async () => {
    keepSdkStreamOpen();
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();

    await session.setModel("claude-sonnet-5");
    await session.applyMutableSettings({
      effort: "max",
      settings: {
        autoMemoryEnabled: false,
        enableWorkflows: true,
        effortLevel: "max",
        ultracode: false,
      },
    });

    expect(mockQueryInstance.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    expect(mockQueryInstance.applyFlagSettings).toHaveBeenCalledWith({
      autoMemoryEnabled: false,
      enableWorkflows: true,
      effortLevel: "max",
      ultracode: false,
    });
    session.stop();
  });

  it("resolves pushed input after the SDK prompt iterator yields it", async () => {
    keepSdkStreamOpen();
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    const promptId = "00000000-0000-0000-0000-000000000001";

    session.start();
    expect(session.canPushInput()).toBe(true);
    const consumed = session.pushInput("hello", promptId);
    let consumedResolved = false;
    void consumed.then(() => {
      consumedResolved = true;
    });
    await Promise.resolve();

    expect(consumedResolved).toBe(false);
    const result = await getLatestPrompt()[Symbol.asyncIterator]().next();
    expect(result.done).toBe(false);
    expect(result.value?.message.content).toBe("hello");
    expect(result.value?.uuid).toBe(promptId);
    await consumed;
    expect(consumedResolved).toBe(true);
    session.stop();
  });

  it("rejects queued input when the SDK input stream closes before consumption", async () => {
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    const consumed = session.pushInput("hello");

    session.stop();
    expect(session.canPushInput()).toBe(false);

    await expect(consumed).rejects.toThrow(
      "Claude SDK session stopped before input consumed",
    );
  });

  it("stop cleans up state", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(defaultOptions, onMessage, onDone);
    session.start();
    session.stop();
    expect(mockQueryInstance.close).toHaveBeenCalled();
  });

  it("waits for the SDK stream to finish during graceful close", async () => {
    let finishStream:
      | ((result: IteratorResult<SDKMessage>) => void)
      | undefined;
    const next = vi.fn(
      () =>
        new Promise<IteratorResult<SDKMessage>>((resolve) => {
          finishStream = resolve;
        }),
    );
    mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
      next,
      return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
    });
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());

    session.start();
    const closePromise = session.closeGracefully(1_000);
    await Promise.resolve();

    expect(mockQueryInstance.close).not.toHaveBeenCalled();
    if (!finishStream) {
      throw new Error("Expected Claude SDK stream to be pending");
    }
    finishStream({ value: undefined, done: true });
    await closePromise;

    expect(mockQueryInstance.close).not.toHaveBeenCalled();
  });

  it("forwards local plugins to the SDK without a skills allowlist", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        plugins: [{ type: "local", path: "/tmp/bb-skills" }],
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          plugins: [{ type: "local", path: "/tmp/bb-skills" }],
        }),
      }),
    );
    expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty("skills");
  });

  it("mirrors the Claude CLI settings cascade so user, project, and local settings all load", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(defaultOptions, onMessage, onDone);

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          settingSources: ["user", "project", "local"],
        }),
      }),
    );
  });

  it("forwards max reasoning effort and thinking display to the SDK when configured", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        effort: "max",
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          effort: "max",
          thinking: {
            type: "adaptive",
            display: "summarized",
          },
        }),
      }),
    );
  });

  it("forwards an explicit Claude Code executable path to the SDK", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        }),
      }),
    );
  });

  it("passes non-bypass permission modes through without the dangerous skip flag", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        permissionMode: "dontAsk",
        disallowedTools: ["WebFetch"],
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "dontAsk",
          disallowedTools: ["WebFetch"],
        }),
      }),
    );
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  it("only enables dangerous permission skipping for bypass mode", () => {
    mockProcessUid(1000);
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        permissionMode: "bypassPermissions",
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  it("does not send root-forbidden bypass flags when running as root", () => {
    mockProcessUid(0);
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        permissionMode: "bypassPermissions",
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "default",
        }),
      }),
    );
    expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty(
      "allowDangerouslySkipPermissions",
    );
  });

  it("includes captured Claude stderr in SDK stream failures", async () => {
    rejectSdkStream({
      error: new Error("Claude Code process exited with code 1"),
    });
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(defaultOptions, onMessage, onDone);

    session.start();
    getLatestQueryCall().options.stderr?.(
      "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n",
    );
    await waitForAsyncWork();

    const doneError = onDone.mock.calls[0]?.[0];
    if (!(doneError instanceof Error)) {
      throw new Error("Expected onDone to receive an Error");
    }
    expect(doneError.message).toContain(
      "Claude Code process exited with code 1",
    );
    expect(doneError.message).toContain("Claude Code stderr:");
    expect(doneError.message).toContain(
      "cannot be used with root/sudo privileges",
    );
  });

  it("forwards sandbox and hooks to the SDK when configured", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const hooks: NonNullable<SdkSessionOptions["hooks"]> = {
      PreToolUse: [{ hooks: [vi.fn()] }],
    };
    const session = new SdkSession(
      {
        ...defaultOptions,
        additionalDirectories: ["/repo/.git/worktrees/bb13"],
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
        },
        hooks,
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          additionalDirectories: ["/repo/.git/worktrees/bb13"],
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
          },
          hooks,
        }),
      }),
    );
  });
});
