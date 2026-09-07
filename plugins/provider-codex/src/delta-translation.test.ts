import { describe, expect, it } from "vitest";
import { threadScope, turnScope, type ThreadEvent } from "@bb/domain";
import {
  experimental_COMPACTION_PRESENTATION as COMPACTION_PRESENTATION,
  experimental_REASONING_PRESENTATION as REASONING_PRESENTATION,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { DeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ServerNotification as CodexServerNotification } from "./generated/codex-app-server/schema/ServerNotification.js";
import type { RateLimitSnapshot } from "./generated/codex-app-server/schema/v2/RateLimitSnapshot.js";
import type { Turn } from "./generated/codex-app-server/schema/v2/Turn.js";
import {
  AGENT_MESSAGE_PRESENTATION,
  PLAN_PRESENTATION,
} from "./presentation.js";
import {
  applyCodexRateLimitUpdate,
  createCodexEventTranslationState,
} from "./delta-translation.js";
import {
  createCodexEventTranslator,
  type CodexEventTranslator,
} from "./translator.js";
import { codexRateLimitReadResponseSchema } from "./schemas.js";

const THREAD_ID = "t-codex-translation";
const ENTROPY = "cx-test";
const ITEM_ID_PATTERN = /^cx-test-i\d+$/;

const IMAGE_PRESENTATION = {
  label: { pending: "Viewing image", completed: "Viewed image" },
  icon: { glyph: "Eye" },
  title: "image.png",
};

function webSearchPresentation(query: string) {
  return {
    label: { pending: "Searching the web", completed: "Searched the web" },
    icon: { glyph: "Globe" },
    title: query,
  };
}

function webFetchPresentation(url: string) {
  return {
    label: { pending: "Fetching page", completed: "Fetched page" },
    icon: { glyph: "Browser" },
    title: url,
  };
}

function codexEvent<M extends CodexServerNotification["method"]>(
  method: M,
  params: Extract<CodexServerNotification, { method: M }>["params"],
) {
  return { jsonrpc: "2.0" as const, method, params };
}

function codexRateLimitSnapshot(
  overrides: Partial<RateLimitSnapshot>,
): RateLimitSnapshot {
  return {
    limitId: "codex",
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
    ...overrides,
  };
}

function codexTurn(args: {
  id: string;
  status: Turn["status"];
  error: Turn["error"];
}): Turn {
  return {
    id: args.id,
    items: [],
    itemsView: "full",
    status: args.status,
    error: args.error,
    startedAt: 0,
    completedAt: null,
    durationMs: null,
  };
}

interface CodexEquivalenceHarness {
  assembler: DeltaAssembler;
  translator: CodexEventTranslator;
  translate(
    event: Parameters<CodexEventTranslator["translateEvent"]>[0],
  ): ThreadEvent[];
  turnId(codexTurnId: string): string;
  itemId(codexItemId: string): string;
}

function createHarness(): CodexEquivalenceHarness {
  const translator = createCodexEventTranslator({
    additionalWorkspaceWriteRoots: [],
  });
  const assembler = createDeltaAssembler({
    providerId: "codex",
    entropyPrefix: ENTROPY,
    textDeltaFlushMs: 0,
  });
  return {
    assembler,
    translator,
    translate(event) {
      return assembler.assemble({
        threadId: THREAD_ID,
        deltas: translator.translateEvent(event),
      });
    },
    turnId(codexTurnId) {
      return assembler.getBbTurnId(THREAD_ID, codexTurnId) ?? "";
    },
    itemId(codexItemId) {
      return assembler.getBbItemId(THREAD_ID, codexItemId) ?? "";
    },
  };
}

describe("codex turn lifecycle translation", () => {
  it("translates turn/started into a keyed turn/started", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("turn/started", {
        threadId: "t1",
        turn: codexTurn({ id: "turn-1", status: "inProgress", error: null }),
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("turn-1")),
      }),
    ]);
  });

  it("accepts legacy Codex bridge envelopes without jsonrpc", () => {
    const harness = createHarness();
    const events = harness.translate({
      method: "turn/started",
      params: {
        threadId: "t1",
        turn: codexTurn({ id: "turn-1", status: "inProgress", error: null }),
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(harness.turnId("turn-1")),
      }),
    );
  });

  it("surfaces malformed handled Codex events as provider/unhandled", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "t1",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "turn/started",
      }),
    );
  });

  it("ignores resolved Codex server requests", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("serverRequest/resolved", {
        threadId: "t1",
        requestId: 0,
      }),
    );

    expect(events).toEqual([]);
  });

  it("suppresses automatic review lifecycle notifications", () => {
    const harness = createHarness();

    for (const method of [
      "item/autoApprovalReview/started",
      "item/autoApprovalReview/completed",
    ]) {
      expect(
        harness.translate({
          jsonrpc: "2.0",
          method,
          params: {
            threadId: "t1",
            turnId: "turn-1",
            reviewId: "review-1",
          },
        }),
      ).toEqual([]);
    }
  });

  it("translates a failed turn/completed without claiming a fork checkpoint", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: codexTurn({
          id: "turn-1",
          status: "failed",
          error: {
            message: "rate limited",
            codexErrorInfo: null,
            additionalDetails: "try again",
          },
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(harness.turnId("turn-1")),
        status: "failed",
        error: { message: "rate limited" },
      }),
    );
    expect(events[0]).not.toHaveProperty("providerCheckpointId");
  });

  it("stamps the codex turn id as providerCheckpointId on completed turns", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: codexTurn({ id: "turn-1", status: "completed", error: null }),
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "turn/completed",
        status: "completed",
        providerCheckpointId: "turn-1",
      }),
    ]);
  });

  it("maps interrupted turn status with its fork checkpoint", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: codexTurn({ id: "turn-1", status: "interrupted", error: null }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        status: "interrupted",
        providerCheckpointId: "turn-1",
      }),
    );
  });
});

