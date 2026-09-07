import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent, ToolCallResponse } from "@bb/domain";
import { createProviderForId } from "./provider-registry.js";
import { handleRuntimeProviderRequest } from "./runtime-provider-requests.js";
import {
  parseJsonRpcLine,
  type JsonRpcMessage,
} from "@bb/provider-bridge-protocol/bridge-kit";
import { promptTextInput } from "./test/prompt-input.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadTurnCompleted,
  waitForThreadTurnStarted,
} from "./test/runtime-test-harness.js";

type ChildStdoutChunk = Buffer | string;

function readChildStdoutLine(child: ChildProcess): Promise<string> {
  if (!child.stdout) {
    throw new Error("Expected child stdout to be readable");
  }
  const stdout = child.stdout;
  return new Promise((resolve) => {
    stdout.once("data", (chunk: ChildStdoutChunk) => {
      resolve(String(chunk));
    });
  });
}

function createBridgeAdapter() {
  return createProviderForId("fake", {
    additionalWorkspaceWriteRoots: [],
    bridgeLaunch: createScriptedEchoLaunch(),
  });
}

describe("createAgentRuntime tool calls", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes provider-scoped tool calls through onToolCall and sends response back", async () => {
    const toolCalls: Array<{
      threadId: string;
      providerThreadId: string;
      turnId: string;
      tool: string;
    }> = [];
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async (req) => {
          toolCalls.push({
            threadId: req.threadId,
            providerThreadId: req.providerThreadId,
            turnId: req.turnId,
            tool: req.tool,
          });
          return {
            contentItems: [{ type: "inputText", text: "tool result" }],
            success: true,
          };
        },
      },
    });

    const { providerThreadId } = await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222223z",
      threadId: "t1",
      input: [promptTextInput({ text: "call_tool:my_test_tool" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    await waitForRuntimeState({
      events,
      label: "tool call routed and turn completed",
      predicate: () =>
        toolCalls.length === 1 &&
        events.some((event) => event.type === "turn/completed"),
      providerId: "fake",
      runtime,
    });

    expect(toolCalls).toEqual([
      { threadId: "t1", providerThreadId, turnId, tool: "my_test_tool" },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: "Tool called: my_test_tool",
        }),
      }),
    );
    await runtime.shutdown();
  });

  it("resolves unresolved provider tool call turn ids from the active turn", async () => {
    const toolCalls: Array<{ turnId: string; tool: string }> = [];
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async (req) => {
          toolCalls.push({ turnId: req.turnId, tool: req.tool });
          return {
            contentItems: [{ type: "inputText", text: "tool result" }],
            success: true,
          };
        },
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222223y",
      threadId: "t1",
      input: [promptTextInput({ text: "call_tool_unresolved:my_test_tool" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    await waitForRuntimeState({
      events,
      label: "tool call with resolved turn id routed and turn completed",
      predicate: () =>
        toolCalls.length === 1 &&
        events.some((event) => event.type === "turn/completed"),
      providerId: "fake",
      runtime,
    });

    expect(toolCalls).toEqual([{ turnId, tool: "my_test_tool" }]);
    await runtime.shutdown();
  });

  it("drops unresolved provider tool calls when no active turn is known", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ]);
    const adapter = createBridgeAdapter();
    const toolCallResponse = {
      contentItems: [{ type: "inputText", text: "tool result" }],
      success: true,
    } satisfies ToolCallResponse;
    const onToolCall = vi.fn(async () => toolCallResponse);
    const rawRequest = {
      jsonrpc: "2.0",
      id: 42,
      method: "item/tool/call",
      params: {
        providerThreadId: "prov-1",
        turnId: null,
        callId: "call-1",
        tool: "my_test_tool",
        arguments: {},
      },
    } satisfies JsonRpcMessage;

    try {
      handleRuntimeProviderRequest({
        getActiveTurnId: () => null,
        getThreadExecutionOptions: () => undefined,
        onInteractiveRequest: async () => ({
          decision: "deny",
        }),
        onToolCall,
        parsedId: rawRequest.id,
        parsedMethod: rawRequest.method,
        providerProcess: {
          adapter,
          child,
          interactiveRequestScope: "scope-1",
        },
        rawRequest,
        resolveThreadId: () => "t1",
      });

      const parsed = parseJsonRpcLine(
        (await readChildStdoutLine(child)).trim(),
      );
      if (parsed.kind !== "response") {
        throw new Error(`Expected JSON-RPC response, got ${parsed.kind}`);
      }
      expect(parsed.parsed).toMatchObject({
        jsonrpc: "2.0",
        id: 42,
        error: {
          code: -32000,
          message: expect.stringContaining("without a turn id"),
        },
      });
      expect(onToolCall).not.toHaveBeenCalled();
    } finally {
      child.kill();
    }
  });

  it("rejects malformed tool calls with empty turn ids", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.pipe(process.stdout)",
    ]);
    const adapter = createBridgeAdapter();
    const toolCallResponse = {
      contentItems: [{ type: "inputText", text: "tool result" }],
      success: true,
    } satisfies ToolCallResponse;
    const onToolCall = vi.fn(async () => toolCallResponse);
    const rawRequest = {
      jsonrpc: "2.0",
      id: 43,
      method: "item/tool/call",
      params: {
        providerThreadId: "prov-1",
        turnId: "",
        callId: "call-1",
        tool: "my_test_tool",
        arguments: {},
      },
    } satisfies JsonRpcMessage;

    try {
      handleRuntimeProviderRequest({
        getActiveTurnId: () => "turn-1",
        getThreadExecutionOptions: () => undefined,
        onInteractiveRequest: async () => ({
          decision: "deny",
        }),
        onToolCall,
        parsedId: rawRequest.id,
        parsedMethod: rawRequest.method,
        providerProcess: {
          adapter,
          child,
          interactiveRequestScope: "scope-1",
        },
        rawRequest,
        resolveThreadId: () => "t1",
      });

      const parsed = parseJsonRpcLine(
        (await readChildStdoutLine(child)).trim(),
      );
      if (parsed.kind !== "response") {
        throw new Error(`Expected JSON-RPC response, got ${parsed.kind}`);
      }
      expect(parsed.parsed).toMatchObject({
        jsonrpc: "2.0",
        id: 43,
        error: { code: expect.any(Number) },
      });
      expect(onToolCall).not.toHaveBeenCalled();
    } finally {
      child.kill();
    }
  });

  it("rejects tool calls whose BB thread hint disagrees with the provider-thread mapping", async () => {
    const toolCalls: string[] = [];
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        onToolCall: async (req) => {
          toolCalls.push(req.tool);
          return {
            contentItems: [{ type: "inputText", text: "tool result" }],
            success: true,
          };
        },
      },
      launch: { scripted: { toolCallThreadIdHint: "thr_wrong" } },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_2222222242",
      threadId: "t1",
      input: [promptTextInput({ text: "call_tool:my_test_tool" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });

    expect(toolCalls).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        status: "failed",
      }),
    );
    await runtime.shutdown();
  });

  it("sends JSON-RPC error back when onToolCall throws", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (e) => events.push(e),
        onToolCall: async () => {
          throw new Error("Tool execution failed");
        },
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_2222222243",
      threadId: "t1",
      input: [promptTextInput({ text: "call_tool:failing_tool" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        threadId: "t1",
        message: expect.stringContaining("Tool execution failed"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        status: "failed",
      }),
    );
    await runtime.shutdown();
  });
});
