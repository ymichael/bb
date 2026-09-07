import { describe, expect, it } from "vitest";
import { threadScope, turnScope, type ThreadEvent } from "@bb/domain";
import type { ProviderRuntimeEvent } from "@bb/provider-bridge-protocol/bridge-kit";
import { createDeltaAssembler } from "@bb/provider-bridge-protocol/assembler";
import type { DeltaAssembler } from "@bb/provider-bridge-protocol/assembler";
import {
  ACP_COMPACTION_COMPLETED_METHOD,
  ACP_COMPACTION_STARTED_METHOD,
  ACP_FS_WRITE_METHOD,
  ACP_TURN_COMPLETED_METHOD,
  ACP_TURN_STARTED_METHOD,
  ACP_UPDATE_METHOD,
  ACP_WARNING_METHOD,
} from "./bridge-protocol.js";
import {
  createAcpDeltaTranslator,
  type AcpDeltaTranslator,
} from "./delta-translation.js";
import { resolveAcpDialect } from "./dialect.js";
import { ACP_TOOL_PAYLOAD_MAX_CHARS } from "./tool-classification.js";
import type { AcpToolCallUpdateEvent } from "./wire.js";

const THREAD_ID = "t-acp-translation";
const ENTROPY = "acp-test";
const TURN_ID_PATTERN = /^acp-test-t\d+$/;
const ITEM_ID_PATTERN = /^acp-test-i\d+$/;

interface AcpEquivalenceHarness {
  assembler: DeltaAssembler;
  translator: AcpDeltaTranslator;
  translate(event: ProviderRuntimeEvent): ThreadEvent[];
  openTurnId(): string;
}

const SESSION_CWD = "/workspace";

function createHarness(): AcpEquivalenceHarness {
  const translator = createAcpDeltaTranslator({ cwd: SESSION_CWD });
  const assembler = createDeltaAssembler({
    providerId: "acp",
    entropyPrefix: ENTROPY,
    textDeltaFlushMs: 0,
  });
  return {
    assembler,
    translator,
    translate(event) {
      return assembler.assemble({
        threadId: THREAD_ID,
        deltas: translator.translateAcpEvent(event, { threadId: THREAD_ID }),
      });
    },
    openTurnId() {
      return assembler.getOpenTurnId(THREAD_ID) ?? "";
    },
  };
}

function turnStartedEvent(): ProviderRuntimeEvent {
  return {
    jsonrpc: "2.0",
    method: ACP_TURN_STARTED_METHOD,
    params: { threadId: THREAD_ID },
  };
}

function turnCompletedEvent(stopReason: string): ProviderRuntimeEvent {
  return {
    jsonrpc: "2.0",
    method: ACP_TURN_COMPLETED_METHOD,
    params: { threadId: THREAD_ID, stopReason },
  };
}

function updateEvent(update: Record<string, unknown>): ProviderRuntimeEvent {
  return {
    jsonrpc: "2.0",
    method: ACP_UPDATE_METHOD,
    params: { threadId: THREAD_ID, update },
  };
}

function fsWriteEvent(
  path: string,
  options: {
    kind?: "add" | "update";
    oldText?: string;
    content?: string;
  } = {},
): ProviderRuntimeEvent {
  return {
    jsonrpc: "2.0",
    method: ACP_FS_WRITE_METHOD,
    params: {
      threadId: THREAD_ID,
      path,
      kind: options.kind ?? "add",
      ...(options.oldText === undefined ? {} : { oldText: options.oldText }),
      content: options.content ?? "hello\n",
    },
  };
}

function completedItems(events: ThreadEvent[]) {
  return events.flatMap((event) =>
    event.type === "item/completed" ? [event.item] : [],
  );
}

describe("acp delta translation (bridge-shared invariants)", () => {
  it("does not synthesize a turn for updates that arrive after turn completion", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    harness.translate(turnCompletedEvent("end_turn"));

    const lateChunk = harness.translate(
      updateEvent({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "late text" },
      }),
    );
    const lateToolCall = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "late-call",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
      }),
    );

    for (const events of [lateChunk, lateToolCall]) {
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.type === "provider/unhandled")).toBe(
        true,
      );
    }
    expect(harness.openTurnId()).toBe("");
  });

  it("settles both items when a terminal tool_call_update changes the item type", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());

    const startedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Read file",
        kind: "read",
        status: "in_progress",
      }),
    );
    expect(startedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        }),
      }),
    );
    const startedItemId =
      startedEvents.find((event) => event.type === "item/started")?.type ===
      "item/started"
        ? (
            startedEvents.find(
              (event) => event.type === "item/started",
            ) as Extract<ThreadEvent, { type: "item/started" }>
          ).item.id
        : "";

    const terminalEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/tmp/a.ts",
            oldText: "old",
            newText: "new",
          },
        ],
      }),
    );
    const settled = completedItems(terminalEvents);
    expect(settled.map((item) => item.type).sort()).toEqual([
      "fileChange",
      "toolCall",
    ]);
    for (const item of settled) {
      expect(item.id).toBe(startedItemId);
    }

    const endEvents = harness.translate(turnCompletedEvent("end_turn"));
    expect(completedItems(endEvents)).toEqual([]);
    expect(endEvents).toContainEqual(
      expect.objectContaining({ type: "turn/completed", status: "completed" }),
    );
  });

  it("settles both items at turn end when a non-terminal update changed the item type", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        title: "Edit file",
        kind: "read",
        status: "in_progress",
      }),
    );
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-2",
        status: "in_progress",
        content: [
          { type: "diff", path: "/tmp/b.ts", oldText: "x", newText: "y" },
        ],
      }),
    );

    const endEvents = harness.translate(turnCompletedEvent("end_turn"));
    const settled = completedItems(endEvents);
    expect(settled.map((item) => item.type).sort()).toEqual([
      "fileChange",
      "toolCall",
    ]);
  });

  it("keeps unmatched fs writes standalone with distinct item ids", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    const first = completedItems(
      harness.translate(fsWriteEvent("/tmp/file.ts")),
    ).find((item) => item.type === "fileChange");
    const second = completedItems(
      harness.translate(fsWriteEvent("/tmp/file.ts")),
    ).find((item) => item.type === "fileChange");
    if (!first || !second) {
      throw new Error("Expected acp/fs/write to complete fileChange items");
    }
    expect(first.id).toMatch(ITEM_ID_PATTERN);
    expect(second.id).toMatch(ITEM_ID_PATTERN);
    expect(first.id).not.toBe(second.id);
  });

  it("keeps an fs write standalone when its native file-change match is ambiguous", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    for (const toolCallId of ["edit-a", "edit-b"]) {
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId,
          kind: "edit",
          status: "pending",
          rawInput: {},
        }),
      );
    }

    const [write] = completedItems(
      harness.translate(fsWriteEvent("/tmp/file.ts")),
    );
    expect(write).toMatchObject({
      type: "fileChange",
      changes: [{ path: "/tmp/file.ts", kind: "add" }],
    });
  });

  it("accumulates repeated client writes and reapplies them after provider updates", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "omp-repeated-write",
        title: "edit",
        kind: "edit",
        status: "pending",
        rawInput: {},
      }),
    );

    expect(
      harness.translate(
        fsWriteEvent("/workspace/poem.md", {
          kind: "update",
          oldText: "original\n",
          content: "middle\n",
        }),
      ),
    ).toEqual([]);

    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "omp-repeated-write",
        status: "in_progress",
        locations: [{ path: "/workspace/poem.md" }],
        content: [
          {
            type: "diff",
            path: "/workspace/poem.md",
            oldText: "provider-old\n",
            newText: "provider-stale\n",
          },
        ],
      }),
    );

    expect(
      harness.translate(
        fsWriteEvent("/workspace/poem.md", {
          kind: "update",
          oldText: "middle\n",
          content: "latest\n",
        }),
      ),
    ).toEqual([]);

    const [completed] = completedItems(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "omp-repeated-write",
          title: "poem.md",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Edited file successfully." },
            },
          ],
        }),
      ),
    );
    expect(completed).toMatchObject({
      type: "fileChange",
      changes: [{ path: "/workspace/poem.md", kind: "update" }],
    });
    const change =
      completed?.type === "fileChange" ? completed.changes[0] : undefined;
    expect(change?.diff).toContain("-original");
    expect(change?.diff).toContain("+latest");
    expect(change?.diff).not.toContain("middle");
    expect(change?.diff).not.toContain("provider-stale");
  });
});