describe("codex thread lifecycle translation", () => {
  it("translates thread/started into started + identity + name", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("thread/started", {
        thread: {
          id: "codex-uuid-123",
          sessionId: "session-1",
          forkedFromId: null,
          parentThreadId: null,
          preview: "Fix the tests",
          ephemeral: false,

          section: null,

          sectionEnteredAt: null,

          projectId: null,
          modelProvider: "openai",
          createdAt: 0,
          updatedAt: 0,
          recencyAt: null,
          status: { type: "idle" },
          path: null,
          cwd: "/tmp",
          cliVersion: "0.1",
          source: "appServer",
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "thread/started" }),
      expect.objectContaining({
        type: "thread/identity",
        providerThreadId: "codex-uuid-123",
      }),
      expect.objectContaining({
        type: "thread/name/updated",
        threadName: "Fix the tests",
      }),
    ]);
  });

  it("translates thread/name/updated", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("thread/name/updated", {
        threadId: "t1",
        threadName: "Updated title",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/name/updated",
        threadName: "Updated title",
      }),
    );
  });

  it("ignores thread/name/updated with an empty name", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("thread/name/updated", { threadId: "t1" }),
    );
    expect(events).toHaveLength(0);
  });

  it("ignores native archive acknowledgements", () => {
    const harness = createHarness();

    expect(
      harness.translate(codexEvent("thread/archived", { threadId: "t1" })),
    ).toEqual([]);
    expect(
      harness.translate(codexEvent("thread/unarchived", { threadId: "t1" })),
    ).toEqual([]);
  });

  it("maps native thread goal notifications to the codex goal state", () => {
    const harness = createHarness();

    expect(
      harness.translate(codexEvent("thread/goal/cleared", { threadId: "t1" })),
    ).toEqual([
      {
        type: "thread/extensionState/updated",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        kind: "provider-codex/goal",
        payload: null,
      },
    ]);
    expect(
      harness.translate(
        codexEvent("thread/goal/updated", {
          threadId: "t1",
          turnId: null,
          goal: {
            threadId: "t1",
            objective: "Finish the task",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        }),
      ),
    ).toEqual([
      {
        type: "thread/extensionState/updated",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        kind: "provider-codex/goal",
        payload: {
          objective: "Finish the task",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        },
      },
    ]);
  });

  it("translates thread/compacted scoped to its vouched turn", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("thread/compacted", { threadId: "t1", turnId: "turn-1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        scope: turnScope(harness.turnId("turn-1")),
      }),
    );
  });
});

