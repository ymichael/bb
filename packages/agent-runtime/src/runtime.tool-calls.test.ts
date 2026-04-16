import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import type { AgentRuntimeCaptureEntry } from "./capture-types.js";
import { createAgentRuntimeWithAdapters } from "./runtime.js";
import { fakeProviderScriptPath } from "./test/index.js";
import {
  createFakeAdapter,
  createThreadHintMismatchAdapter,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadTurnCompleted,
} from "./test/runtime-test-harness.js";

describe("createAgentRuntime tool calls", () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
    scriptPath = fakeProviderScriptPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes provider-scoped tool calls through onToolCall and sends response back", async () => {
    const toolCalls: Array<{ threadId: string; providerThreadId: string; tool: string }> = [];
    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async (req) => {
        toolCalls.push({
          threadId: req.threadId,
          providerThreadId: req.providerThreadId,
          tool: req.tool,
        });
        return {
          contentItems: [{ type: "inputText", text: "tool result" }],
          success: true,
        };
      },
      adapterFactory: () => createFakeAdapter(scriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "call_tool:my_test_tool" }],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      events,
      label: "tool call routed and turn completed",
      predicate: () =>
        toolCalls.length === 1
        && events.some((event) => event.type === "turn/completed"),
      providerId: "fake",
      runtime,
    });

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      threadId: "t1",
      providerThreadId: "prov-1",
      tool: "my_test_tool",
    });
    await runtime.shutdown();
  });

  it("rejects tool calls whose BB thread hint disagrees with the provider-thread mapping", async () => {
    const toolCalls: string[] = [];
    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (event) => events.push(event),
      onToolCall: async (req) => {
        toolCalls.push(req.tool);
        return {
          contentItems: [{ type: "inputText", text: "tool result" }],
          success: true,
        };
      },
      adapterFactory: () => createThreadHintMismatchAdapter(scriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "call_tool:my_test_tool" }],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });

    expect(toolCalls).toEqual([]);
    await runtime.shutdown();
  });

  it("sends JSON-RPC error back when onToolCall throws", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: (e) => events.push(e),
      onToolCall: async () => {
        throw new Error("Tool execution failed");
      },
      adapterFactory: () => createFakeAdapter(scriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    // This should not throw — the error is caught and sent as JSON-RPC error
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "call_tool:failing_tool" }],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    await runtime.shutdown();
    // The test passes if no unhandled promise rejection occurs
  });

  it("captures correlated raw provider events, translated events, and tool call results", async () => {
    const captures: AgentRuntimeCaptureEntry[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath: tmpDir,
      onEvent: () => {},
      onCapture: (entry) => captures.push(entry),
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "tool result" }],
        success: true,
      }),
      adapterFactory: () => createFakeAdapter(scriptPath),
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      input: [{ type: "text", text: "call_tool:my_test_tool" }],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "captured tool result and raw turn completion",
      predicate: () =>
        captures.some((entry) => entry.kind === "tool-call-result")
        && captures.some(
          (entry) =>
            entry.kind === "raw-provider-event"
            && entry.rawEvent.method === "turn/completed",
        ),
      providerId: "fake",
      runtime,
    });
    await runtime.shutdown();

    const rawEvents = captures.filter(
      (entry): entry is Extract<AgentRuntimeCaptureEntry, { kind: "raw-provider-event" }> =>
        entry.kind === "raw-provider-event",
    );
    const translatedEvents = captures.filter(
      (entry): entry is Extract<AgentRuntimeCaptureEntry, { kind: "translated-thread-event" }> =>
        entry.kind === "translated-thread-event",
    );
    const toolRequests = captures.filter(
      (entry): entry is Extract<AgentRuntimeCaptureEntry, { kind: "tool-call-request" }> =>
        entry.kind === "tool-call-request",
    );
    const toolResults = captures.filter(
      (entry): entry is Extract<AgentRuntimeCaptureEntry, { kind: "tool-call-result" }> =>
        entry.kind === "tool-call-result",
    );

    expect(rawEvents.map((entry) => entry.rawEvent.method)).toEqual(
      expect.arrayContaining(["thread/identity", "turn/started", "item/completed", "turn/completed"]),
    );
    expect(translatedEvents.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining(["thread/identity", "turn/started", "item/completed", "turn/completed"]),
    );
    expect(toolRequests).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(toolRequests[0]?.request).toMatchObject({
      threadId: "t1",
      providerThreadId: "prov-1",
      tool: "my_test_tool",
    });
    expect(toolResults[0]).toMatchObject({
      requestCaptureId: toolRequests[0]?.captureId,
      requestId: toolRequests[0]?.request.requestId,
      success: true,
    });

    const turnStartedCapture = rawEvents.find((entry) => entry.rawEvent.method === "turn/started");
    expect(turnStartedCapture).toBeDefined();
    expect(
      translatedEvents.some(
        (entry) =>
          entry.rawCaptureId === turnStartedCapture?.captureId &&
          entry.event.type === "turn/started",
      ),
    ).toBe(true);
  });

  // ---- Error handling ----

});