describe("acp delta translation (moved from the legacy adapter suite)", () => {
  function compactionStartedEvent(): ProviderRuntimeEvent {
    return {
      jsonrpc: "2.0",
      method: ACP_COMPACTION_STARTED_METHOD,
      params: { threadId: THREAD_ID },
    };
  }

  function compactionCompletedEvent(
    params: Record<string, unknown>,
  ): ProviderRuntimeEvent {
    return {
      jsonrpc: "2.0",
      method: ACP_COMPACTION_COMPLETED_METHOD,
      params: { threadId: THREAD_ID, ...params },
    };
  }

  it("translates successful maintenance prompts into a compaction lifecycle", () => {
    const harness = createHarness();

    const started = harness.translate(compactionStartedEvent());
    const turnId = harness.openTurnId();
    expect(turnId).toMatch(TURN_ID_PATTERN);
    const completed = harness.translate(
      compactionCompletedEvent({ status: "completed" }),
    );

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

  it("does not report failed maintenance prompts as compacted", () => {
    const harness = createHarness();
    harness.translate(compactionStartedEvent());
    const turnId = harness.openTurnId();

    expect(
      harness.translate(
        compactionCompletedEvent({
          status: "failed",
          error: "Provider rejected /compact",
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "failed",
        error: { message: "Provider rejected /compact" },
      }),
    ]);
  });

  it("translates a skipped maintenance prompt into a warning and a clean turn end", () => {
    const harness = createHarness();
    harness.translate(compactionStartedEvent());
    const turnId = harness.openTurnId();

    expect(
      harness.translate(
        compactionCompletedEvent({
          status: "skipped",
          detail: "Compaction failed: Nothing to compact (session too small)",
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "provider/warning",
        scope: turnScope(turnId),
        category: "compaction-skipped",
        summary: "Context compaction skipped",
        details: "Compaction failed: Nothing to compact (session too small)",
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    ]);
  });

  it("completes streamed items before ending a compaction turn", () => {
    const harness = createHarness();
    harness.translate(compactionStartedEvent());
    harness.translate(
      updateEvent({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Compacted successfully" },
      }),
    );

    const events = harness.translate(
      compactionCompletedEvent({ status: "completed" }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "item/completed",
      "thread/compacted",
      "turn/completed",
    ]);
    expect(events[0]).toMatchObject({
      item: { type: "agentMessage", text: "Compacted successfully" },
    });
  });

  function countChangedLines(diff: string | undefined): {
    added: number;
    removed: number;
  } {
    let added = 0;
    let removed = 0;
    for (const line of diff?.split("\n") ?? []) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("+")) added += 1;
      if (line.startsWith("-")) removed += 1;
    }
    return { added, removed };
  }

  function startedHarness(): AcpEquivalenceHarness {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    return harness;
  }

  it("translates ACP usage updates into exact context-window usage", () => {
    const harness = startedHarness();
    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "usage_update",
          used: 32_768,
          size: 200_000,
          cost: { amount: 0.42, currency: "USD" },
        }),
      ),
    ).toEqual([
      {
        type: "thread/contextWindowUsage/updated",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(harness.openTurnId()),
        contextWindowUsage: {
          usedTokens: 32_768,
          modelContextWindow: 200_000,
          estimated: false,
        },
      },
    ]);
  });

  it("reports ACP usage before a turn without creating a synthetic turn", () => {
    const harness = createHarness();

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "usage_update",
          used: 65_536,
          size: 1_000_000,
        }),
      ),
    ).toEqual([
      {
        type: "thread/contextWindowUsage/updated",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        contextWindowUsage: {
          usedTokens: 65_536,
          modelContextWindow: 1_000_000,
          estimated: false,
        },
      },
    ]);
  });

  it("ignores malformed ACP usage updates", () => {
    const harness = startedHarness();

    expect(
      harness.translate(
        updateEvent({ sessionUpdate: "usage_update", used: -1, size: 200_000 }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        updateEvent({ sessionUpdate: "usage_update", used: 1, size: "200000" }),
      ),
    ).toEqual([]);
  });

  it("accumulates thought chunks into a reasoning item", () => {
    const harness = startedHarness();
    const turnId = harness.openTurnId();
    const thoughtEvents = harness.translate(
      updateEvent({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Considering..." },
      }),
    );
    expect(thoughtEvents.map((event) => event.type)).toEqual([
      "item/started",
      "item/reasoning/textDelta",
    ]);
    expect(thoughtEvents[1]).toEqual({
      type: "item/reasoning/textDelta",
      threadId: "",
      providerThreadId: "",
      scope: turnScope(turnId),
      itemId: expect.stringMatching(ITEM_ID_PATTERN),
      delta: "Considering...",
    });
    const reasoningItemId =
      thoughtEvents[1]?.type === "item/reasoning/textDelta"
        ? thoughtEvents[1].itemId
        : "";

    const messageEvents = harness.translate(
      updateEvent({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      }),
    );
    expect(messageEvents[0]).toEqual({
      type: "item/completed",
      threadId: "",
      providerThreadId: "",
      scope: turnScope(turnId),
      item: {
        type: "reasoning",
        id: reasoningItemId,
        summary: [],
        content: ["Considering..."],
      },
    });
  });

  it("translates execute tool calls into command executions", () => {
    const harness = startedHarness();
    const turnId = harness.openTurnId();

    const startedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Run tests",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pnpm test" },
      }),
    );
    expect(startedEvents).toEqual([
      {
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "commandExecution",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          command: "pnpm test",
          cwd: SESSION_CWD,
          status: "pending",
          approvalStatus: null,
          presentation: {
            label: { pending: "Running command", completed: "Ran command" },
            icon: { glyph: "Terminal" },
            title: "pnpm test",
          },
        },
      },
    ]);
    const startedItemId =
      startedEvents[0]?.type === "item/started" ? startedEvents[0].item.id : "";

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "1 passed" } },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "item/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "commandExecution",
          id: startedItemId,
          command: "pnpm test",
          cwd: SESSION_CWD,
          status: "completed",
          approvalStatus: null,
          aggregatedOutput: "1 passed",
          presentation: {
            label: { pending: "Running command", completed: "Ran command" },
            icon: { glyph: "Terminal" },
            title: "pnpm test",
          },
        },
      },
    ]);
  });

  describe("command exit codes", () => {
    function completeCommand(
      harness: AcpEquivalenceHarness,
      toolCallId: string,
      command: string,
      update: Record<string, unknown>,
    ) {
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId,
          title: `\`${command}\``,
          kind: "execute",
          status: "pending",
          rawInput: { command },
        }),
      );
      const items = completedItems(
        harness.translate(
          updateEvent({
            sessionUpdate: "tool_call_update",
            toolCallId,
            ...update,
          }),
        ),
      );
      expect(items).toHaveLength(1);
      const item = items[0];
      if (item?.type !== "commandExecution") {
        throw new Error(`expected a commandExecution, got ${item?.type}`);
      }
      return item;
    }

    it("uses rawOutput.exitCode when the agent reports a non-zero exit as completed", () => {
      const item = completeCommand(startedHarness(), "call-false", "false", {
        status: "completed",
        rawOutput: { exitCode: 1, stdout: "", stderr: "" },
      });
      expect(item.status).toBe("completed");
      expect(item.exitCode).toBe(1);
    });

    it("does not claim OpenCode metadata for a generic ACP agent", () => {
      const item = completeCommand(
        startedHarness(),
        "call-generic",
        "echo ok",
        {
          status: "completed",
          rawOutput: {
            output: "ok\n",
            metadata: { exit: 0, output: "ok\n", truncated: false },
          },
        },
      );
      expect(item.exitCode).toBeUndefined();
      expect(item.aggregatedOutput).toContain('"metadata"');
    });

    it("omits the exit code when a completed call carries no result at all", () => {
      const item = completeCommand(
        startedHarness(),
        "call-8d1faebb\nfc_366d93fb_0",
        "echo hi; git status",
        { status: "completed" },
      );
      expect(item.status).toBe("completed");
      expect(item.aggregatedOutput).toBeUndefined();
      expect(item.exitCode).toBeUndefined();
    });

    it("keeps exit code 1 for failed calls without a reported exit code", () => {
      const item = completeCommand(startedHarness(), "call-failed", "boom", {
        status: "failed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "boom: not found" },
          },
        ],
      });
      expect(item.status).toBe("failed");
      expect(item.exitCode).toBe(1);
    });

    it("prefers a reported exit code over the failed-status fallback", () => {
      const item = completeCommand(startedHarness(), "call-127", "nope", {
        status: "failed",
        rawOutput: { exitCode: 127, stdout: "", stderr: "nope: not found" },
      });
      expect(item.exitCode).toBe(127);
    });

    it("ignores non-integer exit codes in rawOutput", () => {
      const item = completeCommand(startedHarness(), "call-str", "true", {
        status: "completed",
        rawOutput: { exitCode: "0", stdout: "ok" },
      });
      expect(item.exitCode).toBeUndefined();
    });
  });

  it("summarizes inline image attachments from raw tool output", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-image",
        title: "Inspect image",
        kind: "other",
        status: "completed",
        rawOutput: {
          output: "",
          attachments: [
            {
              url: "data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+",
              contentType: "image/svg+xml",
            },
          ],
        },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "toolCall",
        result: {
          output: "",
          attachments: [{ url: "[image]", contentType: "image/svg+xml" }],
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain("PHN2Zy8+");
  });

  it("translates diff tool calls into file changes", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        title: "Edit file",
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/workspace/a.ts",
            oldText: "same\nold line\nsame\n",
            newText: "same\nnew line\nsame\n",
          },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "fileChange",
        id: expect.stringMatching(ITEM_ID_PATTERN),
        status: "completed",
        changes: [{ path: "/workspace/a.ts", kind: "update" }],
      },
    });
    const change =
      events[0]?.type === "item/completed" &&
      events[0].item.type === "fileChange"
        ? events[0].item.changes[0]
        : undefined;
    expect(change?.diff).toContain("-old line");
    expect(change?.diff).toContain("+new line");
    expect(change?.diff).not.toContain("-same");
    expect(change?.diff).not.toContain("+same");
    expect(countChangedLines(change?.diff)).toEqual({ added: 1, removed: 1 });
  });

  it("keeps a Cursor edit in one file-change lifecycle when the final diff supplies its path", () => {
    const harness = startedHarness();
    const turnId = harness.openTurnId();

    const startedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-edit",
        title: "Edit file",
        kind: "edit",
        status: "in_progress",
        rawInput: {},
      }),
    );
    expect(startedEvents).toEqual([
      {
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "fileChange",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          changes: [],
          status: "pending",
          approvalStatus: null,
          presentation: {
            label: { pending: "Editing file", completed: "Edited file" },
            icon: { glyph: "EditFile" },
          },
        },
      },
    ]);
    const startedItemId =
      startedEvents[0]?.type === "item/started" ? startedEvents[0].item.id : "";

    const completedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/workspace/a.ts",
            oldText: "before\n",
            newText: "after\n",
          },
        ],
      }),
    );

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "fileChange",
        id: startedItemId,
        status: "completed",
        changes: [{ path: "/workspace/a.ts", kind: "update" }],
      },
    });
    const change =
      completedEvents[0]?.type === "item/completed" &&
      completedEvents[0].item.type === "fileChange"
        ? completedEvents[0].item.changes[0]
        : undefined;
    expect(countChangedLines(change?.diff)).toEqual({ added: 1, removed: 1 });
  });

  it("keeps an OpenCode edit in one file-change lifecycle when its path arrives late", () => {
    const harness = startedHarness();
    const turnId = harness.openTurnId();

    const startedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-opencode-write",
        title: "write",
        kind: "edit",
        status: "pending",
        locations: [],
        rawInput: {},
      }),
    );
    expect(startedEvents).toEqual([
      {
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "fileChange",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          changes: [],
          status: "pending",
          approvalStatus: null,
          presentation: {
            label: { pending: "Editing file", completed: "Edited file" },
            icon: { glyph: "EditFile" },
          },
        },
      },
    ]);
    const startedItemId =
      startedEvents[0]?.type === "item/started" ? startedEvents[0].item.id : "";

    const completedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-opencode-write",
        title: "notes.md",
        status: "completed",
        locations: [{ path: "/workspace/notes.md" }],
        rawInput: {
          content: "updated\n",
          filePath: "/workspace/notes.md",
        },
        rawOutput: { output: "Wrote file successfully." },
      }),
    );
    expect(completedEvents).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "fileChange",
          id: startedItemId,
          status: "completed",
          changes: [
            expect.objectContaining({
              path: "/workspace/notes.md",
              kind: "update",
            }),
          ],
          presentation: expect.objectContaining({ title: "notes.md" }),
        }),
      }),
    ]);
  });

  it("folds an OMP client fs write into its path-pending native edit", () => {
    const harness = startedHarness();
    const startedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-omp-edit",
        title: "edit",
        kind: "edit",
        status: "pending",
        rawInput: {},
      }),
    );
    const startedItem = startedEvents.find(
      (event) => event.type === "item/started",
    );
    expect(startedItem).toMatchObject({
      type: "item/started",
      item: { type: "fileChange", changes: [] },
    });
    const startedItemId =
      startedItem?.type === "item/started" ? startedItem.item.id : "";

    expect(
      harness.translate({
        jsonrpc: "2.0",
        method: ACP_FS_WRITE_METHOD,
        params: {
          threadId: THREAD_ID,
          path: "/workspace/poem.md",
          kind: "update",
          oldText: "# Lions\n",
          content: "# Rabbits\n",
        },
      }),
    ).toEqual([]);

    const completedEvents = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-omp-edit",
        title: "poem.md",
        status: "completed",
        locations: [{ path: "/workspace/poem.md" }],
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Edited file successfully.",
            },
          },
        ],
      }),
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "fileChange",
        id: startedItemId,
        status: "completed",
        changes: [{ path: "/workspace/poem.md", kind: "update" }],
      },
    });
    const change =
      completedEvents[0]?.type === "item/completed" &&
      completedEvents[0].item.type === "fileChange"
        ? completedEvents[0].item.changes[0]
        : undefined;
    expect(countChangedLines(change?.diff)).toEqual({ added: 1, removed: 1 });

    expect(
      completedItems(harness.translate(turnCompletedEvent("end_turn"))),
    ).toEqual([]);
  });

  it("translates plan updates into settled planSteps snapshots", () => {
    const harness = startedHarness();
    const first = harness.translate(
      updateEvent({
        sessionUpdate: "plan",
        entries: [
          { content: "Read files", status: "completed" },
          { content: "Fix bug", status: "in_progress" },
          { content: "Run tests", status: "pending" },
        ],
      }),
    );
    expect(first).toEqual([
      {
        type: "item/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(harness.openTurnId()),
        item: {
          type: "planSteps",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          steps: [
            { step: "Read files", status: "completed" },
            { step: "Fix bug", status: "active" },
            { step: "Run tests", status: "pending" },
          ],
          status: "completed",
          presentation: {
            label: { pending: "Updating plan", completed: "Updated plan" },
            icon: { glyph: "ListTodo" },
            suppress: true,
            title: "Fix bug",
          },
        },
      },
    ]);
    const second = completedItems(
      harness.translate(
        updateEvent({
          sessionUpdate: "plan",
          entries: [{ content: "Run tests", status: "in_progress" }],
        }),
      ),
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.id).not.toBe(completedItems(first)[0]?.id);
    expect(first.some((event) => event.type === "turn/plan/updated")).toBe(
      false,
    );
  });

  it("translates bridge warnings", () => {
    const harness = createHarness();

    expect(
      harness.translate({
        jsonrpc: "2.0",
        method: ACP_WARNING_METHOD,
        params: { threadId: THREAD_ID, summary: "History not restored" },
      }),
    ).toEqual([
      {
        type: "provider/warning",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        category: "general",
        summary: "History not restored",
      },
    ]);
  });

  it("fails the open turn on bridge errors", () => {
    const harness = startedHarness();
    const turnId = harness.openTurnId();
    expect(
      harness.translate({
        jsonrpc: "2.0",
        method: "error",
        params: { threadId: THREAD_ID, message: "agent exploded" },
      }),
    ).toEqual([
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: "agent exploded",
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        status: "failed",
      },
    ]);
  });

  it("marks cancelled turns interrupted and refusals failed", () => {
    const harness = startedHarness();
    const firstTurnId = harness.openTurnId();

    expect(harness.translate(turnCompletedEvent("cancelled"))).toEqual([
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(firstTurnId),
        status: "interrupted",
      },
    ]);

    harness.translate(turnStartedEvent());
    const secondTurnId = harness.openTurnId();
    expect(secondTurnId).not.toBe(firstTurnId);
    expect(harness.translate(turnCompletedEvent("refusal"))).toEqual([
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(secondTurnId),
        status: "failed",
        error: { message: "Agent stopped the turn: refusal" },
      },
    ]);
  });

  it("drops noise updates and reports unknown updates", () => {
    const harness = startedHarness();

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replayed" },
        }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "session_info_update",
          title: "Tool Tester",
        }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(updateEvent({ sessionUpdate: "totally_new_update" })),
    ).toMatchObject([
      { type: "provider/unhandled", rawType: "acp/update:totally_new_update" },
    ]);
  });
});