describe("codex item translation", () => {
  it("translates item/started with agentMessage", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "Hello",
          phase: null,
          memoryCitation: null,
          delivery: null,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("turn-1")),
        item: {
          type: "agentMessage",
          id: harness.itemId("item-1"),
          text: "Hello",
          presentation: AGENT_MESSAGE_PRESENTATION,
        },
      }),
    );
  });

  it("suppresses item/started with userMessage as a provider echo", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: {
          type: "userMessage",
          id: "user-1",
          clientId: null,
          content: [
            { type: "text", text: "hello", text_elements: [] },
            { type: "image", url: "https://example.com/image.png" },
            { type: "localImage", path: "/tmp/image.png" },
            { type: "skill", name: "repo-research", path: "/tmp/SKILL.md" },
          ],
        },
      }),
    );
    expect(events).toMatchObject([]);
  });

  it("maps imageView items on start and completion", () => {
    const harness = createHarness();
    const started = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: { type: "imageView", id: "image-1", path: "/tmp/image.png" },
      }),
    );
    expect(started).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("turn-1")),
        item: {
          type: "imageView",
          id: harness.itemId("image-1"),
          path: "/tmp/image.png",
          presentation: IMAGE_PRESENTATION,
        },
      }),
    );

    const completed = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: { type: "imageView", id: "image-1", path: "/tmp/image.png" },
      }),
    );
    expect(completed).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-1")),
        item: {
          type: "imageView",
          id: harness.itemId("image-1"),
          path: "/tmp/image.png",
          presentation: IMAGE_PRESENTATION,
        },
      }),
    );
  });

  it("falls back to thread-scoped provider/unhandled for unknown notifications", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "t1",
        turnId: "turn-1",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "item/tool/requestUserInput",
        scope: threadScope(),
      }),
    );
  });

  it("ignores Codex turn moderation metadata", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "turn/moderationMetadata",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        metadata: {
          prompt: {},
          generation: {},
          tool_call: {},
          tool_response: {},
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("ignores Codex raw response completions", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "rawResponse/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        responseId: "response-1",
        usage: {
          totalTokens: 19_206,
          inputTokens: 18_971,
          cachedInputTokens: 11_008,
          cacheWriteInputTokens: 0,
          outputTokens: 235,
          reasoningOutputTokens: 53,
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("maps item/mcpToolCall/progress to shared tool progress", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/mcpToolCall/progress", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "mcp-1",
        message: "Connecting to MCP server",
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        scope: turnScope(harness.turnId("turn-1")),
        message: "Connecting to MCP server",
      }),
    );
  });

  it("maps completed commandExecution status and output fields", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          pluginId: null,
          scriptPath: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "file1\nfile2",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-1")),
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("cmd-1"),
          command: "ls -la",
          status: "completed",
          aggregatedOutput: "file1\nfile2",
          exitCode: 0,
          durationMs: 150,
        }),
      }),
    );
  });

  it("maps a declined commandExecution to an approval denial", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          pluginId: null,
          scriptPath: null,
          source: "agent",
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          status: "interrupted",
          approvalStatus: "denied",
        }),
      }),
    );
  });

  it("normalizes started commandExecutions to pending with no approval verdict", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          pluginId: null,
          scriptPath: null,
          source: "agent",
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "ls -la",
          status: "pending",
          approvalStatus: null,
        }),
      }),
    );
  });

  it("maps fileChange kinds and diffs", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "fileChange",
          id: "fc-1",
          changes: [
            {
              path: "src/foo.ts",
              kind: { type: "update", move_path: null },
              diff: "+line",
            },
            { path: "src/bar.ts", kind: { type: "add" }, diff: "" },
          ],
          status: "completed",
        },
      }),
    );
    const itemEvent = events.find((event) => event.type === "item/completed");
    expect(itemEvent).toBeDefined();
    if (
      itemEvent?.type === "item/completed" &&
      itemEvent.item.type === "fileChange"
    ) {
      expect(itemEvent.item.changes).toEqual([
        { path: "src/foo.ts", kind: "update", diff: "+line" },
        { path: "src/bar.ts", kind: "add" },
      ]);
      expect(itemEvent.item.status).toBe("completed");
    }
  });

  it("maps a declined fileChange to an approval denial", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "fileChange",
          id: "edit-1",
          status: "declined",
          changes: [{ path: "new.txt", kind: { type: "add" }, diff: "+hello" }],
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "fileChange",
          status: "interrupted",
          approvalStatus: "denied",
        }),
      }),
    );
  });

  it("maps mcpToolCall to toolCall with server and duration", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "myserver",
          tool: "search",
          pluginId: null,
          appContext: null,
          readOnlyHint: null,
          status: "completed",
          arguments: { query: "test" },
          result: null,
          error: null,
          durationMs: 200,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-1")),
        item: expect.objectContaining({
          type: "toolCall",
          id: harness.itemId("mcp-1"),
          server: "myserver",
          tool: "search",
          arguments: { query: "test" },
          status: "completed",
          durationMs: 200,
        }),
      }),
    );
  });

  it("maps dynamicToolCall to toolCall with textual results", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "dynamicToolCall",
          id: "dyn-1",
          namespace: null,
          tool: "bb_test_ping",
          arguments: {},
          status: "completed",
          contentItems: [{ type: "inputText", text: "PONG_FROM_TOOL" }],
          success: true,
          durationMs: 3,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "bb_test_ping",
          status: "completed",
          result: "PONG_FROM_TOOL",
          durationMs: 3,
        }),
      }),
    );
  });

  it("stamps bb-injected tool calls with server bb and the definition's presentation", () => {
    const harness = createHarness();
    harness.translator.configureInjectedTools([
      {
        name: "bb_workflow_run",
        presentation: {
          label: {
            pending: "Starting workflow",
            completed: "Started workflow",
          },
          icon: { glyph: "Workflow" },
        },
      },
    ]);
    const injected = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: {
          type: "dynamicToolCall",
          id: "dyn-bb-1",
          namespace: null,
          tool: "bb_workflow_run",
          arguments: { name: "review" },
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      }),
    );
    expect(injected).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: {
          type: "toolCall",
          id: harness.itemId("dyn-bb-1"),
          server: "bb",
          tool: "bb_workflow_run",
          arguments: { name: "review" },
          status: "pending",
          presentation: {
            label: {
              pending: "Starting workflow",
              completed: "Started workflow",
            },
            icon: { glyph: "Workflow" },
          },
        },
      }),
    );

    const native = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: {
          type: "dynamicToolCall",
          id: "dyn-native-1",
          namespace: null,
          tool: "codex_native_tool",
          arguments: {},
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      }),
    );
    expect(native).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "codex_native_tool",
          presentation: {
            label: {
              pending: "Running codex_native_tool",
              completed: "Ran codex_native_tool",
            },
            icon: { glyph: "Toolbox" },
          },
        }),
      }),
    );
    expect(
      native.some(
        (event) =>
          event.type === "item/started" &&
          event.item.type === "toolCall" &&
          event.item.server !== undefined,
      ),
    ).toBe(false);
  });

  it("preserves textual errors on failed dynamicToolCalls", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn-err-1",
          namespace: null,
          tool: "bb_test_ping",
          arguments: {},
          status: "failed",
          contentItems: [{ type: "inputText", text: "permission denied" }],
          success: false,
          durationMs: 8,
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          status: "failed",
          result: "permission denied",
          error: "permission denied",
        }),
      }),
    );
  });

  it("keeps readable output for image-only dynamicToolCalls", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "dynamicToolCall",
          id: "dyn-img-1",
          namespace: null,
          tool: "bb_test_image",
          arguments: {},
          status: "failed",
          contentItems: [
            {
              type: "inputImage",
              imageUrl: "https://example.com/tool-result.png",
            },
          ],
          success: false,
          durationMs: 4,
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          status: "failed",
          result: "[image: https://example.com/tool-result.png]",
          error: "[image: https://example.com/tool-result.png]",
        }),
      }),
    );
  });

  it("maps a collabAgentToolCall that names its child to a delegation", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "t1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: "Inspect the docs directory",
          model: "gpt-5.4",
          reasoningEffort: "medium",
          agentsStates: {
            "sub-thread-1": { status: "completed", message: "done" },
          },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: {
          type: "delegation",
          id: harness.itemId("collab-1"),
          childRef: "sub-thread-1",
          label: "Inspect the docs directory",
          status: "completed",
          background: false,
          summary: 'sub-thread-1: {"status":"completed","message":"done"}',
          presentation: {
            label: { pending: "Spawning agent", completed: "Spawned agent" },
            icon: { glyph: "UserRound" },
            title: "Inspect the docs directory",
          },
        },
      }),
    );
  });

  it("keeps a collabAgentToolCall without a receiver a generic tool call", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "collabAgentToolCall",
          id: "collab-wait-1",
          tool: "wait",
          status: "completed",
          senderThreadId: "t1",
          receiverThreadIds: [],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "wait",
          status: "completed",
          arguments: { senderThreadId: "t1", receiverThreadIds: [] },
          result: {},
          presentation: {
            label: {
              pending: "Waiting for agents",
              completed: "Waited for agents",
            },
            icon: { glyph: "UserRound" },
          },
        }),
      }),
    );
  });

  it("maps a declined collabAgentToolCall to interrupted", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-declined-1",
          tool: "spawnAgent",
          status: "declined",
          senderThreadId: "t1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "delegation",
          childRef: "sub-thread-1",
          label: "Spawn agent",
          status: "interrupted",
        }),
      }),
    );
  });

  it("maps completed reasoning items", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: ["Read the search flow"],
          content: ["Investigated the search sidebar state machine."],
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: {
          type: "reasoning",
          id: harness.itemId("reasoning-1"),
          summary: ["Read the search flow"],
          content: ["Investigated the search sidebar state machine."],
          presentation: REASONING_PRESENTATION,
        },
      }),
    );
  });

  it("maps completed plan items", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "plan",
          id: "plan-1",
          text: "1. Read the file\n2. Edit the function",
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: {
          type: "plan",
          id: harness.itemId("plan-1"),
          text: "1. Read the file\n2. Edit the function",
          presentation: PLAN_PRESENTATION,
        },
      }),
    );
  });

  it("maps started contextCompaction items", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("turn-1")),
        item: {
          type: "contextCompaction",
          id: harness.itemId("compact-1"),
          presentation: COMPACTION_PRESENTATION,
        },
      }),
    );
  });
});

