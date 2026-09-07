import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import {
  createDeltaAssembler,
  type DeltaAssembler,
} from "@bb/provider-bridge-protocol/assembler";
import {
  createPiDeltaTranslator,
  createPiModelContextWindowResolverFrom,
  type PiModelContextWindowResolver,
} from "./delta-translation.js";

const builtinCatalogResolver = createPiModelContextWindowResolverFrom(
  getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)),
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "./__fixtures__/pi");

const THREAD_ID = "bb-thread-1";
const ENTROPY = "pi-test";
const TURN_ID_PATTERN = /^pi-test-t\d+$/;
const ITEM_ID_PATTERN = /^pi-test-i\d+$/;

function loadFixture(name: string): AgentSessionEvent {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, name), "utf8"),
  ) as AgentSessionEvent;
}

interface PiTestContext {
  cwd?: string;
  threadId?: string;
  parentToolCallId?: string;
}

interface PiEquivalenceHarness {
  assembler: DeltaAssembler;
  translate(event: unknown, context?: PiTestContext): ThreadEvent[];
  openTurnId(): string;
}

function createHarness(options?: {
  resolveModelContextWindow?: PiModelContextWindowResolver;
}): PiEquivalenceHarness {
  const translator = createPiDeltaTranslator({
    resolveModelContextWindow:
      options?.resolveModelContextWindow ?? builtinCatalogResolver,
  });
  const assembler = createDeltaAssembler({
    providerId: "pi",
    entropyPrefix: ENTROPY,
    textDeltaFlushMs: 0,
  });
  return {
    assembler,
    translate(event, context) {
      return assembler.assemble({
        threadId: context?.threadId ?? THREAD_ID,
        deltas: translator.translate(event, context),
      });
    },
    openTurnId() {
      return assembler.getOpenTurnId(THREAD_ID) ?? "";
    },
  };
}

function sdkMessage(message: unknown) {
  return {
    jsonrpc: "2.0" as const,
    method: "sdk/message",
    params: { threadId: "pi-thread-1", message },
  };
}

function createPiCustomMessage(args: {
  content: string | Array<Record<string, unknown>>;
  display?: boolean;
}) {
  return {
    role: "custom",
    customType: "ad-process:notification",
    content: args.content,
    display: args.display ?? true,
    details: { attention: "turn", kind: "success", processId: "proc_551c" },
    timestamp: 1_786_919_243_630,
  };
}

function createPiAgentErrorEvent(
  errorMessage: string,
  willRetry: boolean,
): AgentSessionEvent {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 1777995781000,
      },
    ],
    willRetry,
  };
}

interface PiBashStartEventArgs {
  command: string;
  cwd?: string;
  toolCallId: string;
}

function createPiBashStartEvent(args: PiBashStartEventArgs): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId: args.toolCallId,
    toolName: "bash",
    args: { command: args.command, cwd: args.cwd ?? "/repo" },
  };
}

interface PiBashUpdateEventArgs {
  text: string;
  threadId: string;
  toolCallId: string;
}

function createPiBashUpdateEvent(args: PiBashUpdateEventArgs) {
  return {
    jsonrpc: "2.0" as const,
    method: "sdk/message",
    params: {
      threadId: args.threadId,
      message: {
        type: "tool_execution_update" as const,
        toolCallId: args.toolCallId,
        toolName: "bash" as const,
        partialResult: {
          content: [{ type: "text" as const, text: args.text }],
        },
      },
    },
  };
}

function createTextDeltaEvent(): AgentSessionEvent {
  return loadFixture("message-update-delta.json");
}

function agentMessageDeltaId(events: ThreadEvent[]): string | undefined {
  const delta = events.find(
    (
      event,
    ): event is Extract<ThreadEvent, { type: "item/agentMessage/delta" }> =>
      event.type === "item/agentMessage/delta",
  );
  return delta?.itemId;
}