describe("acp delta translation (presentation)", () => {
  function itemDeltas(
    deltas: ReturnType<AcpDeltaTranslator["translateAcpEvent"]>,
  ) {
    return deltas.filter(
      (delta) => delta.kind === "item.open" || delta.kind === "item.close",
    );
  }

  it("attaches a presentation to every item.open and item.close", () => {
    const translator = createAcpDeltaTranslator({ cwd: SESSION_CWD });
    const context = { threadId: THREAD_ID };
    const translate = (event: ProviderRuntimeEvent) =>
      translator.translateAcpEvent(event, context);

    translate(turnStartedEvent());
    const lifecycle = [
      ...translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "call-exec",
          title: "`pnpm test`",
          kind: "execute",
          status: "pending",
          rawInput: { command: "pnpm test" },
        }),
      ),
      ...translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "call-read",
          title: "Read File",
          kind: "read",
          status: "in_progress",
        }),
      ),
      ...translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "call-mcp",
          title: "MCP: tool",
          kind: "other",
          status: "completed",
        }),
      ),
      ...translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-exec",
          status: "completed",
        }),
      ),
      ...translate(fsWriteEvent("/tmp/new.ts")),
      ...translate(turnCompletedEvent("end_turn")),
      ...translate({
        jsonrpc: "2.0",
        method: ACP_COMPACTION_STARTED_METHOD,
        params: { threadId: THREAD_ID },
      }),
    ];

    const items = itemDeltas(lifecycle);
    expect(items.map((delta) => delta.kind)).toEqual([
      "item.open",
      "item.open",
      "item.close",
      "item.close",
      "item.close",
      "item.close",
      "item.open",
    ]);
    for (const delta of items) {
      expect(delta.presentation).toBeDefined();
    }
    expect(items.map((delta) => delta.presentation)).toEqual([
      {
        label: { pending: "Running command", completed: "Ran command" },
        icon: { glyph: "Terminal" },
        title: "pnpm test",
      },
      {
        label: { pending: "Reading file", completed: "Read file" },
        icon: { glyph: "FileText" },
        title: "Read File",
      },
      {
        label: { pending: "Running tool", completed: "Ran tool" },
        icon: { glyph: "Toolbox" },
        title: "MCP: tool",
      },
      {
        label: { pending: "Running command", completed: "Ran command" },
        icon: { glyph: "Terminal" },
        title: "pnpm test",
      },
      {
        label: { pending: "Writing file", completed: "Wrote file" },
        icon: { glyph: "EditFile" },
        title: "new.ts",
      },
      {
        label: { pending: "Reading file", completed: "Read file" },
        icon: { glyph: "FileText" },
        title: "Read File",
      },
      {
        label: {
          pending: "Compacting context",
          completed: "Compacted context",
        },
        icon: { glyph: "Archive" },
      },
    ]);
  });

  it("strips the agent's code ticks from a command headline and names deleted files", () => {
    const translator = createAcpDeltaTranslator({ cwd: SESSION_CWD });
    const context = { threadId: THREAD_ID };
    translator.translateAcpEvent(turnStartedEvent(), context);
    const [command] = itemDeltas(
      translator.translateAcpEvent(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "call-title",
          title: "`touch approved.txt`",
          kind: "execute",
          status: "pending",
        }),
        context,
      ),
    );
    expect(command?.presentation?.title).toBe("touch approved.txt");

    const [deletion] = itemDeltas(
      translator.translateAcpEvent(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "call-delete",
          title: "Delete old.ts",
          kind: "delete",
          status: "completed",
          locations: [{ path: "/workspace/old.ts" }],
        }),
        context,
      ),
    );
    expect(deletion?.presentation).toEqual({
      label: { pending: "Deleting file", completed: "Deleted file" },
      icon: { glyph: "Trash2" },
      title: "old.ts",
    });
  });
});