describe("codex web item translation", () => {
  it("maps completed search actions to webSearch", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "webSearch",
          id: "web-1",
          query: "react suspense",
          results: null,
          action: { type: "search", query: "react suspense", queries: null },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: {
          type: "webSearch",
          id: harness.itemId("web-1"),
          queries: ["react suspense"],
          resultText: null,
          presentation: webSearchPresentation("react suspense"),
        },
      }),
    );
  });

  it("merges query fields on started search actions", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: {
          type: "webSearch",
          id: "web-start-1",
          query: "react suspense fallback",
          results: null,
          action: {
            type: "search",
            query: "react suspense primary",
            queries: ["react suspense primary", "react suspense secondary"],
          },
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: {
          type: "webSearch",
          id: harness.itemId("web-start-1"),
          queries: [
            "react suspense primary",
            "react suspense secondary",
            "react suspense fallback",
          ],
          resultText: null,
          presentation: webSearchPresentation("react suspense primary"),
        },
      }),
    );
  });

  it("maps openPage actions to webFetch on start and completion", () => {
    const harness = createHarness();
    const started = harness.translate(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        startedAtMs: 0,
        item: {
          type: "webSearch",
          id: "web-open-1",
          query: "ignored fallback",
          results: null,
          action: { type: "openPage", url: "https://example.com" },
        },
      }),
    );
    expect(started).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: {
          type: "webFetch",
          id: harness.itemId("web-open-1"),
          url: "https://example.com",
          prompt: null,
          pattern: null,
          resultText: null,
          presentation: webFetchPresentation("https://example.com"),
        },
      }),
    );

    const completed = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "webSearch",
          id: "web-open-1",
          query: "https://example.com",
          results: null,
          action: { type: "openPage", url: "https://example.com" },
        },
      }),
    );
    expect(completed).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "webFetch",
          id: harness.itemId("web-open-1"),
          url: "https://example.com",
        }),
      }),
    );
    expect(completed).not.toContainEqual(
      expect.objectContaining({ type: "provider/unhandled" }),
    );
  });

  it("maps findInPage actions to webFetch with the pattern", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "webSearch",
          id: "web-find-1",
          query: "https://example.com",
          results: null,
          action: {
            type: "findInPage",
            url: "https://example.com",
            pattern: "Example Domain",
          },
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: {
          type: "webFetch",
          id: harness.itemId("web-find-1"),
          url: "https://example.com",
          prompt: null,
          pattern: "Example Domain",
          resultText: null,
          presentation: webFetchPresentation("https://example.com"),
        },
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "provider/unhandled" }),
    );
  });

  it("ignores placeholder webSearch items without canonical details", () => {
    const harness = createHarness();
    expect(
      harness.translate(
        codexEvent("item/started", {
          threadId: "t1",
          turnId: "turn-1",
          startedAtMs: 0,
          item: {
            type: "webSearch",
            id: "web-placeholder-1",
            query: "",
            results: null,
            action: { type: "other" },
          },
        }),
      ),
    ).toMatchObject([]);
    expect(
      harness.translate(
        codexEvent("item/completed", {
          threadId: "t1",
          turnId: "turn-1",
          completedAtMs: 0,
          item: {
            type: "webSearch",
            id: "web-placeholder-completed-1",
            query: "",
            results: null,
            action: null,
          },
        }),
      ),
    ).toMatchObject([]);
  });

  it("falls back to provider/unhandled for openPage actions without a url", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        completedAtMs: 0,
        item: {
          type: "webSearch",
          id: "web-open-missing-url-1",
          query: "not-a-url",
          results: null,
          action: { type: "openPage", url: null },
        },
      }),
    );

    expect(
      events.some(
        (event) =>
          event.type === "provider/unhandled" &&
          event.rawType === "item/completed" &&
          event.scope.kind === "turn",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "item/completed" && event.item.type === "webFetch",
      ),
    ).toBe(false);
  });
});