describe("pi delta translation equivalence", () => {
  it("keeps turn_start as internal noise while agent_start owns the bb turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "turn_start",
    } as AgentSessionEvent);

    expect(events).toEqual([]);
  });

  it("agent_start opens exactly one bb turn", () => {
    const harness = createHarness();
    const events = harness.translate(loadFixture("agent-start.json"));
    expect(events).toEqual([
      expect.objectContaining({ type: "turn/started", threadId: "" }),
    ]);
    expect(harness.openTurnId()).toMatch(TURN_ID_PATTERN);
    expect(harness.translate(loadFixture("agent-start.json"))).toEqual([]);
  });

  it("agent_end emits agentMessage + turn/completed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      ...loadFixture("agent-end-with-message.json"),
      providerCheckpointId: "pi-entry-42",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: "I've updated the configuration file to use the new database connection string. The change affects `/src/config/database.ts` and should resolve the timeout issues you were experiencing.",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
        providerCheckpointId: "pi-entry-42",
      }),
    );
    expect(events.some((event) => event.type === "provider/error")).toBe(false);
  });

  it("completes extension-triggered turns when agent_end includes string custom content", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "agent_end",
      messages: [
        {
          role: "custom",
          customType: "pi-processes",
          content: "Process completed successfully",
          display: true,
          timestamp: 1777995780000,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The process finished." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 1777995781000,
        },
      ],
      willRetry: false,
    } satisfies AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    );
    expect(events.some((event) => event.type === "provider/unhandled")).toBe(
      false,
    );
  });

  it("records a displayed Pi custom message as the input of the turn it triggered", () => {
    const harness = createHarness();
    harness.translate(sdkMessage(loadFixture("agent-start.json")));
    const turnId = harness.openTurnId();
    const message = createPiCustomMessage({
      content:
        '<process_event kind="success" process_id="proc_551c">Process completed successfully</process_event>',
    });

    const startEvents = harness.translate(
      sdkMessage({ type: "message_start", message }),
    );
    const endEvents = harness.translate(
      sdkMessage({ type: "message_end", message }),
    );

    expect(startEvents).toEqual([
      {
        type: "item/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "userMessage",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          content: [
            {
              type: "text",
              text: '<process_event kind="success" process_id="proc_551c">Process completed successfully</process_event>',
            },
          ],
        },
      },
    ]);
    expect(endEvents).toEqual([]);
    expect(harness.openTurnId()).toBe(turnId);
  });

  it("joins the text blocks of an array-content Pi custom message", () => {
    const harness = createHarness();
    harness.translate(sdkMessage(loadFixture("agent-start.json")));

    const events = harness.translate(
      sdkMessage({
        type: "message_start",
        message: createPiCustomMessage({
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "text", text: "second" },
          ],
        }),
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "userMessage",
          content: [{ type: "text", text: "first\nsecond" }],
        }),
      }),
    ]);
  });

  it("drops hidden and idle Pi custom messages without surfacing them as unhandled", () => {
    const harness = createHarness();

    const idleMessage = createPiCustomMessage({ content: "idle context note" });
    expect(
      harness.translate(
        sdkMessage({ type: "message_start", message: idleMessage }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        sdkMessage({ type: "message_end", message: idleMessage }),
      ),
    ).toEqual([]);
    expect(harness.openTurnId()).toBe("");

    harness.translate(sdkMessage(loadFixture("agent-start.json")));
    const hiddenMessage = createPiCustomMessage({
      content: "hidden",
      display: false,
    });
    expect(
      harness.translate(
        sdkMessage({ type: "message_start", message: hiddenMessage }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        sdkMessage({ type: "message_end", message: hiddenMessage }),
      ),
    ).toEqual([]);
  });

  it("agent_end surfaces Pi assistant stop errors as failed turns", () => {
    const harness = createHarness();
    const quotaMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CajgGfxCAhmznZJw7t6Br"}';

    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate(
      createPiAgentErrorEvent(quotaMessage, false),
    );

    expect(events).toEqual([
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: quotaMessage,
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        status: "failed",
      },
    ]);
    expect(events.some((event) => event.type === "item/completed")).toBe(false);
  });

  it("keeps the Pi turn active while the SDK retries an assistant error", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const retryEvents = harness.translate(
      createPiAgentErrorEvent("temporary provider failure", true),
    );
    const completedEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    expect(retryEvents).toEqual([
      expect.objectContaining({
        type: "provider/error",
        detail: "temporary provider failure",
        willRetry: true,
      }),
    ]);
    expect(retryEvents.some((event) => event.type === "turn/completed")).toBe(
      false,
    );
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    );
  });

  it("compaction_start emits a compaction item in the open turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "contextCompaction",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        },
      }),
    ]);
  });

  it("compaction_end emits thread/compacted", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    const events = harness.translate({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    } satisfies AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
      }),
    );
  });

  it.each([
    {
      label: "failed",
      end: { aborted: false, errorMessage: "Automatic compaction overflowed" },
      detail: "Automatic compaction overflowed",
    },
    {
      label: "aborted",
      end: { aborted: true },
      detail: "Automatic context compaction was interrupted",
    },
  ])("terminates a $label automatic compaction", ({ end, detail }) => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    const events = harness.translate({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      willRetry: false,
      ...end,
    } satisfies AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(turnId),
        detail,
      }),
    );
    expect(events.some((event) => event.type === "thread/compacted")).toBe(
      false,
    );
  });

  function translateManualCompaction(args: {
    aborted: boolean;
    errorMessage?: string;
  }) {
    const harness = createHarness();
    const started = harness.translate({
      type: "compaction_start",
      reason: "manual",
    } satisfies AgentSessionEvent);
    const turnId = harness.openTurnId();
    const completed = harness.translate({
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      willRetry: false,
      ...args,
    } satisfies AgentSessionEvent);
    return { completed, started, turnId };
  }

  it("manual compaction owns a complete maintenance turn", () => {
    const { completed, started, turnId } = translateManualCompaction({
      aborted: false,
    });

    expect(started.map((event) => event.type)).toEqual([
      "turn/started",
      "item/started",
    ]);
    expect(completed).toEqual([
      expect.objectContaining({
        type: "thread/compacted",
        scope: turnScope(turnId),
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    ]);
  });

  it.each([
    "Compaction failed: Nothing to compact (session too small)",
    "Compaction failed: Already compacted",
  ])(
    "manual compaction refusal %j completes the turn as a no-op",
    (errorMessage) => {
      const { completed, turnId } = translateManualCompaction({
        aborted: false,
        errorMessage,
      });

      expect(completed).toEqual([
        expect.objectContaining({
          type: "provider/warning",
          scope: turnScope(turnId),
          category: "compaction-skipped",
          summary: "Context compaction skipped",
          details: errorMessage,
        }),
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(turnId),
          status: "completed",
        }),
      ]);
      expect(completed.some((event) => event.type === "thread/compacted")).toBe(
        false,
      );
    },
  );

  it.each([
    {
      label: "failed",
      args: {
        aborted: false,
        errorMessage: "Compaction failed: Summarization failed: 500",
      },
      expected: {
        status: "failed",
        error: {
          message: "Compaction failed: Summarization failed: 500",
        },
      },
    },
    {
      label: "aborted",
      args: { aborted: true },
      expected: { status: "interrupted" },
    },
  ])(
    "$label manual compaction does not report success",
    ({ args, expected }) => {
      const { completed, turnId } = translateManualCompaction(args);
      expect(completed).toEqual([
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(turnId),
          ...expected,
        }),
      ]);
    },
  );

  it("compaction_end without a known turn is unhandled", () => {
    const harness = createHarness();
    const events = harness.translate({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    } satisfies AgentSessionEvent);

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/compaction_end",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("compaction_start reuses the last completed turn id without opening a new turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate(loadFixture("agent-end-with-message.json"));

    const events = harness.translate({
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent);

    expect(events).toEqual([
      {
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "contextCompaction",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        },
      },
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("reuses the streamed assistant item id when the turn ends", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const deltaEvents = harness.translate(createTextDeltaEvent());
    const deltaItemId = agentMessageDeltaId(deltaEvents);
    const completedEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    expect(deltaItemId).toMatch(ITEM_ID_PATTERN);
    expect(deltaEvents.map((event) => event.type)).toEqual([
      "item/started",
      "item/agentMessage/delta",
    ]);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: deltaItemId,
        }),
      }),
    );
  });

  it("assigns a new assistant id after a tool call interrupts streaming", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const preDelta = harness.translate(createTextDeltaEvent());
    const preItemId = agentMessageDeltaId(preDelta);

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const postDelta = harness.translate(createTextDeltaEvent());
    const postItemId = agentMessageDeltaId(postDelta);

    const endEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );
    const completed = endEvents.find(
      (event) =>
        event.type === "item/completed" && event.item.type === "agentMessage",
    );

    expect(preItemId).toMatch(ITEM_ID_PATTERN);
    expect(postItemId).toMatch(ITEM_ID_PATTERN);
    expect(preItemId).not.toBe(postItemId);
    expect(completed).toBeDefined();
    if (
      completed?.type === "item/completed" &&
      completed.item.type === "agentMessage"
    ) {
      expect(completed.item.id).toBe(postItemId);
    }
  });

  it("streams and finalizes Pi thinking with a stable reasoning id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const deltaEvents = harness.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Thinking through the edit.",
      },
    } as AgentSessionEvent);
    const reasoningDelta = deltaEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "item/reasoning/textDelta" }> =>
        event.type === "item/reasoning/textDelta",
    );

    const completedEvents = harness.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Thinking through the edit.",
      },
    } as AgentSessionEvent);

    expect(reasoningDelta?.itemId).toMatch(ITEM_ID_PATTERN);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "reasoning",
          id: reasoningDelta?.itemId,
          content: ["Thinking through the edit."],
        }),
      }),
    );
  });

  it("surfaces Pi thinking without contentIndex as provider/unhandled", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Thinking without a scope.",
      },
    } as AgentSessionEvent);

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/message_update:thinking_delta",
        scope: turnScope(turnId),
      }),
    ]);
  });

  it("tool_execution_start emits item/started with an assembler-minted id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          status: "pending",
        }),
      }),
    ]);
    const startedId =
      events[0]?.type === "item/started" ? events[0].item.id : "";
    expect(harness.assembler.getProviderItemId(THREAD_ID, startedId)).toBe(
      "tc_01a2b3c4d5e6f7g8h9i0j1k2",
    );
  });

  it("gives a bash call without cwd args the session's working directory", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate(
      sdkMessage({
        type: "tool_execution_start",
        toolCallId: "tool-bash-cwd",
        toolName: "bash",
        args: { command: "ls" },
      }),
      { threadId: THREAD_ID, cwd: "/work/tree" },
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "ls",
          cwd: "/work/tree",
        }),
      }),
    ]);
  });

  it("keeps the call's own cwd over the session's", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
      { threadId: THREAD_ID, cwd: "/work/tree" },
    );
    expect(events[0]).toMatchObject({
      type: "item/started",
      item: { type: "commandExecution", cwd: "/Users/developer/project" },
    });
  });

  it("never fabricates a command item without a cwd, on start or on a close without start", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate(
      sdkMessage({
        type: "tool_execution_start",
        toolCallId: "tool-bash-nocwd",
        toolName: "bash",
        args: { command: "ls" },
      }),
    );
    expect(started[0]).toMatchObject({
      type: "item/started",
      item: { type: "toolCall" },
    });
    const closed = harness.translate(
      sdkMessage({
        type: "tool_execution_end",
        toolCallId: "tool-bash-unseen",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      }),
    );
    expect(
      closed.some(
        (event) =>
          event.type === "item/started" || event.type === "item/completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(closed)).not.toContain('"cwd":""');
    expect(
      closed.every(
        (event) => !("item" in event) || event.item.type !== "commandExecution",
      ),
    ).toBe(true);
  });

  it("maps parent_tool_use_id on nested sdk/message events to the parent's minted id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        parent_tool_use_id: "agent-parent-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: { command: "ls", cwd: "/repo" },
        },
      },
    });

    const started = events.find(
      (event) =>
        event.type === "item/started" && event.item.type === "commandExecution",
    );
    if (started?.type !== "item/started") {
      throw new Error("expected a commandExecution item/started");
    }
    expect(started.item.parentToolCallId).toBeDefined();
    expect(started.item.parentToolCallId).not.toBe("agent-parent-1");
    const parentEvents = harness.translate({
      type: "tool_execution_start",
      toolCallId: "agent-parent-1",
      toolName: "spawn_agent",
      args: {},
    } as AgentSessionEvent);
    expect(parentEvents).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          id: started.item.parentToolCallId,
        }),
      }),
    );
  });

  it("falls back to a generic tool call when bash args are malformed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: 42 },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "bash",
          status: "pending",
        }),
      }),
    );
  });

  it("surfaces malformed handled sdk envelopes as provider/unhandled", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "agent_end" },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/agent_end",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("drops agent_settled instead of surfacing it in the transcript", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "agent_settled" },
      },
    });

    expect(events).toEqual([]);
  });

  it("scopes unknown sdk envelopes to the active turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "future_event", value: true },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        scope: turnScope(turnId),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("keeps late unknown sdk envelopes thread scoped", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate(loadFixture("agent-end-with-message.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: { type: "future_event", value: true },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("tool_execution_start with edit args emits fileChange with diff", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-edit-1",
      toolName: "edit",
      args: {
        path: "src/app.ts",
        oldText: "const enabled = false;\n",
        newText: "const enabled = true;\n",
      },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "fileChange",
          status: "pending",
          changes: [
            expect.objectContaining({
              path: "src/app.ts",
              diff: expect.stringContaining("const enabled = true;"),
            }),
          ],
        }),
      }),
    );
  });

  it("tool_execution_start with content-only write args marks the change as an add", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-write-1",
      toolName: "write",
      args: { path: "src/app.ts", content: "console.log('updated');\n" },
    } as AgentSessionEvent);

    const started = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(started?.item).toMatchObject({
      type: "fileChange",
      status: "pending",
      changes: [{ path: "src/app.ts", kind: "add" }],
    });
    if (!started || started.item.type !== "fileChange") return;
    expect(started.item.changes[0]?.diff).toContain("+++ b/src/app.ts");
  });

  it("tool_execution_start with read args preserves structured tool arguments", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: { path: "src/app.ts", offset: 1, limit: 20 },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "read",
          status: "pending",
          arguments: expect.objectContaining({
            path: "src/app.ts",
            offset: 1,
            limit: 20,
          }),
        }),
      }),
    );
  });

  it("tool_execution_end emits item/completed under the started item's id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
    );
    const startedId =
      started[0]?.type === "item/started" ? started[0].item.id : "";

    const events = harness.translate(
      loadFixture("tool-execution-end-bash.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: startedId,
          status: "completed",
        }),
      }),
    );
  });

  it("tool_execution_end marks bash failures", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "npm test", cwd: "/repo" },
    } as AgentSessionEvent);

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: true,
      result: "tests failed",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "npm test",
          cwd: "/repo",
          aggregatedOutput: "tests failed",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it("recovers non-bash tool results from the started item", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: { path: "src/app.ts", offset: 1, limit: 20 },
    } as AgentSessionEvent);

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-read-1",
      toolName: "read",
      isError: false,
      result: "file contents",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "read",
          status: "completed",
          result: "file contents",
          arguments: expect.objectContaining({
            path: "src/app.ts",
            offset: 1,
            limit: 20,
          }),
        }),
      }),
    );
  });

  it("maps bash tool execution updates to command output deltas", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "printf 'FIRST\\nSECOND\\n'", cwd: "/repo" },
    } as AgentSessionEvent);
    const startedId =
      started[0]?.type === "item/started" ? started[0].item.id : "";

    const firstEvents = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\n",
      }),
    );

    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: startedId,
        delta: "FIRST\n",
      }),
    );

    const secondEvents = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: startedId,
        delta: "SECOND\n",
      }),
    );
  });

  it("emits the full bash delta when Pi resets cumulative output", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createPiBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\nSECOND\\n'",
      }),
    );

    harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    const resetEvents = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "RESET\n",
      }),
    );

    expect(resetEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "RESET\n",
        reset: true,
      }),
    );
  });

  it("clears bash output snapshots when a turn completes", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createPiBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\n'",
      }),
    );
    harness.translate(
      createPiBashUpdateEvent({
        threadId: THREAD_ID,
        toolCallId: "tool-bash-1",
        text: "FIRST\n",
      }),
    );

    harness.translate(loadFixture("agent-end-with-message.json"));

    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createPiBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\nSECOND\\n'",
      }),
    );
    const events = harness.translate(
      createPiBashUpdateEvent({
        threadId: THREAD_ID,
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "FIRST\nSECOND\n",
      }),
    );
  });

  it("skips empty bash updates with no content", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "",
      }),
    );

    expect(events).toEqual([]);
  });

  it("skips Pi bash update placeholders", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "(no output)",
      }),
    );

    expect(events).toEqual([]);
  });

  it("keeps non-bash tool execution updates as shared tool progress", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: {
            content: [{ type: "text", text: "partial output" }],
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: "partial output",
      }),
    );
  });

  it("falls back to legacy non-bash progress text when partial output is empty", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: { content: [] },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: "read progress update",
      }),
    );
  });

  it("strips Pi no-output placeholders from bash completions", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "true", cwd: "/repo" },
    } as AgentSessionEvent);

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "(no output)" }] },
    } as AgentSessionEvent);

    const completedEvent = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed",
    );

    expect(completedEvent?.item).toMatchObject({
      type: "commandExecution",
      command: "true",
      cwd: "/repo",
      status: "completed",
      exitCode: 0,
    });
    if (completedEvent?.item.type !== "commandExecution") {
      throw new Error("Expected commandExecution completion");
    }
    expect(completedEvent.item.aggregatedOutput).toBeUndefined();
  });

  it("surfaces tool events without an active turn as provider/unhandled", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: { command: "npm test" },
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/tool_execution_start",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("ignores auto retry notifications for now", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 2,
          delayMs: 2000,
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("accumulates Pi token usage across turns", () => {
    const harness = createHarness({
      resolveModelContextWindow: () => 123_456,
    });

    harness.translate(loadFixture("agent-start.json"));
    const firstTurnEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    harness.translate(loadFixture("agent-start.json"));
    const secondTurnEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    const firstTokenUsage = firstTurnEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );
    const secondTokenUsage = secondTurnEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );

    expect(firstTokenUsage?.tokenUsage.last).toMatchObject({
      totalTokens: 7736,
      inputTokens: 4200,
      cachedInputTokens: 3380,
      outputTokens: 156,
    });
    expect(firstTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
    expect(secondTokenUsage?.tokenUsage.total).toMatchObject({
      totalTokens: 15472,
      inputTokens: 8400,
      cachedInputTokens: 6760,
      outputTokens: 312,
    });
    expect(secondTokenUsage?.tokenUsage.last).toEqual(
      firstTokenUsage?.tokenUsage.last,
    );
    expect(secondTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
  });

  it("maps bridge context-window usage updates into the meter event", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate(loadFixture("agent-end-with-message.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "thread/contextWindowUsage/updated",
      params: {
        threadId: THREAD_ID,
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
        },
      }),
    );
  });

  it("clears stale tool state when a turn ends without tool results", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "npm test", cwd: "/repo" },
    } as AgentSessionEvent);
    harness.translate(loadFixture("agent-end-with-message.json"));

    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: "late output",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "bash",
          result: "late output",
        }),
      }),
    );
  });

  it("prompt-settled settles only a turn owed to accepted input", () => {
    const harness = createHarness();
    const settled = {
      jsonrpc: "2.0",
      method: "pi/prompt/settled",
      params: { threadId: THREAD_ID, status: "completed" as const },
    };

    expect(harness.translate(settled)).toEqual([]);

    harness.assembler.assemble({
      threadId: THREAD_ID,
      deltas: [
        {
          kind: "input.accepted",
          clientRequestId: "creq_abcdefghjk" as never,
        },
      ],
    });
    const events = harness.translate(settled);
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "turn/completed",
    ]);
  });

  it("prompt-settled failure closes the open turn with the error", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "pi/prompt/settled",
      params: {
        threadId: THREAD_ID,
        status: "failed" as const,
        error: "Nothing to compact",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "failed",
        error: { message: "Nothing to compact" },
      }),
    ]);
  });

  it("session error envelopes settle the open turn as failed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: THREAD_ID, message: "pi exploded" },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: "pi exploded",
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "failed",
      }),
    ]);
  });
});