describe("acp delta translation (native kinds → core kinds)", () => {
  function openItem(update: Record<string, unknown>) {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    const events = harness.translate(
      updateEvent({ sessionUpdate: "tool_call", status: "pending", ...update }),
    );
    const started = events.find((event) => event.type === "item/started");
    if (started?.type !== "item/started") {
      throw new Error(
        `Expected an item/started, got ${JSON.stringify(events)}`,
      );
    }
    return started.item;
  }

  it("maps a read with a location to fileRead", () => {
    expect(
      openItem({
        toolCallId: "read-1",
        title: "Read File",
        kind: "read",
        locations: [{ path: "/workspace/src/a.ts", line: 3 }],
      }),
    ).toMatchObject({
      type: "fileRead",
      path: "/workspace/src/a.ts",
      presentation: {
        label: { pending: "Reading file", completed: "Read file" },
        icon: { glyph: "FileText" },
        title: "a.ts",
      },
    });
  });

  it("recovers the read path from a single code-ticked title token", () => {
    expect(
      openItem({
        toolCallId: "read-2",
        title: "Read `/home/user/project/README.md`",
        kind: "read",
        rawInput: {},
      }),
    ).toMatchObject({ type: "fileRead", path: "/home/user/project/README.md" });
  });

  it("keeps a read with no path a generic tool that presents as a read", () => {
    expect(
      openItem({
        toolCallId: "read-3",
        title: "Read File",
        kind: "read",
        rawInput: {},
      }),
    ).toEqual(
      expect.objectContaining({
        type: "toolCall",
        tool: "read",
        presentation: {
          label: { pending: "Reading file", completed: "Read file" },
          icon: { glyph: "FileText" },
          title: "Read File",
        },
      }),
    );
  });

  it("maps a path-pending delete to an empty file change", () => {
    expect(
      openItem({
        toolCallId: "delete-1",
        title: "Delete file",
        kind: "delete",
        rawInput: {},
      }),
    ).toMatchObject({
      type: "fileChange",
      changes: [],
      presentation: {
        label: { pending: "Deleting file", completed: "Deleted file" },
        icon: { glyph: "Trash2" },
      },
    });
  });

  it("maps a fetch to webFetch when the URL is known", () => {
    expect(
      openItem({
        toolCallId: "fetch-1",
        title: "Fetch: https://example.com/docs",
        kind: "fetch",
      }),
    ).toMatchObject({
      type: "webFetch",
      url: "https://example.com/docs",
      pattern: null,
      presentation: {
        label: { pending: "Fetching page", completed: "Fetched page" },
        title: "https://example.com/docs",
      },
    });
    expect(
      openItem({ toolCallId: "fetch-2", title: "Web Fetch", kind: "fetch" }),
    ).toMatchObject({
      type: "toolCall",
      tool: "fetch",
      presentation: { label: { pending: "Fetching" }, title: "Web Fetch" },
    });
  });

  it("maps a search with a query to the search kind", () => {
    expect(
      openItem({
        toolCallId: "search-1",
        title: "Grep",
        kind: "search",
        rawInput: { pattern: "TODO", path: "/workspace/src" },
      }),
    ).toMatchObject({
      type: "search",
      mode: "content",
      query: "TODO",
      path: "/workspace/src",
      presentation: { label: { completed: "Searched files" }, title: "TODO" },
    });
    expect(
      openItem({
        toolCallId: "search-2",
        title: "Find",
        kind: "search",
        rawInput: { glob: "**/*.test.ts" },
      }),
    ).toMatchObject({ type: "search", mode: "path", query: "**/*.test.ts" });
    expect(
      openItem({ toolCallId: "search-3", title: "Find", kind: "search" }),
    ).toMatchObject({ type: "toolCall", tool: "search" });
  });

  it("maps a think call to a reasoning item with its thought", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "think-1",
        title: "Thinking",
        kind: "think",
        status: "in_progress",
      }),
    );
    const [settled] = completedItems(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "think-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "Plan: A then B" },
            },
          ],
        }),
      ),
    );
    expect(settled).toMatchObject({
      type: "reasoning",
      summary: [],
      content: ["Plan: A then B"],
      presentation: { label: { pending: "Thinking", completed: "Thought" } },
    });
  });

  it("keeps a call whose kind the schema does not know", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    const opened = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-deploy",
        title: "Deploy preview",
        kind: "deploy",
        status: "in_progress",
      }),
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      type: "item/started",
      item: {
        type: "toolCall",
        tool: "deploy",
        status: "pending",
        presentation: {
          label: { pending: "Running tool", completed: "Ran tool" },
          icon: { glyph: "Toolbox" },
          title: "Deploy preview",
        },
      },
    });
    const openedId =
      opened[0]?.type === "item/started" ? opened[0].item.id : "";

    const closed = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-deploy",
        status: "completed",
        rawOutput: { url: "https://preview.example" },
      }),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "toolCall",
        id: openedId,
        tool: "deploy",
        status: "completed",
        presentation: { title: "Deploy preview" },
      },
    });
  });

  it("settles a cancelled call as interrupted and a switch_mode call as its own kind", () => {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-mode",
        title: "Switch to plan mode",
        kind: "switch_mode",
        status: "pending",
      }),
    );
    const closed = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-mode",
        status: "cancelled",
      }),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "toolCall",
        tool: "switch_mode",
        status: "interrupted",
        presentation: {
          label: { pending: "Switching mode", completed: "Switched mode" },
          icon: { glyph: "SlidersHorizontal" },
          title: "Switch to plan mode",
        },
      },
    });
  });

  it("names a generic call by its kind and keeps the title as the headline", () => {
    expect(
      openItem({ toolCallId: "other-1", title: "MCP: tool", kind: "other" }),
    ).toEqual(
      expect.objectContaining({
        type: "toolCall",
        tool: "other",
        presentation: {
          label: { pending: "Running tool", completed: "Ran tool" },
          icon: { glyph: "Toolbox" },
          title: "MCP: tool",
        },
      }),
    );
    expect(
      openItem({ toolCallId: "other-2", title: "Task: Subagent task" }),
    ).toMatchObject({ type: "toolCall", tool: "tool" });
  });
});