describe("codex delta and usage translation", () => {
  it("synthesizes item/started for a delta-first agent message and keeps the id", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/agentMessage/delta", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello ",
      }),
    );
    const itemId = harness.itemId("item-1");
    expect(itemId).toMatch(ITEM_ID_PATTERN);
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(harness.turnId("turn-1")),
        item: { type: "agentMessage", id: itemId, text: "" },
      }),
      expect.objectContaining({
        type: "item/agentMessage/delta",
        scope: turnScope(harness.turnId("turn-1")),
        itemId,
        delta: "hello ",
      }),
    ]);

    expect(
      harness.translate(
        codexEvent("item/agentMessage/delta", {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "world",
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId,
        delta: "world",
      }),
    ]);
  });

  it("never synthesizes an opening item for command output deltas", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("item/commandExecution/outputDelta", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "cmd-1",
        delta: "output line\n",
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        scope: turnScope(harness.turnId("turn-1")),
        itemId: harness.itemId("cmd-1"),
        delta: "output line\n",
      }),
    ]);
  });

  it("fans thread/tokenUsage/updated out to both usage events exactly", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("thread/tokenUsage/updated", {
        threadId: "t1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 100,
            inputTokens: 60,
            cachedInputTokens: 10,
            cacheWriteInputTokens: 0,
            outputTokens: 30,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 50,
            inputTokens: 30,
            cachedInputTokens: 5,
            cacheWriteInputTokens: 0,
            outputTokens: 15,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 128000,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        scope: turnScope(harness.turnId("turn-1")),
        tokenUsage: expect.objectContaining({
          total: expect.objectContaining({ totalTokens: 100 }),
          modelContextWindow: 128000,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 50,
          modelContextWindow: 128000,
          estimated: false,
        },
      }),
    );
  });
});

