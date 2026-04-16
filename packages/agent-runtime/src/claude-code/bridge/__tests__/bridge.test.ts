import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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
  handleLine,
} from "../bridge.js";
import { listClaudeCodeBridgeModels } from "../model-list.js";
import { createBridgeJsonRpcTestHarness } from "../../../test/bridge-json-rpc-test-helpers.js";

interface ControlledClaudeQuery {
  close: ReturnType<typeof vi.fn>;
  finish(): void;
  initializationResult: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
}

function createControlledClaudeQuery(): ControlledClaudeQuery {
  let finishNext: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  const iterator: AsyncIterator<SDKMessage> = {
    next: () =>
      new Promise<IteratorResult<SDKMessage>>((resolve) => {
        finishNext = resolve;
      }),
    return: async () => ({ value: undefined, done: true }),
  };
  return {
    close: vi.fn(),
    finish() {
      if (!finishNext) {
        throw new Error("Expected Claude query iterator to be waiting");
      }
      finishNext({ value: undefined, done: true });
      finishNext = undefined;
    },
    initializationResult: vi.fn(),
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

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
            description: "Opus 4.7 with 1M context [NEW] · Most capable for complex work",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            value: "claude-haiku-4-5",
            displayName: "Haiku",
            description: "Haiku 4.5",
          },
          {
            value: "claude-sonnet-4-6",
            displayName: "Sonnet",
            description: "Sonnet 4.6 · Best for everyday tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "claude-sonnet-4-6[1m]",
            displayName: "Sonnet (1M context)",
            description: "Sonnet 4.6 with 1M context · Billed as extra usage",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
        ],
      }),
      close: vi.fn(),
    });
  });

  it("keeps manager sessions on a plain string system prompt", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a manager.",
        cwd: "/tmp/worktree",
        instructionMode: "replace",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
    expect(options.cwd).toBe("/tmp/worktree");
    expect(options.systemPrompt).toBe("You are a manager.");
  });

  it("leaves standard sessions on the default Claude tool preset", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        reasoningLevel: "xhigh",
        permissionEscalation: "ask",
        permissionMode: "default",
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
    expect(options.effort).toBe("xhigh");
  });

  it("passes the resolved Claude permission mode through to the session", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "dontAsk",
      },
      {},
    );

    expect(options.permissionMode).toBe("dontAsk");
  });

  it("configures workspace-write sessions with Claude sandbox settings", () => {
    const askOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "acceptEdits",
      },
      {},
    );
    const denyOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "acceptEdits",
      },
      {},
    );

    expect(askOptions.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
    });
    expect(denyOptions.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
    });
  });

  it("configures readonly sessions with PreToolUse policy hooks", async () => {
    const askOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      {},
    );
    const denyOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "dontAsk",
      },
      {},
    );

    const askHook = askOptions.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!askHook) {
      throw new Error("Expected readonly ask PreToolUse hook");
    }
    await expect(
      askHook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "tool-1",
        session_id: "session-1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp/worktree",
      }, "tool-1", { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    });

    const preToolUseHook = denyOptions.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!preToolUseHook) {
      throw new Error("Expected readonly PreToolUse hook");
    }
    await expect(
      preToolUseHook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "tool-1",
        session_id: "session-1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp/worktree",
      }, "tool-1", { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("returns the bridge-owned Claude model list from the SDK probe", async () => {
    await expect(listClaudeCodeBridgeModels()).resolves.toEqual([
      expect.objectContaining({
        id: "claude-opus-4-7[1m]",
        model: "claude-opus-4-7[1m]",
        displayName: "Opus 4.7 (1M)",
        isDefault: true,
      }),
      expect.objectContaining({
        id: "claude-opus-4-7",
        model: "claude-opus-4-7",
        displayName: "Opus 4.7",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-opus-4-6[1m]",
        model: "claude-opus-4-6[1m]",
        displayName: "Opus 4.6 (1M)",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-opus-4-6",
        model: "claude-opus-4-6",
        displayName: "Opus 4.6",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-sonnet-4-6[1m]",
        model: "claude-sonnet-4-6[1m]",
        displayName: "Sonnet 4.6 (1M)",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-sonnet-4-6",
        model: "claude-sonnet-4-6",
        displayName: "Sonnet 4.6",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-haiku-4-5",
        model: "claude-haiku-4-5",
        displayName: "Haiku 4.5",
        isDefault: false,
      }),
    ]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("passes thread/start reasoningLevel through to Claude SDK effort", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        reasoningLevel: "xhigh",
        threadId: "thread-reasoning",
      });
      await bridge.waitForResponse(1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            effort: "xhigh",
          }),
        }),
      );

      bridge.sendRequest(2, "thread/stop", { threadId: "thread-reasoning" });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("holds thread stop open until the Claude SDK stream closes", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        threadId: "thread-stop-waits",
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "thread/stop", { threadId: "thread-stop-waits" });
      await bridge.flushWork();

      expect(bridge.hasResponse(2)).toBe(false);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.close).not.toHaveBeenCalled();

      queries[0]?.finish();
      await expect(bridge.waitForResponse(2)).resolves.toMatchObject({
        id: 2,
        result: { ok: true },
      });
      expect(queries[0]?.close).not.toHaveBeenCalled();
    } finally {
      bridge.restore();
    }
  });

  it("waits for an in-flight close before replacing the same thread", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(11, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        threadId: "thread-overlap",
      });
      await bridge.waitForResponse(11);

      bridge.sendRequest(12, "thread/stop", { threadId: "thread-overlap" });
      await bridge.flushWork();
      bridge.sendRequest(13, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        threadId: "thread-overlap",
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(12)).toBe(false);
      expect(bridge.hasResponse(13)).toBe(false);
      expect(queries).toHaveLength(1);

      queries[0]?.finish();
      await expect(bridge.waitForResponse(12)).resolves.toMatchObject({
        id: 12,
        result: { ok: true },
      });
      await expect(bridge.waitForResponse(13)).resolves.toMatchObject({
        id: 13,
      });
      expect(queries).toHaveLength(2);

      bridge.sendRequest(14, "thread/stop", { threadId: "thread-overlap" });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(14);
    } finally {
      bridge.restore();
    }
  });
});