describe("acp delta translation (raw payloads and real results)", () => {
  function startedHarness(): AcpEquivalenceHarness {
    const harness = createHarness();
    harness.translate(turnStartedEvent());
    return harness;
  }

  it("reports the exit code and stderr Cursor sent, not a status guess", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-exit",
        title: "`node -e boom`",
        kind: "execute",
        status: "failed",
        rawInput: { command: "node -e boom" },
        rawOutput: { exitCode: 2, stdout: "", stderr: "SyntaxError: boom\n" },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "commandExecution",
        command: "node -e boom",
        status: "failed",
        exitCode: 2,
        aggregatedOutput: "SyntaxError: boom\n",
      },
    });
  });

  it("reads grok's exit_code and notes a timeout and a signal", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-grok-exit",
        title: "Execute `sleep 100`",
        kind: "execute",
        status: "failed",
        rawInput: { command: "sleep 100" },
        rawOutput: {
          type: "Bash",
          exit_code: 124,
          output_for_prompt: "exit: 124\n",
          signal: "SIGKILL",
          timed_out: true,
        },
      }),
    );

    expect(events[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "commandExecution",
        exitCode: 124,
        aggregatedOutput: "exit: 124\n[timed out] [signal SIGKILL]",
      },
    });
  });

  it("shows no output for a command that printed nothing", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-silent",
        title: '`node -e "process.exit(3)"`',
        kind: "execute",
        status: "completed",
        rawInput: { command: 'node -e "process.exit(3)"' },
        rawOutput: { exitCode: 3, stdout: "", stderr: "" },
      }),
    );

    const item =
      events[0]?.type === "item/completed" ? events[0].item : undefined;
    expect(item).toMatchObject({ type: "commandExecution", exitCode: 3 });
    expect(
      item?.type === "commandExecution" ? item.aggregatedOutput : "unset",
    ).toBeUndefined();
  });

  it("streams nothing when a running command's envelope names no stream", () => {
    const harness = startedHarness();
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-quiet",
        title: "Execute `build`",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "build" },
      }),
    );

    const streamed = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-quiet",
        status: "in_progress",
        rawOutput: { exit_code: 0, output: [] },
      }),
    );

    expect(streamed).toEqual([]);
  });

  it("streams a running command's bare-string rawOutput", () => {
    const harness = startedHarness();
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-string",
        title: "Execute `build`",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "build" },
      }),
    );

    const streamed = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-string",
        status: "in_progress",
        rawOutput: "compiling...\n",
      }),
    );

    expect(streamed).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "compiling...",
      }),
    ]);
  });

  it("streams a running command's cumulative output onto its row", () => {
    const harness = startedHarness();
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-stream",
        title: "Execute `tail -f log`",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "tail -f log" },
      }),
    );

    const first = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-stream",
        status: "in_progress",
        content: [
          { type: "content", content: { type: "text", text: "one\n" } },
        ],
      }),
    );
    expect(first).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "one\n",
      }),
    ]);

    const second = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-stream",
        status: "in_progress",
        content: [
          { type: "content", content: { type: "text", text: "one\ntwo\n" } },
        ],
      }),
    );
    expect(second).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "two\n",
      }),
    ]);

    const third = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-stream",
        status: "in_progress",
        content: [
          { type: "content", content: { type: "text", text: "two\n" } },
        ],
      }),
    );
    expect(third).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "two\n",
        reset: true,
      }),
    ]);
  });

  it("streams the command's own output, never the rawOutput envelope", () => {
    const harness = startedHarness();
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-envelope",
        title: "Execute `node -e exit`",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "node -e exit" },
      }),
    );

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-envelope",
          status: "in_progress",
          rawOutput: {
            type: "Bash",
            output: [],
            output_for_prompt: "",
            exit_code: 0,
            command: "node -e exit",
          },
        }),
      ),
    ).toEqual([]);

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-envelope",
          status: "in_progress",
          rawOutput: {
            type: "Bash",
            output_for_prompt: "working\n",
            exit_code: 0,
            command: "node -e exit",
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "working\n",
      }),
    ]);
  });

  it("forwards rawInput as args, rawOutput as result, and the failure text as error", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-mcp",
        title: "MCP: lookup",
        kind: "other",
        status: "failed",
        rawInput: { query: "acp", limit: 3 },
        rawOutput: { message: "upstream refused" },
      }),
    );

    expect(events[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "toolCall",
        arguments: { query: "acp", limit: 3 },
        result: { message: "upstream refused" },
        error: '{"message":"upstream refused"}',
      },
    });
  });

  it("caps an oversized raw payload instead of putting megabytes on the row", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-huge",
        title: "MCP: dump",
        kind: "other",
        status: "completed",
        rawOutput: { body: "x".repeat(ACP_TOOL_PAYLOAD_MAX_CHARS + 5_000) },
      }),
    );

    const item =
      events[0]?.type === "item/completed" ? events[0].item : undefined;
    const result = item?.type === "toolCall" ? item.result : undefined;
    expect(typeof result).toBe("string");
    expect(String(result).length).toBeLessThan(
      ACP_TOOL_PAYLOAD_MAX_CHARS + 200,
    );
    expect(String(result)).toContain("more characters truncated");
  });

  it("resolves a relative location and grok's target_file against the session cwd", () => {
    const translator = createAcpDeltaTranslator({ cwd: "/workspace/app" });
    const assembler = createDeltaAssembler({
      providerId: "acp",
      entropyPrefix: ENTROPY,
      textDeltaFlushMs: 0,
    });
    const translate = (event: ProviderRuntimeEvent) =>
      assembler.assemble({
        threadId: THREAD_ID,
        deltas: translator.translateAcpEvent(event, { threadId: THREAD_ID }),
      });
    translate(turnStartedEvent());

    expect(
      translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "read-rel",
          title: "Read `README.md`",
          kind: "read",
          status: "completed",
          locations: [{ path: "README.md" }],
        }),
      )[0],
    ).toMatchObject({
      item: { type: "fileRead", path: "/workspace/app/README.md" },
    });

    expect(
      translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "read-target",
          title: "read_file",
          kind: "read",
          status: "completed",
          rawInput: { target_file: "src/index.ts" },
        }),
      )[0],
    ).toMatchObject({
      item: { type: "fileRead", path: "/workspace/app/src/index.ts" },
    });
  });

  it("names a generic row by the unstable tool name", () => {
    const events = startedHarness().translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-named",
        title: "Searching the web",
        name: "web_search_exa",
        kind: "other",
        status: "pending",
      }),
    );

    expect(events[0]).toMatchObject({
      type: "item/started",
      item: {
        type: "toolCall",
        tool: "web_search_exa",
        presentation: {
          label: {
            pending: "Running web_search_exa",
            completed: "Ran web_search_exa",
          },
          title: "Searching the web",
        },
      },
    });
  });

  it("opens a grok tool call as the kind its dialect reports", () => {
    const translator = createAcpDeltaTranslator({
      cwd: "/workspace/app",
      dialect: resolveAcpDialect({ command: "/usr/local/bin/grok" }),
    });
    const assembler = createDeltaAssembler({
      providerId: "acp",
      entropyPrefix: ENTROPY,
      textDeltaFlushMs: 0,
    });
    const translate = (event: ProviderRuntimeEvent) =>
      assembler.assemble({
        threadId: THREAD_ID,
        deltas: translator.translateAcpEvent(event, { threadId: THREAD_ID }),
      });
    translate(turnStartedEvent());

    const opened = translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-grok",
        title: "run_terminal_command",
        rawInput: { command: "ls", description: "List files" },
        _meta: {
          "x.ai/tool": {
            version: 1,
            name: "run_terminal_command",
            kind: "execute",
            read_only: false,
          },
        },
      }),
    );
    expect(opened[0]).toMatchObject({
      type: "item/started",
      item: { type: "commandExecution", command: "ls", cwd: "/workspace/app" },
    });
    const openedId =
      opened[0]?.type === "item/started" ? opened[0].item.id : "";

    const closed = translate(
      updateEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-grok",
        kind: "execute",
        title: "Execute `ls`",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "README.md\n" } },
        ],
        rawOutput: {
          type: "Bash",
          exit_code: 0,
          output_for_prompt: "exit: 0\n",
        },
      }),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "commandExecution",
        id: openedId,
        exitCode: 0,
        aggregatedOutput: "README.md\n",
      },
    });
  });

  it("binds a permission request by kind and gives the row the URL it named", () => {
    const harness = startedHarness();
    const opened = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-fetch",
        title: "Web Fetch",
        kind: "fetch",
        status: "in_progress",
        rawInput: {},
      }),
    );
    expect(opened[0]).toMatchObject({
      item: {
        type: "toolCall",
        tool: "fetch",
        presentation: { title: "Web Fetch" },
      },
    });
    const openedId =
      opened[0]?.type === "item/started" ? opened[0].item.id : "";

    const bound = harness.translator.notePermissionToolCall(THREAD_ID, {
      toolCallId: "web_fetch_0",
      title: "Fetch https://nodejs.org/dist/index.json",
      kind: "fetch",
    });
    expect(bound.toolCallId).toBe("call-fetch");

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fetch",
          status: "completed",
          rawOutput: { success: true },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          id: openedId,
          type: "toolCall",
          tool: "fetch",
          presentation: expect.objectContaining({
            title: "Fetch https://nodejs.org/dist/index.json",
          }),
        }),
      }),
    ]);
  });

  it("merges a permission that keeps the row's shape", () => {
    const harness = startedHarness();
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-mcp",
        title: "MCP: tool",
        kind: "other",
        status: "in_progress",
      }),
    );

    const bound = harness.translator.notePermissionToolCall(THREAD_ID, {
      toolCallId: "call-mcp",
      title: "bb-bridge-AskUserQuestion: AskUserQuestion",
      kind: "other",
      rawInput: { question: "Which one?" },
    });
    expect(bound.event?.rawInput).toEqual({ question: "Which one?" });

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-mcp",
          status: "completed",
          rawOutput: { success: true },
        }),
      )[0],
    ).toMatchObject({
      type: "item/completed",
      item: {
        type: "toolCall",
        tool: "other",
        arguments: { question: "Which one?" },
        presentation: { title: "bb-bridge-AskUserQuestion: AskUserQuestion" },
      },
    });
  });

  it("leaves a call that already has a core shape alone", () => {
    const harness = startedHarness();
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "write-tool-1",
        title: "Editing notes.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/tmp/qa-1719/notes.md" }],
      }),
    );

    const bound = harness.translator.notePermissionToolCall(THREAD_ID, {
      toolCallId: "write-tool-1",
      title: "/tmp/qa-1719",
      kind: "other",
      locations: [{ path: "/tmp/qa-1719/notes.md" }, { path: "/tmp/qa-1719" }],
    });

    expect(bound.event?.kind).toBe("edit");
    expect(bound.event?.title).toBe("Editing notes.md");
  });
});