describe("codex plan translation", () => {
  it("maps turn/plan/updated to a settled planSteps snapshot", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("turn/plan/updated", {
        threadId: "t1",
        turnId: "turn-1",
        explanation: "Here's the plan",
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Edit the function", status: "inProgress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-1")),
        item: {
          type: "planSteps",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          steps: [
            { step: "Read the file", status: "completed" },
            { step: "Edit the function", status: "active" },
            { step: "Run tests", status: "pending" },
          ],
          explanation: "Here's the plan",
          status: "completed",
          presentation: {
            label: { pending: "Updating plan", completed: "Updated plan" },
            icon: { glyph: "ListTodo" },
            title: "Edit the function",
          },
        },
      }),
    ]);
  });

  it("mints one planSteps item per snapshot and tolerates null explanations", () => {
    const harness = createHarness();
    const first = harness.translate({
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        explanation: null,
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Run tests", status: "pending" },
        ],
      },
    });
    const second = harness.translate({
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        explanation: null,
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Run tests", status: "completed" },
        ],
      },
    });

    expect(first).toEqual([
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(harness.turnId("turn-1")),
        item: expect.objectContaining({
          type: "planSteps",
          steps: [
            { step: "Read the file", status: "completed" },
            { step: "Run tests", status: "pending" },
          ],
        }),
      }),
    ]);
    expect(
      first[0]?.type === "item/completed" ? first[0].item : null,
    ).not.toHaveProperty("explanation");
    expect(second).toHaveLength(1);
    const firstItem =
      first[0]?.type === "item/completed" ? first[0].item : null;
    const secondItem =
      second[0]?.type === "item/completed" ? second[0].item : null;
    expect(secondItem?.id).not.toBe(firstItem?.id);
    expect(second.some((event) => event.type === "turn/plan/updated")).toBe(
      false,
    );
  });
});

describe("codex turn diff translation", () => {
  it("maps turn/diff/updated onto the vouched turn", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("turn/diff/updated", {
        threadId: "t1",
        turnId: "turn-1",
        diff: "+added line",
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "turn/diff/updated",
        scope: turnScope(harness.turnId("turn-1")),
        diff: "+added line",
      }),
    ]);
  });
});

describe("codex error and warning translation", () => {
  it("includes detail and willRetry on turn-scoped errors", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("error", {
        threadId: "t1",
        turnId: "turn-1",
        error: {
          message: "Rate limited",
          codexErrorInfo: null,
          additionalDetails: "retry after 30s",
        },
        willRetry: true,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(harness.turnId("turn-1")),
        message: "Provider error",
        detail: "Rate limited\nretry after 30s",
        willRetry: true,
      }),
    );
  });

  it("keeps a turnless error thread-scoped even while a turn is open", () => {
    const harness = createHarness();
    harness.translate(
      codexEvent("turn/started", {
        threadId: "t1",
        turn: codexTurn({ id: "turn-1", status: "inProgress", error: null }),
      }),
    );
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "error",
      params: {
        threadId: "t1",
        error: {
          message: "startup failed",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: threadScope(),
        detail: "startup failed",
      }),
    ]);
  });

  it("maps codexErrorInfo to provider error info", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("error", {
        threadId: "t1",
        turnId: "turn-1",
        error: {
          message: "stream disconnected",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: 502 },
          },
          additionalDetails: null,
        },
        willRetry: false,
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(harness.turnId("turn-1")),
        message: "Provider error",
        detail: "stream disconnected",
        willRetry: false,
        errorInfo: {
          category: "stream-disconnected",
          providerCode: "responseStreamDisconnected",
          httpStatusCode: 502,
        },
      }),
    );
  });

  it.each([
    ["sessionBudgetExceeded", "budget-exceeded"],
    ["misalignmentPolicyViolation", "policy"],
  ] as const)(
    "normalizes %s errors and failed turn completion",
    (codexErrorInfo, category) => {
      const harness = createHarness();

      expect(
        harness.translate(
          codexEvent("error", {
            threadId: "t1",
            turnId: "turn-1",
            error: {
              message: "terminal failure",
              codexErrorInfo,
              additionalDetails: null,
            },
            willRetry: false,
          }),
        ),
      ).toEqual([
        expect.objectContaining({
          type: "provider/error",
          scope: turnScope(harness.turnId("turn-1")),
          errorInfo: {
            category,
            providerCode: codexErrorInfo,
            httpStatusCode: null,
          },
        }),
      ]);

      expect(
        harness.translate(
          codexEvent("turn/completed", {
            threadId: "t1",
            turn: codexTurn({
              id: "turn-1",
              status: "failed",
              error: {
                message: "terminal failure",
                codexErrorInfo,
                additionalDetails: null,
              },
            }),
          }),
        ),
      ).toEqual([
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(harness.turnId("turn-1")),
          status: "failed",
          error: { message: "terminal failure" },
        }),
      ]);
    },
  );

  it("maps deprecationNotice to a thread-scoped warning", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("deprecationNotice", {
        summary: "Model deprecated",
        details: "Use newer model",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/warning",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        category: "deprecation",
        summary: "Model deprecated",
        details: "Use newer model",
      }),
    );
  });

  it("maps configWarning to a thread-scoped warning", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("configWarning", {
        summary: "Bad config",
        details: null,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/warning",
        threadId: "",
        providerThreadId: "",
        category: "config",
        summary: "Bad config",
      }),
    );
  });

  it("ignores MCP startup status updates", () => {
    const harness = createHarness();
    const failedEvents = harness.translate({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        name: "codex_apps",
        status: "failed",
        error: "MCP client failed to start",
      },
    });
    const readyEvents = harness.translate({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        name: "codex_apps",
        status: "ready",
        error: null,
      },
    });

    expect(failedEvents).toEqual([]);
    expect(readyEvents).toEqual([]);
  });
});

