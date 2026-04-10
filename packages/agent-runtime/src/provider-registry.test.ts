import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "./provider-adapter.js";
import {
  createProviderForId,
  getProviderVisibilityMetadata,
  listAvailableProviderInfos,
} from "./provider-registry.js";

describe("provider registry", () => {
  it("creates codex provider with expected process config", () => {
    const provider = createProviderForId("codex");
    expect(provider.id).toBe("codex");
    expect(provider.process.command).toBe("codex");
    expect(provider.process.args).toEqual(["app-server"]);
  });

  it("creates claude-code provider with expected process config", () => {
    const provider = createProviderForId("claude-code");
    expect(provider.id).toBe("claude-code");
    expect(provider.process.command).toBe("node");
    expect(provider.process.args).toHaveLength(1);
    expect(provider.process.args[0]).toMatch(
      /agent-runtime\/(src|dist)\/claude-code\/bridge\/bridge\.js$/,
    );
    expect(existsSync(provider.process.args[0])).toBe(true);
  });

  it("passes the configured bridge bundle directory to bundled providers", () => {
    const claudeProvider = createProviderForId("claude-code", {
      bridgeBundleDir: "/tmp",
    });
    const piProvider = createProviderForId("pi", {
      bridgeBundleDir: "/tmp",
    });

    expect(claudeProvider.process.args[0]).toBe("/tmp/bb-claude-code-bridge.mjs");
    expect(piProvider.process.args[0]).toBe("/tmp/bb-pi-bridge.mjs");
  });

  it("creates pi provider with expected process config", () => {
    const provider = createProviderForId("pi");
    expect(provider.id).toBe("pi");
    expect(provider.process.command).toBe("node");
    expect(provider.process.args).toHaveLength(1);
    expect(provider.process.args[0]).toMatch(
      /agent-runtime\/(src|dist)\/pi\/bridge\/bridge\.js$/,
    );
    expect(existsSync(provider.process.args[0])).toBe(true);
  });

  it("rejects unsupported adapters", () => {
    expect(() => createProviderForId("pi-mono")).toThrow(
      'Unsupported provider "pi-mono"',
    );
  });

  it("lists provider catalog", () => {
    expect(listAvailableProviderInfos()).toEqual([
      {
        id: "codex",
        displayName: "Codex",
        capabilities: {
          supportsRename: true,
          supportsServiceTier: true,
        },
        available: true,
      },
      {
        id: "claude-code",
        displayName: "Claude Code",
        capabilities: {
          supportsRename: false,
          supportsServiceTier: false,
        },
        available: true,
      },
      {
        id: "pi",
        displayName: "Pi",
        capabilities: {
          supportsRename: false,
          supportsServiceTier: false,
        },
        available: true,
      },
    ]);
  });

  it("returns provider-owned visibility metadata", () => {
    const claude = getProviderVisibilityMetadata("claude-code");
    const pi = getProviderVisibilityMetadata("pi");
    const codex = getProviderVisibilityMetadata("codex");

    expect([...claude.wellKnownToolNames]).toEqual([
      "Agent",
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "Read",
      "TodoWrite",
      "ToolSearch",
      "WebFetch",
      "WebSearch",
      "Write",
    ]);
    expect([...pi.wellKnownToolNames]).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "read",
      "write",
    ]);
    expect([...codex.wellKnownToolNames]).toEqual([
      "closeAgent",
      "resumeAgent",
      "sendInput",
      "spawnAgent",
      "wait",
    ]);
  });

  it("keeps declared well-known tool names aligned with observed tool classification", () => {
    const claude = getProviderVisibilityMetadata("claude-code");
    for (const toolName of claude.wellKnownToolNames) {
      const observed = claude.extractObservedToolCalls({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          message: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: `tool-${toolName}`, name: toolName, input: {} }],
            },
          },
        },
      });
      expect(observed).toContainEqual(
        expect.objectContaining({ displayName: toolName, coverage: "well-known" }),
      );
    }

    const pi = getProviderVisibilityMetadata("pi");
    for (const toolName of pi.wellKnownToolNames) {
      const observed = pi.extractObservedToolCalls({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          message: {
            type: "tool_execution_start",
            toolName,
          },
        },
      });
      expect(observed).toContainEqual(
        expect.objectContaining({ displayName: toolName, coverage: "well-known" }),
      );
    }

    const codex = getProviderVisibilityMetadata("codex");
    for (const toolName of codex.wellKnownToolNames) {
      const observed = codex.extractObservedToolCalls({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            id: `collab-${toolName}`,
            tool: toolName,
            status: "inProgress",
            senderThreadId: "t1",
            receiverThreadIds: [],
            prompt: null,
            model: null,
            reasoningEffort: null,
            agentsStates: {},
          },
        },
      } satisfies JsonRpcMessage);
      expect(observed).toContainEqual(
        expect.objectContaining({ displayName: toolName, coverage: "well-known" }),
      );
    }
  });

  it("classifies shared handled non-sdk envelopes as normalized", () => {
    const claude = getProviderVisibilityMetadata("claude-code");
    const pi = getProviderVisibilityMetadata("pi");

    expect(claude.describeRawEvent({
      jsonrpc: "2.0",
      method: "thread/contextWindowUsage/updated",
      params: {
        threadId: "t1",
        contextWindowUsage: {
          usedTokens: 12,
          modelContextWindow: 100,
          estimated: false,
        },
      },
    })).toEqual({
      kind: "thread/contextWindowUsage/updated",
      coverage: "normalized",
    });

    expect(pi.describeRawEvent({
      jsonrpc: "2.0",
      method: "thread/contextWindowUsage/updated",
      params: {
        threadId: "t1",
        contextWindowUsage: {
          usedTokens: 12,
          modelContextWindow: 100,
          estimated: false,
        },
      },
    })).toEqual({
      kind: "thread/contextWindowUsage/updated",
      coverage: "normalized",
    });

    expect(claude.describeRawEvent({
      jsonrpc: "2.0",
      method: "error",
      params: {
        message: "provider failed",
      },
    })).toEqual({
      kind: "error",
      coverage: "normalized",
    });

    expect(pi.describeRawEvent({
      jsonrpc: "2.0",
      method: "error",
      params: {
        message: "provider failed",
      },
    })).toEqual({
      kind: "error",
      coverage: "normalized",
    });
  });

});