describe("acp delta translation (dialects)", () => {
  function dialectHarness(dialectId: string): AcpEquivalenceHarness {
    const translator = createAcpDeltaTranslator({
      cwd: "/workspace",
      dialect: resolveAcpDialect({ dialectId, command: "node" }),
    });
    const assembler = createDeltaAssembler({
      providerId: "acp",
      entropyPrefix: ENTROPY,
      textDeltaFlushMs: 0,
    });
    const harness: AcpEquivalenceHarness = {
      assembler,
      translator,
      translate: (event) =>
        assembler.assemble({
          threadId: THREAD_ID,
          deltas: translator.translateAcpEvent(event, { threadId: THREAD_ID }),
        }),
      openTurnId: () => assembler.getOpenTurnId(THREAD_ID) ?? "",
    };
    harness.translate(turnStartedEvent());
    return harness;
  }

  function completedDialectCommand(args: {
    dialectId: string;
    rawInput: Record<string, unknown>;
    rawOutput: unknown;
    content?: AcpToolCallUpdateEvent["content"];
    status?: "completed" | "failed";
  }) {
    const harness = dialectHarness(args.dialectId);
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-command",
        title: "command",
        kind: "execute",
        status: "pending",
        rawInput: args.rawInput,
      }),
    );
    return completedItems(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-command",
          status: args.status ?? "completed",
          ...(args.content === undefined ? {} : { content: args.content }),
          rawOutput: args.rawOutput,
        }),
      ),
    )[0];
  }

  it("normalizes omp foreground command output and successful completion", () => {
    expect(
      completedDialectCommand({
        dialectId: "omp",
        rawInput: { command: "echo ok" },
        rawOutput: {
          content: [{ type: "text", text: "ok\n\nWall time: 0.25 seconds" }],
          details: { timeoutSeconds: 10, wallTimeMs: 250 },
        },
      }),
    ).toMatchObject({
      type: "commandExecution",
      command: "echo ok",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "ok",
    });
  });

  it.each([
    {
      label: "explicit",
      rawInput: { command: "sleep 10", async: true },
      details: { wallTimeMs: 250 },
    },
    {
      label: "automatic",
      rawInput: { command: "sleep 10" },
      details: { async: { state: "running" }, wallTimeMs: 250 },
    },
  ])(
    "leaves a completed omp $label background launch without exit zero",
    (sample) => {
      const item = completedDialectCommand({
        dialectId: "omp",
        rawInput: sample.rawInput,
        rawOutput: {
          content: [{ type: "text", text: "Command running in background" }],
          details: sample.details,
        },
      });
      expect(item).toMatchObject({
        type: "commandExecution",
        status: "completed",
        aggregatedOutput: "Command running in background",
      });
      expect(item).not.toHaveProperty("exitCode");
    },
  );

  it("preserves omp timeout failure semantics", () => {
    const output =
      "partial\n\nWall time: 1.00 seconds\n\n[Command timed out after 1 seconds]";
    expect(
      completedDialectCommand({
        dialectId: "omp",
        rawInput: { command: "sleep 10" },
        rawOutput: {
          content: [{ type: "text", text: output }],
          details: { timedOut: true, wallTimeMs: 1_000 },
        },
        status: "failed",
      }),
    ).toMatchObject({
      status: "failed",
      exitCode: 1,
      aggregatedOutput: output,
    });
  });

  it("preserves shared ACP semantics inside and outside the omp dialect", () => {
    expect(
      completedDialectCommand({
        dialectId: "omp",
        rawInput: { command: "sleep 10" },
        rawOutput: {
          exit_code: 124,
          output_for_prompt: "exit: 124\n",
          signal: "SIGKILL",
          timed_out: true,
        },
        status: "failed",
      }),
    ).toMatchObject({
      exitCode: 124,
      aggregatedOutput: "exit: 124\n[timed out] [signal SIGKILL]",
    });

    const decoratedOutput = "ok\n\nWall time: 0.25 seconds";
    const generic = completedDialectCommand({
      dialectId: "unknown",
      rawInput: { command: "echo ok" },
      rawOutput: {
        content: [{ type: "text", text: decoratedOutput }],
        details: { wallTimeMs: 250 },
      },
    });
    expect(generic).toMatchObject({ aggregatedOutput: decoratedOutput });
    expect(generic).not.toHaveProperty("exitCode");
  });

  it("normalizes the recorded OpenCode command completion envelope", () => {
    expect(
      completedDialectCommand({
        dialectId: "opencode",
        rawInput: { command: "echo ok" },
        rawOutput: {
          output: "ok\n",
          metadata: { exit: 0, output: "ok\n", truncated: false },
        },
      }),
    ).toMatchObject({
      type: "commandExecution",
      command: "echo ok",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "ok\n",
    });
  });

  it("keeps standard content and shared result fields ahead of OpenCode fallbacks", () => {
    expect(
      completedDialectCommand({
        dialectId: "opencode",
        rawInput: { command: "echo protocol" },
        content: [
          {
            type: "content",
            content: { type: "text", text: "protocol content\n" },
          },
        ],
        rawOutput: {
          exit_code: 9,
          stdout: "shared stdout\n",
          output_for_prompt: "shared prompt output\n",
          output: "OpenCode output\n",
          metadata: {
            exit: 0,
            output: "OpenCode metadata output\n",
            truncated: false,
          },
        },
      }),
    ).toMatchObject({
      type: "commandExecution",
      exitCode: 9,
      aggregatedOutput: "protocol content\n",
    });
  });

  it("opens a Cursor task call as a delegation and takes the report's detail", () => {
    const harness = dialectHarness("cursor");
    const opened = harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-task",
        title: "Task: Subagent task",
        kind: "other",
        status: "pending",
        rawInput: { _toolName: "task" },
      }),
    );
    expect(opened[0]).toMatchObject({
      type: "item/started",
      item: { type: "delegation", childRef: "call-task", background: false },
    });
    const openedId =
      opened[0]?.type === "item/started" ? opened[0].item.id : "";

    const reported = harness.assembler.assemble({
      threadId: THREAD_ID,
      deltas: harness.translator.noteDelegationReport(THREAD_ID, {
        toolCallId: "call-task",
        childRef: "78d1cd3b-94d2-4c87-82a2-c83fe54712f1",
        label: "Read README first line",
        detail: "model default",
      }),
    });
    expect(reported).toEqual([
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          id: openedId,
          type: "delegation",
          childRef: "78d1cd3b-94d2-4c87-82a2-c83fe54712f1",
          label: "Read README first line",
        }),
      }),
    ]);

    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-task",
          status: "completed",
          rawOutput: { durationMs: 4764, isBackground: false },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          id: openedId,
          type: "delegation",
          childRef: "78d1cd3b-94d2-4c87-82a2-c83fe54712f1",
          label: "Read README first line",
        }),
      }),
    ]);
  });

  it("ignores a delegation report for a call that already settled", () => {
    const harness = dialectHarness("cursor");
    harness.translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-task",
        title: "Task: Subagent task",
        kind: "other",
        status: "completed",
        rawInput: { _toolName: "task" },
      }),
    );

    expect(
      harness.translator.noteDelegationReport(THREAD_ID, {
        toolCallId: "call-task",
        childRef: "agent-1",
        label: "Read README first line",
      }),
    ).toEqual([]);
  });

  it("opens a grok spawn_subagent call as a delegation", () => {
    expect(
      dialectHarness("grok").translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "call-spawn",
          title: "spawn_subagent",
          status: "pending",
          rawInput: { description: "Audit the config loader" },
          _meta: {
            "x.ai/tool": { name: "spawn_subagent", kind: "other", version: 1 },
          },
        }),
      )[0],
    ).toMatchObject({
      type: "item/started",
      item: {
        type: "delegation",
        childRef: "call-spawn",
        label: "Audit the config loader",
        presentation: { icon: { glyph: "UserRound" } },
      },
    });
  });

  it("keeps a bb-injected tool binding ahead of the dialect", () => {
    const harness = dialectHarness("cursor");
    harness.translator.configureInjectedTools([{ name: "AskUserQuestion" }]);
    harness.translator.noteInjectedToolCall(THREAD_ID, "AskUserQuestion");
    expect(
      harness.translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "call-bb",
          title: "MCP: AskUserQuestion",
          kind: "other",
          status: "pending",
          rawInput: { _toolName: "task" },
        }),
      )[0],
    ).toMatchObject({
      type: "item/started",
      item: { type: "toolCall", tool: "AskUserQuestion", server: "bb" },
    });
  });
});