describe("codex account rate-limit translation", () => {
  const blockedSpendControlSnapshot = {
    limitId: "codex",
    limitName: "Codex",
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: true,
    planType: "team",
    rateLimitReachedType: null,
  } as const;

  it("carries Codex spend-control state from the initial read", () => {
    const response = codexRateLimitReadResponseSchema.parse({
      rateLimits: blockedSpendControlSnapshot,
    });
    const snapshot = applyCodexRateLimitUpdate(
      createCodexEventTranslationState(),
      response.rateLimits,
    );

    expect(snapshot.spendControlReached).toBe(true);
  });

  it.each([
    ["null", { spendControlReached: null }],
    ["absence", {}],
  ])("does not resurrect blocked spend control after %s", (_, clearUpdate) => {
    const harness = createHarness();
    const [blockedEvent] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: blockedSpendControlSnapshot,
      }),
    );
    expect(blockedEvent).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "spend-control",
        windows: [],
        reachedReason: null,
      },
    });

    const [clearedEvent] = harness.translate({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: { rateLimits: clearUpdate },
    });
    expect(clearedEvent).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "unknown",
        kind: "unknown",
        reachedReason: null,
      },
    });
  });

  it("preserves Codex subscription rate limits", () => {
    const harness = createHarness();
    const events = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1_781_120_400,
          },
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: "rate_limit_reached",
        },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/rateLimits/updated",
        scope: threadScope(),
        rateLimits: expect.objectContaining({
          providerId: "codex",
          status: "blocked",
          kind: "subscription-window",
          reachedReason: "rate_limit_reached",
          windows: [
            {
              providerKey: "primary",
              label: "Current session",
              status: "blocked",
              resetsAtMs: 1_781_120_400_000,
            },
          ],
        }),
      }),
    ]);
  });

  it("classifies an exhausted weekly window independently from extra credits", () => {
    const harness = createHarness();
    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          primary: {
            usedPercent: 100,
            windowDurationMins: 10_080,
            resetsAt: 1_788_748_218,
          },
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          planType: "pro",
        }),
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "subscription-window",
        reachedReason: null,
        windows: [
          {
            providerKey: "primary",
            label: "Weekly limit",
            status: "blocked",
            resetsAtMs: 1_788_748_218_000,
          },
        ],
      },
    });
  });

  it("does not merge subscription windows across limit ids", () => {
    const state = createCodexEventTranslationState();
    applyCodexRateLimitUpdate(state, {
      limitId: "codex",
      primary: {
        usedPercent: 100,
        windowDurationMins: 10_080,
        resetsAt: 1_788_748_218,
      },
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: "0",
      },
    });

    const premiumSnapshot = applyCodexRateLimitUpdate(state, {
      limitId: "premium",
      primary: null,
      secondary: null,
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: "0",
      },
    });

    expect(premiumSnapshot).toMatchObject({
      limitId: "premium",
      primary: null,
      secondary: null,
    });
  });

  it("keeps an exhausted bucket active when another bucket has no windows", () => {
    const harness = createHarness();
    harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          primary: {
            usedPercent: 100,
            windowDurationMins: 10_080,
            resetsAt: 1_788_748_218,
          },
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          planType: "pro",
        }),
      }),
    );

    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          limitId: "premium",
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          planType: "pro",
        }),
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "subscription-window",
        windows: [
          {
            providerKey: "primary",
            label: "Weekly limit",
            status: "blocked",
            resetsAtMs: 1_788_748_218_000,
          },
        ],
      },
    });
  });

  it("preserves every applicable blocked window across global and active buckets", () => {
    const harness = createHarness();
    harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          primary: {
            usedPercent: 100,
            windowDurationMins: 10_080,
            resetsAt: 1_788_748_218,
          },
          planType: "pro",
        }),
      }),
    );

    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          limitId: "premium",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1_788_700_000,
          },
          planType: "pro",
        }),
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "subscription-window",
        windows: [
          {
            providerKey: "primary",
            label: "Weekly limit",
            status: "blocked",
            resetsAtMs: 1_788_748_218_000,
          },
          {
            providerKey: "primary",
            label: "Current session",
            status: "blocked",
            resetsAtMs: 1_788_700_000_000,
          },
        ],
      },
    });
  });

  it("keeps a global credit block ahead of an active subscription block", () => {
    const harness = createHarness();
    harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          planType: "pro",
          rateLimitReachedType: "workspace_owner_credits_depleted",
        }),
      }),
    );

    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          limitId: "premium",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1_788_700_000,
          },
          planType: "pro",
          rateLimitReachedType: "rate_limit_reached",
        }),
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "credits",
        reachedReason: "workspace_owner_credits_depleted",
        windows: [
          {
            providerKey: "primary",
            label: "Current session",
            status: "blocked",
            resetsAtMs: 1_788_700_000_000,
          },
        ],
      },
    });
  });

  it("does not let an inactive model bucket block the active bucket", () => {
    const harness = createHarness();
    harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          limitId: "model-a",
          limitName: "Model A",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1_788_748_218,
          },
          planType: "pro",
        }),
      }),
    );

    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          limitId: "model-b",
          limitName: "Model B",
          primary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: 1_788_748_218,
          },
          planType: "pro",
        }),
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "allowed",
        kind: "subscription-window",
        windows: [{ providerKey: "primary", status: "allowed" }],
      },
    });
  });

  it("hydrates and preserves rate-limit buckets by limit id", () => {
    const harness = createHarness();
    const [rateLimitRead] = harness.translator.buildPostInitializeRequests();
    if (rateLimitRead === undefined) {
      throw new Error("Expected a Codex rate-limit hydration request");
    }
    rateLimitRead.onResult({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1_788_700_000,
        },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 20,
            windowDurationMins: 300,
            resetsAt: 1_788_700_000,
          },
        },
        premium: {
          limitId: "premium",
          primary: {
            usedPercent: 100,
            windowDurationMins: 10_080,
            resetsAt: 1_788_748_218,
          },
        },
      },
    });

    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          limitId: "premium",
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          planType: "pro",
        }),
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "subscription-window",
        windows: [
          {
            providerKey: "primary",
            label: "Weekly limit",
            status: "blocked",
            resetsAtMs: 1_788_748_218_000,
          },
        ],
      },
    });
  });

  it("keeps an exhausted individual limit ahead of an allowed subscription window", () => {
    const harness = createHarness();
    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: codexRateLimitSnapshot({
          primary: {
            usedPercent: 20,
            windowDurationMins: 300,
            resetsAt: 1_788_700_000,
          },
          individualLimit: {
            limit: "100",
            used: "100",
            remainingPercent: 0,
            resetsAt: 1_788_748_218,
          },
          planType: "pro",
        }),
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "spend-control",
        reachedReason: null,
        windows: [
          {
            providerKey: "primary",
            label: "Current session",
            status: "allowed",
          },
          {
            providerKey: "individual-limit",
            label: "Spend control",
            status: "blocked",
          },
        ],
      },
    });
  });

  it("uses Codex's reached reason before credit and spend metadata", () => {
    const harness = createHarness();
    const [event] = harness.translate(
      codexEvent("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1_781_120_400,
          },
          secondary: null,
          credits: {
            hasCredits: false,
            unlimited: false,
            balance: "0",
          },
          individualLimit: {
            limit: "100",
            used: "100",
            remainingPercent: 0,
            resetsAt: 1_781_120_400,
          },
          spendControlReached: null,
          planType: "pro",
          rateLimitReachedType: "rate_limit_reached",
        },
      }),
    );

    expect(event).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "subscription-window",
        reachedReason: "rate_limit_reached",
      },
    });
  });

  it("hydrates Codex rate limits before merging truly sparse rolling updates", () => {
    const harness = createHarness();
    const requests = harness.translator.buildPostInitializeRequests();
    expect(requests).toHaveLength(1);
    const [rateLimitRead] = requests;
    if (rateLimitRead === undefined) {
      throw new Error("Expected a Codex rate-limit hydration request");
    }
    expect(rateLimitRead).toMatchObject({
      plan: { kind: "request", method: "account/rateLimits/read" },
      required: false,
    });
    rateLimitRead.onResult({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 20,
          resetsAt: 1_781_120_400,
        },
        secondary: {
          usedPercent: 100,
          windowDurationMins: 10_080,
          resetsAt: 1_781_720_400,
        },
        planType: "pro",
        rateLimitReachedType: "rate_limit_reached",
      },
    });

    const [sparseEvent] = harness.translate({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: {
            usedPercent: 25,
            resetsAt: 1_781_120_400,
          },
        },
      },
    });
    expect(sparseEvent).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "blocked",
        kind: "subscription-window",
        reachedReason: "rate_limit_reached",
        windows: [
          { providerKey: "primary", status: "allowed" },
          {
            providerKey: "secondary",
            status: "blocked",
            resetsAtMs: 1_781_720_400_000,
          },
        ],
      },
    });

    const [resetEvent] = harness.translate({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          secondary: {
            usedPercent: 30,
            resetsAt: 1_781_720_400,
          },
        },
      },
    });
    expect(resetEvent).toMatchObject({
      type: "provider/rateLimits/updated",
      rateLimits: {
        status: "allowed",
        kind: "subscription-window",
        reachedReason: null,
      },
    });
  });
});

describe("codex ignored notifications", () => {
  it("ignores remote control status changes", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "remoteControl/status/changed",
      params: {
        status: "disabled",
        environmentId: null,
      },
    });

    expect(events).toEqual([]);
  });

  it("ignores thread settings updates", () => {
    const harness = createHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "thread/settings/updated",
      params: {
        threadId: "t1",
        threadSettings: {
          cwd: "/tmp/project",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/tmp/thread-storage"],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          model: "gpt-5.5",
          modelProvider: "openai",
          serviceTier: null,
          effort: "xhigh",
          summary: null,
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.5",
              reasoning_effort: "xhigh",
              developer_instructions: null,
            },
          },
          personality: "pragmatic",
        },
      },
    });

    expect(events).toEqual([]);
  });
});