describe("acp delta translation (bb-injected tools)", () => {
  const ASK_PRESENTATION = {
    label: { pending: "Asking a question", completed: "Asked a question" },
    icon: { glyph: "MessageQuestion" },
    suppress: true,
  };

  function injectedHarness() {
    const harness = createHarness();
    const translator = createAcpDeltaTranslator({ cwd: SESSION_CWD });
    translator.configureInjectedTools([
      { name: "ask_user_question", presentation: ASK_PRESENTATION },
      { name: "bb_workflow_run" },
    ]);
    const assembler = harness.assembler;
    const translate = (event: ProviderRuntimeEvent) =>
      assembler.assemble({
        threadId: THREAD_ID,
        deltas: translator.translateAcpEvent(event, { threadId: THREAD_ID }),
      });
    translate(turnStartedEvent());
    return { translate, translator };
  }

  it("binds the agent's announced MCP call when the proxy forwards the bb tool call", () => {
    const { translate, translator } = injectedHarness();
    const [started] = translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "mcp-1",
        title: "MCP: tool",
        kind: "other",
        status: "pending",
      }),
    );
    expect(started).toMatchObject({
      type: "item/started",
      item: { type: "toolCall", tool: "other" },
    });

    translator.noteInjectedToolCall(THREAD_ID, "ask_user_question");

    const [completed] = completedItems(
      translate(
        updateEvent({
          sessionUpdate: "tool_call_update",
          toolCallId: "mcp-1",
          status: "completed",
        }),
      ),
    );
    expect(completed).toMatchObject({
      type: "toolCall",
      server: "bb",
      tool: "ask_user_question",
      status: "completed",
      presentation: ASK_PRESENTATION,
    });
  });

  it("holds a proxied call until the agent announces it, and presents an unknown definition generically", () => {
    const { translate, translator } = injectedHarness();
    translator.noteInjectedToolCall(THREAD_ID, "bb_workflow_run");
    translator.noteInjectedToolCall(THREAD_ID, "not_configured");

    const first = completedItems(
      translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "mcp-2",
          title: "tool",
          status: "completed",
        }),
      ),
    );
    expect(first[0]).toMatchObject({
      type: "toolCall",
      server: "bb",
      tool: "bb_workflow_run",
      presentation: {
        label: {
          pending: "Running bb_workflow_run",
          completed: "Ran bb_workflow_run",
        },
        icon: { glyph: "Toolbox" },
      },
    });
    const second = completedItems(
      translate(
        updateEvent({
          sessionUpdate: "tool_call",
          toolCallId: "mcp-3",
          title: "tool",
          kind: "other",
          status: "completed",
        }),
      ),
    );
    expect(second[0]).toMatchObject({
      type: "toolCall",
      server: "bb",
      tool: "not_configured",
    });
  });

  it("binds by name when the title names the tool, and never binds a command", () => {
    const { translate, translator } = injectedHarness();
    translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "exec-1",
        title: "`sleep 1`",
        kind: "execute",
        status: "pending",
        rawInput: { command: "sleep 1" },
      }),
    );
    const [named] = translate(
      updateEvent({
        sessionUpdate: "tool_call",
        toolCallId: "mcp-4",
        title: "ask_user_question (bb-bridge MCP Server)",
        kind: "other",
        status: "pending",
      }),
    );
    expect(named).toMatchObject({
      type: "item/started",
      item: { type: "toolCall", server: "bb", tool: "ask_user_question" },
    });

    translator.noteInjectedToolCall(THREAD_ID, "bb_workflow_run");
    const settled = completedItems(translate(turnCompletedEvent("end_turn")));
    expect(settled.map((item) => item.type)).toEqual([
      "commandExecution",
      "toolCall",
    ]);
    expect(settled[1]).toMatchObject({ tool: "ask_user_question" });
  });
});
