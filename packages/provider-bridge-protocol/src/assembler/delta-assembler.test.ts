import { describe, expect, it } from "vitest";
import type { ClientTurnRequestId, ThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type { DeltaItemShape, ThreadDelta } from "../thread-delta.js";
import {
  createDeltaAssembler,
  diffCumulativeText,
  type DeltaAssembler,
} from "./delta-assembler.js";
import { createBridgeDeltaEventCollector } from "../testing/bridge-delta-assembly.js";

const THREAD_ID = "thr_1";
const CREQ = "creq_abcdefghjk" as ClientTurnRequestId;
const CREQ_2 = "creq_bcdefghjkm" as ClientTurnRequestId;

function createAssembler(): DeltaAssembler {
  return createDeltaAssembler({
    providerId: "pi",
    entropyPrefix: "as-test",
    textDeltaFlushMs: 0,
  });
}

function assemble(
  assembler: DeltaAssembler,
  ...deltas: ThreadDelta[]
): ThreadEvent[] {
  return assembler.assemble({ threadId: THREAD_ID, deltas });
}

function bashOpen(providerItemId: string): ThreadDelta {
  return {
    kind: "item.open",
    key: { providerItemId },
    item: { type: "command", command: "npm test", cwd: "/repo" },
  };
}

describe("delta assembler", () => {
  it("queues accepted input and drains it right after turn/started", () => {
    const assembler = createAssembler();
    expect(
      assemble(assembler, { kind: "input.accepted", clientRequestId: CREQ }),
    ).toEqual([]);

    const events = assemble(assembler, { kind: "turn.open" });
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
    ]);
    const accepted = events[1];
    expect(accepted).toMatchObject({
      clientRequestId: CREQ,
      scope: events[0]?.scope,
    });
  });

  it("emits accepted input immediately into an already-open turn", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID);
    const events = assemble(assembler, {
      kind: "input.accepted",
      clientRequestId: CREQ_2,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "turn/input/accepted",
        clientRequestId: CREQ_2,
        scope: turnScope(turnId ?? ""),
      }),
    ]);
  });

  it("claimIfIdle boundary opens and settles a turn only when input is pending", () => {
    const assembler = createAssembler();
    expect(
      assemble(assembler, {
        kind: "turn.boundary",
        status: "completed",
        claimIfIdle: true,
      }),
    ).toEqual([]);

    assemble(assembler, { kind: "input.accepted", clientRequestId: CREQ });
    const events = assemble(assembler, {
      kind: "turn.boundary",
      status: "completed",
      claimIfIdle: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "turn/completed",
    ]);
  });

  it("a non-claiming boundary without an open turn settles nothing", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "input.accepted", clientRequestId: CREQ });
    expect(
      assemble(assembler, { kind: "turn.boundary", status: "completed" }),
    ).toEqual([]);
  });

  it("boundary carries error and providerCheckpointId onto turn/completed", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const events = assemble(assembler, {
      kind: "turn.boundary",
      status: "failed",
      error: { message: "boom" },
      providerCheckpointId: "ckpt-1",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "turn/completed",
        status: "failed",
        error: { message: "boom" },
        providerCheckpointId: "ckpt-1",
      }),
    ]);
    expect(assembler.getOpenTurnId(THREAD_ID)).toBeUndefined();
  });

  it("mints a fresh turn id for every turn (never reuses across boundaries)", () => {
    const assembler = createAssembler();
    const first = assemble(assembler, { kind: "turn.open" });
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    const second = assemble(assembler, { kind: "turn.open" });
    const turnIdOf = (event: ThreadEvent | undefined): string =>
      event !== undefined && "scope" in event && event.scope.kind === "turn"
        ? event.scope.turnId
        : "";
    expect(turnIdOf(first[0])).toMatch(/^as-test-t\d+$/);
    expect(turnIdOf(second[0])).toMatch(/^as-test-t\d+$/);
    expect(turnIdOf(first[0])).not.toBe(turnIdOf(second[0]));
  });

  it("settles a paired close from its terminal shape under the opened id", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const started = assemble(assembler, bashOpen("tc-1"));
    expect(started).toEqual([
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "npm test",
          cwd: "/repo",
          status: "pending",
        }),
      }),
    ]);

    const closed = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "tc-1" },
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "tests failed",
      item: { type: "command", command: "npm test", cwd: "/repo" },
    });
    expect(closed).toEqual([
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
    ]);
    const startedItem =
      started[0]?.type === "item/started" ? started[0].item : undefined;
    const closedItem =
      closed[0]?.type === "item/completed" ? closed[0].item : undefined;
    expect(closedItem?.id).toBe(startedItem?.id);
  });

  it("builds the bare completed item on close-without-open", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "tc-late" },
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "late output",
      item: { type: "command", command: "", cwd: "" },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "",
          cwd: "",
          aggregatedOutput: "late output",
          status: "completed",
        }),
      }),
    ]);
  });

  it("settles both shapes when the terminal shape differs from the opened one", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const started = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-re" },
      item: { type: "tool", tool: "Read file" },
    });
    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "tc-re" },
      status: "completed",
      item: {
        type: "fileChange",
        changes: [
          { path: "/tmp/a.ts", kind: "update", oldText: "old", newText: "new" },
        ],
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "item/completed",
      "item/completed",
    ]);
    const settled = events.flatMap((event) =>
      event.type === "item/completed" ? [event.item] : [],
    );
    expect(settled.map((item) => item.type)).toEqual([
      "toolCall",
      "fileChange",
    ]);
    const startedId =
      started[0]?.type === "item/started" ? started[0].item.id : "";
    for (const item of settled) {
      expect(item.id).toBe(startedId);
      expect("status" in item && item.status).toBe("completed");
    }
  });

  const openPresentation = {
    label: { pending: "Reading file", completed: "Read file" },
    icon: { glyph: "FileText" },
    title: "src/index.ts",
  };
  const closePresentation = {
    ...openPresentation,
    detail: "12 lines",
  };

  function toolOpen(
    providerItemId: string,
    presentation?: typeof openPresentation,
  ): ThreadDelta {
    return {
      kind: "item.open",
      key: { providerItemId },
      item: { type: "tool", tool: "Read", args: { path: "src/index.ts" } },
      ...(presentation === undefined ? {} : { presentation }),
    };
  }

  function itemOf(event: ThreadEvent | undefined) {
    return event?.type === "item/started" || event?.type === "item/completed"
      ? event.item
      : undefined;
  }

  it("persists the open presentation and echoes it onto a close that carries none", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const started = itemOf(
      assemble(assembler, toolOpen("tc-1", openPresentation))[0],
    );
    expect(started).toMatchObject({
      type: "toolCall",
      presentation: openPresentation,
    });

    const closed = itemOf(
      assemble(assembler, {
        kind: "item.close",
        key: { providerItemId: "tc-1" },
        status: "completed",
        item: { type: "tool", tool: "Read", result: "…" },
      })[0],
    );
    expect(closed).toMatchObject({
      type: "toolCall",
      status: "completed",
      presentation: openPresentation,
    });
  });

  it("lets the close's presentation win over the opened one", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, toolOpen("tc-1", openPresentation));
    const closed = itemOf(
      assemble(assembler, {
        kind: "item.close",
        key: { providerItemId: "tc-1" },
        status: "completed",
        item: { type: "tool", tool: "Read" },
        presentation: closePresentation,
      })[0],
    );
    expect(closed).toMatchObject({ presentation: closePresentation });
  });

  it("keeps each settled shape's own presentation on a dual-settle", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, toolOpen("tc-re", openPresentation));
    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "tc-re" },
      status: "completed",
      item: {
        type: "fileChange",
        changes: [{ path: "/tmp/a.ts", kind: "update", diff: "+x" }],
      },
      presentation: closePresentation,
    });
    const settled = events.map(itemOf);
    expect(settled.map((item) => item?.type)).toEqual([
      "toolCall",
      "fileChange",
    ]);
    expect(settled[0]).toMatchObject({ presentation: openPresentation });
    expect(settled[1]).toMatchObject({ presentation: closePresentation });
  });

  it("adds no presentation key to v2 items that never carried one", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const started = itemOf(assemble(assembler, toolOpen("tc-1"))[0]);
    const closed = itemOf(
      assemble(assembler, {
        kind: "item.close",
        key: { providerItemId: "tc-1" },
        status: "completed",
        item: { type: "tool", tool: "Read" },
      })[0],
    );
    expect(started).not.toHaveProperty("presentation");
    expect(closed).not.toHaveProperty("presentation");
  });

  it("clears pairing state at the turn boundary so late closes get bare items", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" }, bashOpen("tc-1"));
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    assemble(assembler, { kind: "turn.open" });
    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "tc-1" },
      status: "completed",
      aggregatedOutput: "late output",
      item: { type: "command", command: "", cwd: "" },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "",
          cwd: "",
          aggregatedOutput: "late output",
        }),
      }),
    ]);
  });

  it("builds file-change items with diffs from the carried changes", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const editShape: DeltaItemShape = {
      type: "fileChange",
      changes: [
        {
          path: "src/app.ts",
          kind: "update",
          oldText: "const enabled = false;\n",
          newText: "const enabled = true;\n",
        },
      ],
    };
    const started = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-edit" },
      item: editShape,
    });
    expect(started[0]).toMatchObject({
      type: "item/started",
      item: {
        type: "fileChange",
        status: "pending",
        changes: [
          expect.objectContaining({
            path: "src/app.ts",
            kind: "update",
            diff: expect.stringContaining("const enabled = true;"),
          }),
        ],
      },
    });
    const closed = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "tc-edit" },
      status: "completed",
      item: editShape,
    });
    expect(closed[0]).toMatchObject({
      type: "item/completed",
      item: {
        type: "fileChange",
        status: "completed",
        changes: [expect.objectContaining({ path: "src/app.ts" })],
      },
    });
  });

  it("maps parentRef through the provider→bb id map for nested items", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const parentStarted = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "agent-parent-1" },
      item: { type: "tool", tool: "task", args: {} },
    });
    const parentBbId =
      parentStarted[0]?.type === "item/started" ? parentStarted[0].item.id : "";
    const childStarted = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-child", parentRef: "agent-parent-1" },
      item: { type: "command", command: "ls", cwd: "/repo" },
    });
    expect(childStarted[0]).toMatchObject({
      type: "item/started",
      item: { parentToolCallId: parentBbId },
    });
  });

  it("a child-first parentRef mints the parent id instead of leaking the raw provider id", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const childStarted = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-child", parentRef: "agent-parent-1" },
      item: { type: "command", command: "ls", cwd: "/repo" },
    });
    const childParentId =
      childStarted[0]?.type === "item/started"
        ? childStarted[0].item.parentToolCallId
        : undefined;
    expect(childParentId).toBeDefined();
    expect(childParentId).not.toBe("agent-parent-1");
    const parentStarted = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "agent-parent-1" },
      item: { type: "tool", tool: "task", args: {} },
    });
    expect(parentStarted[0]).toMatchObject({
      type: "item/started",
      item: { id: childParentId },
    });
  });

  it("diffs cumulative snapshots into append deltas and resets", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" }, bashOpen("tc-1"));
    const first = assemble(assembler, {
      kind: "command.outputSnapshot",
      key: { providerItemId: "tc-1" },
      text: "FIRST\n",
    });
    expect(first).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "FIRST\n",
      }),
    ]);
    expect(
      assemble(assembler, {
        kind: "command.outputSnapshot",
        key: { providerItemId: "tc-1" },
        text: "FIRST\n",
      }),
    ).toEqual([]);
    const appended = assemble(assembler, {
      kind: "command.outputSnapshot",
      key: { providerItemId: "tc-1" },
      text: "FIRST\nSECOND\n",
    });
    expect(appended).toEqual([expect.objectContaining({ delta: "SECOND\n" })]);
    const reset = assemble(assembler, {
      kind: "command.outputSnapshot",
      key: { providerItemId: "tc-1" },
      text: "RESET\n",
    });
    expect(reset).toEqual([
      expect.objectContaining({ delta: "RESET\n", reset: true }),
    ]);
  });

  it("addresses output deltas by the minted bb item id", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const started = assemble(assembler, bashOpen("tc-1"));
    const bbItemId =
      started[0]?.type === "item/started" ? started[0].item.id : "";
    const events = assemble(assembler, {
      kind: "command.outputSnapshot",
      key: { providerItemId: "tc-1" },
      text: "OUT\n",
    });
    expect(events).toEqual([
      expect.objectContaining({ itemId: bbItemId, delta: "OUT\n" }),
    ]);
    expect(assembler.getBbItemId(THREAD_ID, "tc-1")).toBe(bbItemId);
    expect(assembler.getProviderItemId(THREAD_ID, bbItemId)).toBe("tc-1");
  });

  it("drops snapshots for items it never saw open", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    expect(
      assemble(assembler, {
        kind: "command.outputSnapshot",
        key: { providerItemId: "tc-unknown" },
        text: "OUT\n",
      }),
    ).toEqual([]);
  });

  it("clears snapshot history across turns so a repeat emits in full", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" }, bashOpen("tc-1"), {
      kind: "command.outputSnapshot",
      key: { providerItemId: "tc-1" },
      text: "FIRST\n",
    });
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    assemble(assembler, { kind: "turn.open" }, bashOpen("tc-1"));
    const events = assemble(assembler, {
      kind: "command.outputSnapshot",
      key: { providerItemId: "tc-1" },
      text: "FIRST\nSECOND\n",
    });
    expect(events).toEqual([
      expect.objectContaining({ delta: "FIRST\nSECOND\n" }),
    ]);
  });

  it("attaches currentOrLast context-window updates to the turn that just closed", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    const events = assemble(assembler, {
      kind: "contextWindow",
      used: 54_321,
      size: 123_456,
      estimated: true,
      attach: "currentOrLast",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        scope: turnScope(turnId),
        contextWindowUsage: {
          usedTokens: 54_321,
          modelContextWindow: 123_456,
          estimated: true,
        },
      }),
    ]);
  });

  it("falls back to thread scope when no turn ever opened for a context-window update", () => {
    const assembler = createAssembler();
    const events = assemble(assembler, {
      kind: "contextWindow",
      used: 10,
      estimated: true,
      attach: "currentOrLast",
    });
    expect(events).toEqual([expect.objectContaining({ scope: threadScope() })]);
  });

  it("scopes context.compacted to the current-or-last turn and drops it with none", () => {
    const assembler = createAssembler();
    expect(assemble(assembler, { kind: "context.compacted" })).toEqual([]);
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    expect(assemble(assembler, { kind: "context.compacted" })).toEqual([
      expect.objectContaining({
        type: "thread/compacted",
        scope: turnScope(turnId),
      }),
    ]);
  });

  it("a settling error fails the open turn after the error event", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    const events = assemble(assembler, {
      kind: "provider.error",
      message: "Provider error",
      detail: "quota exhausted",
      settlesTurn: true,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: "quota exhausted",
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "failed",
      }),
    ]);
    expect(assembler.getOpenTurnId(THREAD_ID)).toBeUndefined();
  });

  it("a settling error claims a turn through pending accepted input", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "input.accepted", clientRequestId: CREQ });
    const events = assemble(assembler, {
      kind: "provider.error",
      message: "Provider error",
      settlesTurn: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "provider/error",
      "turn/completed",
    ]);
  });

  it("an idle settling error stays a thread-scoped diagnostic and fabricates no turn", () => {
    const assembler = createAssembler();
    const events = assemble(assembler, {
      kind: "provider.error",
      message: "Provider error",
      settlesTurn: true,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: threadScope(),
      }),
    ]);
  });

  it("a retry error keeps the turn open", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const events = assemble(assembler, {
      kind: "provider.error",
      message: "Provider error",
      detail: "temporary failure",
      willRetry: true,
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "provider/error", willRetry: true }),
    ]);
    expect(assembler.getOpenTurnId(THREAD_ID)).toBeDefined();
  });

  it("scopes unhandled events to the open turn only when vouched", () => {
    const assembler = createAssembler();
    const raw = {
      jsonrpc: "2.0" as const,
      method: "sdk/message",
      params: { future: true },
    };
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    const vouched = assemble(assembler, {
      kind: "unhandled",
      raw,
      rawType: "sdk/unknown",
      vouchedTurn: true,
    });
    expect(vouched).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/unknown",
        rawEvent: raw,
        scope: turnScope(turnId),
      }),
    ]);
    const unvouched = assemble(assembler, {
      kind: "unhandled",
      raw,
      rawType: "sdk/unknown",
      vouchedTurn: false,
    });
    expect(unvouched).toEqual([
      expect.objectContaining({ scope: threadScope() }),
    ]);
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    const late = assemble(assembler, {
      kind: "unhandled",
      raw,
      rawType: "sdk/unknown",
      vouchedTurn: true,
    });
    expect(late).toEqual([expect.objectContaining({ scope: threadScope() })]);
  });

  it("drops onlyIfNoTurn unhandled events while a turn is open", () => {
    const assembler = createAssembler();
    const raw = {
      jsonrpc: "2.0" as const,
      method: "acp/update",
      params: { update: { sessionUpdate: "tool_call_update" } },
    };
    assemble(assembler, { kind: "turn.open" });
    expect(
      assemble(assembler, {
        kind: "unhandled",
        raw,
        rawType: "acp/update:tool_call_update",
        vouchedTurn: false,
        onlyIfNoTurn: true,
      }),
    ).toEqual([]);
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    expect(
      assemble(assembler, {
        kind: "unhandled",
        raw,
        rawType: "acp/update:tool_call_update",
        vouchedTurn: false,
        onlyIfNoTurn: true,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        scope: threadScope(),
      }),
    ]);
  });

  it("scopes vouched warnings to the open turn and idle warnings to the thread", () => {
    const assembler = createAssembler();
    expect(
      assemble(assembler, {
        kind: "provider.warning",
        summary: "History not restored",
        vouchedTurn: true,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "provider/warning",
        summary: "History not restored",
        category: "general",
        scope: threadScope(),
      }),
    ]);
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    expect(
      assemble(assembler, {
        kind: "provider.warning",
        summary: "Mid-turn warning",
        vouchedTurn: true,
      }),
    ).toEqual([expect.objectContaining({ scope: turnScope(turnId) })]);
  });

  it("never fabricates a turn for turnless item deltas: fallback surfaces, no fallback drops", () => {
    const assembler = createAssembler();
    const raw = {
      jsonrpc: "2.0" as const,
      method: "sdk/message",
      params: { message: { type: "tool_execution_start" } },
    };
    const surfaced = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-1" },
      item: { type: "command", command: "npm test", cwd: "/repo" },
      noTurnFallback: { raw, rawType: "sdk/tool_execution_start" },
    });
    expect(surfaced).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/tool_execution_start",
        rawEvent: raw,
        scope: threadScope(),
      }),
    ]);
    expect(
      assemble(assembler, {
        kind: "item.textDelta",
        key: { channel: "assistant" },
        channel: "agentMessage",
        text: "orphan",
      }),
    ).toEqual([]);
    expect(assembler.getOpenTurnId(THREAD_ID)).toBeUndefined();
  });

  it("turnless item deltas do not claim pending accepted input", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "input.accepted", clientRequestId: CREQ });
    expect(
      assemble(assembler, {
        kind: "item.close",
        key: { providerItemId: "tc-1" },
        status: "completed",
        item: { type: "command", command: "", cwd: "" },
      }),
    ).toEqual([]);
    const events = assemble(assembler, {
      kind: "turn.boundary",
      status: "completed",
      claimIfIdle: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "turn/completed",
    ]);
  });

  it("session.ended interrupts the open turn and its open items", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" }, bashOpen("tc-1"));
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    const events = assemble(assembler, { kind: "session.ended" });
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "npm test",
          status: "interrupted",
        }),
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "interrupted",
      }),
    ]);
    expect(assembler.getOpenTurnId(THREAD_ID)).toBeUndefined();
  });

  it("session.ended on an idle thread with no pending input settles nothing", () => {
    const assembler = createAssembler();
    expect(assemble(assembler, { kind: "session.ended" })).toEqual([]);
  });

  it("session.ended claims and settles a turn owed to pending accepted input", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "input.accepted", clientRequestId: CREQ });
    const events = assemble(assembler, { kind: "session.ended" });
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "turn/completed",
    ]);
  });

  it("keeps threads isolated and ids unique across threads", () => {
    const assembler = createAssembler();
    const a = assembler.assemble({
      threadId: "thr_a",
      deltas: [{ kind: "turn.open" }],
    });
    const b = assembler.assemble({
      threadId: "thr_b",
      deltas: [{ kind: "turn.open" }],
    });
    const turnIdOf = (event: ThreadEvent | undefined): string =>
      event !== undefined && "scope" in event && event.scope.kind === "turn"
        ? event.scope.turnId
        : "";
    expect(turnIdOf(a[0])).not.toBe(turnIdOf(b[0]));
    expect(assembler.getOpenTurnId("thr_a")).toBe(turnIdOf(a[0]));
    expect(assembler.getOpenTurnId("thr_b")).toBe(turnIdOf(b[0]));
  });
});

describe("diffCumulativeText", () => {
  it("returns the full text on the first snapshot", () => {
    expect(diffCumulativeText({ nextText: "A\n" })).toEqual({
      delta: "A\n",
      nextText: "A\n",
      reset: false,
    });
  });

  it("returns only the appended suffix", () => {
    expect(
      diffCumulativeText({ previousText: "A\n", nextText: "A\nB\n" }),
    ).toEqual({ delta: "B\n", nextText: "A\nB\n", reset: false });
  });

  it("returns null for identical or empty snapshots", () => {
    expect(diffCumulativeText({ previousText: "A\n", nextText: "A\n" })).toBe(
      null,
    );
    expect(diffCumulativeText({ previousText: "A\n", nextText: "" })).toBe(
      null,
    );
  });

  it("flags a reset when the snapshot restarted", () => {
    expect(
      diffCumulativeText({ previousText: "A\nB\n", nextText: "C\n" }),
    ).toEqual({ delta: "C\n", nextText: "C\n", reset: true });
  });
});

describe("delta assembler (keyed provider turns)", () => {
  it("keeps several keyed turns open at once and settles only the named one", () => {
    const assembler = createAssembler();
    const events = assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "parent-turn" },
      { kind: "turn.open", providerTurnId: "child-turn" },
      {
        kind: "turn.boundary",
        providerTurnId: "child-turn",
        status: "completed",
      },
      {
        kind: "item.close",
        key: { providerItemId: "msg-1" },
        status: "completed",
        item: { type: "agentMessage", text: "still going" },
        providerTurnId: "parent-turn",
      },
    );
    const parentTurnId = assembler.getBbTurnId(THREAD_ID, "parent-turn") ?? "";
    const childTurnId = assembler.getBbTurnId(THREAD_ID, "child-turn") ?? "";
    expect(parentTurnId).not.toBe(childTurnId);
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/started",
      "turn/completed",
      "item/completed",
    ]);
    expect(events[3]).toMatchObject({ scope: turnScope(parentTurnId) });
    expect(assembler.getProviderTurnId(THREAD_ID, parentTurnId)).toBe(
      "parent-turn",
    );
  });

  it("scopes a delta for a never-opened vouched turn without fabricating turn/started", () => {
    const assembler = createAssembler();
    const events = assemble(assembler, {
      kind: "context.compacted",
      providerTurnId: "turn-x",
    });
    expect(events.map((event) => event.type)).toEqual(["thread/compacted"]);
    const turnId = assembler.getBbTurnId(THREAD_ID, "turn-x") ?? "";
    expect(events[0]).toMatchObject({ scope: turnScope(turnId) });
  });

  it("acknowledges vouched accepted input against the named turn, not a queue", () => {
    const assembler = createAssembler();
    const events = assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "turn-1" },
      {
        kind: "input.accepted",
        clientRequestId: CREQ,
        providerTurnId: "turn-1",
      },
    );
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
    ]);
    expect(events[1]).toMatchObject({
      clientRequestId: CREQ,
      scope: events[0]?.scope,
    });
  });

  it("synthesizes item/started for a delta-first textDelta and reuses the id on close", () => {
    const assembler = createAssembler();
    const events = assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "turn-1" },
      {
        kind: "item.textDelta",
        key: { providerItemId: "msg-1" },
        channel: "agentMessage",
        text: "hel",
        providerTurnId: "turn-1",
      },
      {
        kind: "item.textDelta",
        key: { providerItemId: "msg-1" },
        channel: "agentMessage",
        text: "lo",
        providerTurnId: "turn-1",
      },
      {
        kind: "item.close",
        key: { providerItemId: "msg-1" },
        status: "completed",
        item: { type: "agentMessage", text: "hello" },
        providerTurnId: "turn-1",
      },
    );
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      "item/completed",
    ]);
    const startedId =
      events[1]?.type === "item/started" ? events[1].item.id : "";
    expect(startedId).not.toBe("");
    expect(events[4]).toMatchObject({
      item: { type: "agentMessage", id: startedId, text: "hello" },
    });
  });

  it("never synthesizes an open for output deltas", () => {
    const assembler = createAssembler();
    const events = assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "turn-1" },
      {
        kind: "item.outputDelta",
        key: { providerItemId: "cmd-1" },
        channel: "command",
        text: "line\n",
        providerTurnId: "turn-1",
      },
    );
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "item/commandExecution/outputDelta",
    ]);
    const itemId = assembler.getBbItemId(THREAD_ID, "cmd-1") ?? "";
    expect(events[1]).toMatchObject({ itemId, delta: "line\n" });
  });

  it("drops a repeated provider-identified close and reopens on explicit open", () => {
    const assembler = createAssembler();
    const close: ThreadDelta = {
      kind: "item.close",
      key: { providerItemId: "cmd-1" },
      status: "completed",
      item: { type: "command", command: "git status", cwd: "/repo" },
      providerTurnId: "turn-1",
    };
    const open: ThreadDelta = {
      kind: "item.open",
      key: { providerItemId: "cmd-1" },
      item: { type: "command", command: "git status", cwd: "/repo" },
      providerTurnId: "turn-1",
    };
    const events = assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "turn-1" },
      open,
      close,
      close,
      open,
      close,
    );
    const completions = events.filter(
      (event) => event.type === "item/completed",
    );
    expect(completions).toHaveLength(2);
    const itemId = assembler.getBbItemId(THREAD_ID, "cmd-1") ?? "";
    expect(
      events
        .filter((event) => event.type === "item/started")
        .map((event) => (event.type === "item/started" ? event.item.id : "")),
    ).toEqual([itemId, itemId]);
  });

  it("does not dedup channel-keyed closes (bridge-local item families)", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const write: ThreadDelta = {
      kind: "item.close",
      key: { channel: "fs-write" },
      status: "completed",
      item: {
        type: "fileChange",
        changes: [{ path: "a.txt", kind: "add", newText: "hi\n" }],
      },
    };
    const events = assemble(assembler, write, write);
    expect(
      events.filter((event) => event.type === "item/completed"),
    ).toHaveLength(2);
  });

  it("session.reset starts a fresh provider id space for the thread", () => {
    const assembler = createAssembler();
    assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "turn-1" },
      bashOpen("cmd-1"),
    );
    const firstItemId = assembler.getBbItemId(THREAD_ID, "cmd-1") ?? "";
    assemble(assembler, { kind: "session.reset" });
    expect(assembler.getBbTurnId(THREAD_ID, "turn-1")).toBeUndefined();
    const events = assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "turn-1" },
      {
        kind: "item.open",
        key: { providerItemId: "cmd-1" },
        item: { type: "command", command: "npm test", cwd: "/repo" },
        providerTurnId: "turn-1",
      },
    );
    const reopenedId =
      events[1]?.type === "item/started" ? events[1].item.id : "";
    expect(reopenedId).not.toBe("");
    expect(reopenedId).not.toBe(firstItemId);
  });

  it("threadScoped errors never adopt the open turn; vouched errors scope to it", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open", providerTurnId: "turn-1" });
    const turnId = assembler.getBbTurnId(THREAD_ID, "turn-1") ?? "";
    const [threadScoped] = assemble(assembler, {
      kind: "provider.error",
      message: "Provider error",
      detail: "boom",
      threadScoped: true,
    });
    expect(threadScoped).toMatchObject({ scope: threadScope() });
    const [vouched] = assemble(assembler, {
      kind: "provider.error",
      message: "Provider error",
      detail: "boom",
      providerTurnId: "turn-1",
      errorInfo: {
        category: "stream-disconnected",
        providerCode: "responseStreamDisconnected",
        httpStatusCode: 502,
      },
    });
    expect(vouched).toMatchObject({
      scope: turnScope(turnId),
      errorInfo: { category: "stream-disconnected", httpStatusCode: 502 },
    });
  });
});

describe("delta assembler unified streaming dialect", () => {
  const assistantKey = { channel: "assistant" };

  function textDelta(
    key: { providerItemId?: string; channel?: string; parentRef?: string },
    channel: "agentMessage" | "reasoningText" | "reasoningSummary" | "plan",
    text: string,
  ): ThreadDelta {
    return { kind: "item.textDelta", key, channel, text };
  }

  function itemOf(event: ThreadEvent | undefined) {
    return event?.type === "item/started" || event?.type === "item/completed"
      ? event.item
      : undefined;
  }

  it("synthesizes item/started for an anonymous stream and settles it from the accumulated text", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const first = assemble(
      assembler,
      textDelta(assistantKey, "agentMessage", "Hel"),
    );
    expect(first.map((event) => event.type)).toEqual([
      "item/started",
      "item/agentMessage/delta",
    ]);
    const itemId = itemOf(first[0])?.id ?? "";
    assemble(assembler, textDelta(assistantKey, "agentMessage", "lo"));
    const closed = assemble(assembler, {
      kind: "item.textClose",
      key: assistantKey,
      channel: "agentMessage",
    });
    expect(closed).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: { type: "agentMessage", id: itemId, text: "Hello" },
      }),
    ]);
    const next = assemble(
      assembler,
      textDelta(assistantKey, "agentMessage", "again"),
    );
    expect(next[0]?.type).toBe("item/started");
    expect(itemOf(next[0])?.id).not.toBe(itemId);
  });

  it("prefers provider-final text on close, and a bare close with text completes a fresh item", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const first = assemble(
      assembler,
      textDelta(assistantKey, "agentMessage", "partial"),
    );
    const itemId = itemOf(first[0])?.id ?? "";
    const closed = assemble(assembler, {
      kind: "item.textClose",
      key: assistantKey,
      channel: "agentMessage",
      text: "final text",
    });
    expect(itemOf(closed[0])).toEqual({
      type: "agentMessage",
      id: itemId,
      text: "final text",
    });
    const bare = assemble(assembler, {
      kind: "item.textClose",
      key: { channel: "thinking-0" },
      channel: "reasoningText",
      text: "thought it through",
    });
    expect(bare.map((event) => event.type)).toEqual(["item/completed"]);
    expect(itemOf(bare[0])).toMatchObject({
      type: "reasoning",
      summary: [],
      content: ["thought it through"],
    });
  });

  it("completes nothing for a whitespace-only or empty accumulated close but still releases the key", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, textDelta(assistantKey, "agentMessage", "  \n"));
    expect(
      assemble(assembler, {
        kind: "item.textClose",
        key: assistantKey,
        channel: "agentMessage",
      }),
    ).toEqual([]);
    expect(
      assemble(assembler, {
        kind: "item.textClose",
        key: { channel: "thought" },
        channel: "reasoningText",
      }),
    ).toEqual([]);
    const next = assemble(
      assembler,
      textDelta(assistantKey, "agentMessage", "real"),
    );
    expect(next[0]?.type).toBe("item/started");
  });

  it("keeps reasoning summary and content on their own channels", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const key = { providerItemId: "rs-1" };
    const first = assemble(
      assembler,
      textDelta(key, "reasoningSummary", "Sum"),
    );
    expect(first.map((event) => event.type)).toEqual([
      "item/started",
      "item/reasoning/summaryTextDelta",
    ]);
    assemble(assembler, textDelta(key, "reasoningText", "Body"));
    const closed = assemble(assembler, {
      kind: "item.textClose",
      key,
      channel: "reasoningText",
    });
    expect(itemOf(closed[0])).toMatchObject({
      type: "reasoning",
      summary: ["Sum"],
      content: ["Body"],
    });
    expect(
      assemble(assembler, {
        kind: "item.textClose",
        key,
        channel: "reasoningText",
        text: "again",
      }),
    ).toEqual([]);
  });

  it("a tool item.open releases anonymous assistant streams in its scope but not provider-named items", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const anonymous = assemble(
      assembler,
      textDelta(
        { channel: "assistant", parentRef: "agent-1" },
        "agentMessage",
        "a",
      ),
    );
    const named = assemble(
      assembler,
      textDelta({ providerItemId: "msg-1" }, "agentMessage", "b"),
    );
    const anonymousId = itemOf(anonymous[0])?.id;
    const namedId = itemOf(named[0])?.id;
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-root" },
      item: { type: "tool", tool: "Read" },
    });
    expect(
      itemOf(
        assemble(
          assembler,
          textDelta(
            { channel: "assistant", parentRef: "agent-1" },
            "agentMessage",
            "a2",
          ),
        )[0],
      ),
    ).toBeUndefined();
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-child", parentRef: "agent-1" },
      item: { type: "tool", tool: "Read" },
    });
    const afterAnonymous = assemble(
      assembler,
      textDelta(
        { channel: "assistant", parentRef: "agent-1" },
        "agentMessage",
        "a3",
      ),
    );
    expect(afterAnonymous[0]?.type).toBe("item/started");
    expect(itemOf(afterAnonymous[0])?.id).not.toBe(anonymousId);
    const afterNamed = assemble(
      assembler,
      textDelta({ providerItemId: "msg-1" }, "agentMessage", "b2"),
    );
    expect(afterNamed).toEqual([
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: namedId,
      }),
    ]);
  });

  it("session.ended settles a streamed item with its text and an unstreamed one with its opened shape", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "msg-1" },
      item: { type: "agentMessage", text: "" },
    });
    assemble(
      assembler,
      textDelta({ providerItemId: "msg-1" }, "agentMessage", "partial"),
    );
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "msg-2" },
      item: { type: "agentMessage", text: "opened whole" },
    });
    const events = assemble(assembler, { kind: "session.ended" });
    expect(events.map((event) => itemOf(event) ?? event.type)).toEqual([
      expect.objectContaining({ type: "agentMessage", text: "partial" }),
      expect.objectContaining({ type: "agentMessage", text: "opened whole" }),
      "turn/completed",
    ]);
  });
});

describe("delta assembler unified usage dialect", () => {
  const usage = {
    totalTokens: 50,
    inputTokens: 30,
    cachedInputTokens: 5,
    outputTokens: 15,
    reasoningOutputTokens: 0,
  };

  it("forwards usage verbatim to the open-or-last turn and never accumulates", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    const events = assemble(assembler, {
      kind: "usage",
      total: { ...usage, totalTokens: 100 },
      last: usage,
      modelContextWindow: 128_000,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        scope: turnScope(turnId),
        tokenUsage: {
          total: { ...usage, totalTokens: 100 },
          last: usage,
          modelContextWindow: 128_000,
        },
      }),
    ]);
    const again = assemble(assembler, {
      kind: "usage",
      total: { ...usage, totalTokens: 100 },
      last: usage,
      modelContextWindow: 128_000,
    });
    expect(again[0]).toMatchObject({
      tokenUsage: { total: { totalTokens: 100 } },
    });
  });

  it("scopes usage and a contextWindow reading to a vouched provider turn", () => {
    const assembler = createAssembler();
    const events = assemble(
      assembler,
      { kind: "turn.open", providerTurnId: "turn-1" },
      {
        kind: "usage",
        total: usage,
        last: usage,
        modelContextWindow: 128_000,
        providerTurnId: "turn-1",
      },
      {
        kind: "contextWindow",
        used: usage.totalTokens,
        size: 128_000,
        estimated: false,
        attach: "currentOrLast",
        providerTurnId: "turn-1",
      },
    );
    const turnId = assembler.getBbTurnId(THREAD_ID, "turn-1") ?? "";
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "thread/tokenUsage/updated",
      "thread/contextWindowUsage/updated",
    ]);
    expect(events[1]).toMatchObject({ scope: turnScope(turnId) });
    expect(events[2]).toMatchObject({
      scope: turnScope(turnId),
      contextWindowUsage: {
        usedTokens: 50,
        modelContextWindow: 128_000,
        estimated: false,
      },
    });
  });

  it("drops usage with no turn to attach to", () => {
    const assembler = createAssembler();
    expect(
      assemble(assembler, {
        kind: "usage",
        total: usage,
        last: usage,
        modelContextWindow: null,
      }),
    ).toEqual([]);
  });
});

describe("delta assembler grammar v3 core kinds", () => {
  function itemOf(event: ThreadEvent | undefined) {
    switch (event?.type) {
      case "item/started":
      case "item/completed":
      case "item/delegation/progress":
      case "item/delegation/completed":
        return event.item;
      default:
        return undefined;
    }
  }

  it.each([
    {
      shape: {
        type: "fileRead",
        path: "src/index.ts",
        cmd: "cat src/index.ts",
      },
      started: {
        type: "fileRead",
        path: "src/index.ts",
        cmd: "cat src/index.ts",
        status: "pending",
      },
    },
    {
      shape: {
        type: "search",
        mode: "content",
        query: "TODO",
        path: "src",
        cmd: "rg TODO src",
      },
      started: {
        type: "search",
        mode: "content",
        query: "TODO",
        path: "src",
        status: "pending",
      },
    },
    {
      shape: {
        type: "planSteps",
        steps: [{ step: "Read the spec", status: "completed" }],
        explanation: "first pass",
      },
      started: {
        type: "planSteps",
        steps: [{ step: "Read the spec", status: "completed" }],
        explanation: "first pass",
        status: "pending",
      },
    },
  ] satisfies { shape: DeltaItemShape; started: object }[])(
    "opens $shape.type pending and settles it from the terminal shape under one id",
    ({ shape, started }) => {
      const assembler = createAssembler();
      assemble(assembler, { kind: "turn.open" });
      const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
      const [open] = assemble(assembler, {
        kind: "item.open",
        key: { providerItemId: "v3-1", parentRef: "agent-1" },
        item: shape,
      });
      expect(open).toMatchObject({
        type: "item/started",
        scope: turnScope(turnId),
      });
      const startedItem = itemOf(open);
      expect(startedItem).toMatchObject(started);
      const parentId = startedItem?.parentToolCallId ?? "";
      expect(parentId).not.toBe("");
      expect(parentId).not.toBe("agent-1");

      const [closed] = assemble(assembler, {
        kind: "item.close",
        key: { providerItemId: "v3-1", parentRef: "agent-1" },
        status: "failed",
        item: shape,
      });
      expect(closed?.type).toBe("item/completed");
      expect(itemOf(closed)).toMatchObject({
        ...started,
        id: startedItem?.id,
        status: "failed",
        parentToolCallId: parentId,
      });
    },
  );

  it("omits optional fileRead/search fields the shape never carried", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const [read] = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "r-1" },
      item: { type: "fileRead", path: "README.md" },
    });
    expect(itemOf(read)).not.toHaveProperty("cmd");
    const [search] = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "s-1" },
      item: { type: "search", mode: "list", query: "" },
    });
    expect(itemOf(search)).not.toHaveProperty("path");
    expect(itemOf(search)).not.toHaveProperty("cmd");
  });

  it("settles a v3 item opened as a generic tool and re-shaped at close (dual-settle)", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "tc-1" },
      item: { type: "tool", tool: "Read", args: { path: "a.ts" } },
    });
    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "tc-1" },
      status: "completed",
      item: { type: "fileRead", path: "a.ts" },
    });
    expect(events.map((event) => itemOf(event)?.type)).toEqual([
      "toolCall",
      "fileRead",
    ]);
    expect(new Set(events.map((event) => itemOf(event)?.id)).size).toBe(1);
  });

  it("interrupts open v3 items on session.ended with their started fields", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(
      assembler,
      {
        kind: "item.open",
        key: { providerItemId: "r-1" },
        item: { type: "fileRead", path: "a.ts" },
      },
      {
        kind: "item.open",
        key: { providerItemId: "d-1" },
        item: {
          type: "delegation",
          childRef: "child-1",
          label: "Explore",
          background: false,
        },
      },
    );
    const events = assemble(assembler, { kind: "session.ended" });
    expect(events.map((event) => event.type)).toEqual([
      "item/completed",
      "item/completed",
      "turn/completed",
    ]);
    expect(itemOf(events[0])).toMatchObject({
      type: "fileRead",
      path: "a.ts",
      status: "interrupted",
    });
    expect(itemOf(events[1])).toMatchObject({
      type: "delegation",
      childRef: "child-1",
      status: "interrupted",
    });
  });

  it("settles a foreground delegation through the turn-scoped item/completed", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "d-1" },
      item: {
        type: "delegation",
        childRef: "child-1",
        label: "Explore the repo",
        background: false,
      },
    });
    const [closed] = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "d-1" },
      status: "completed",
      item: {
        type: "delegation",
        childRef: "child-1",
        label: "Explore the repo",
        background: false,
        summary: "Found three call sites.",
      },
    });
    expect(closed).toMatchObject({
      type: "item/completed",
      scope: turnScope(turnId),
      item: {
        type: "delegation",
        status: "completed",
        summary: "Found three call sites.",
      },
    });
  });

  it("routes a background delegation through thread-scoped progress and completion across turns", () => {
    const assembler = createDeltaAssembler({
      providerId: "claude-code",
      entropyPrefix: "as-test",
      textDeltaFlushMs: 0,
      progressThrottleMs: 0,
    });
    const presentation = {
      label: { pending: "Delegating", completed: "Delegated" },
      icon: { glyph: "Bot" },
    };
    assemble(assembler, { kind: "turn.open" });
    const spawningTurnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    const shape: DeltaItemShape = {
      type: "delegation",
      childRef: "agent-7",
      label: "Audit the tests",
      background: true,
    };
    const [started] = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "d-bg" },
      item: shape,
      presentation,
    });
    expect(started).toMatchObject({
      type: "item/started",
      scope: turnScope(spawningTurnId),
      item: { type: "delegation", status: "pending", presentation },
    });
    const delegationId = itemOf(started)?.id;

    const boundary = assemble(assembler, {
      kind: "turn.boundary",
      status: "completed",
    });
    expect(boundary.map((event) => event.type)).toEqual(["turn/completed"]);

    const [progress] = assemble(assembler, {
      kind: "item.progress",
      key: { providerItemId: "d-bg" },
      snapshot: { ...shape, summary: "Halfway through." },
    });
    expect(progress).toMatchObject({
      type: "item/delegation/progress",
      scope: threadScope(),
      item: {
        id: delegationId,
        status: "pending",
        summary: "Halfway through.",
        presentation,
      },
    });

    const [completed] = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "d-bg" },
      status: "completed",
      item: shape,
    });
    expect(completed).toMatchObject({
      type: "item/delegation/completed",
      scope: threadScope(),
      item: {
        id: delegationId,
        status: "completed",
        background: true,
        presentation,
      },
    });
    expect(itemOf(completed)).not.toHaveProperty("summary");
  });

  it("a background delegation close without an open builds the bare terminal item", () => {
    const assembler = createAssembler();
    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "d-late" },
      status: "failed",
      item: {
        type: "delegation",
        childRef: "agent-9",
        label: "Late child",
        background: true,
        summary: "Crashed.",
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/delegation/completed",
        scope: threadScope(),
        item: expect.objectContaining({
          type: "delegation",
          status: "failed",
          summary: "Crashed.",
        }),
      }),
    ]);
  });

  it("session.ended leaves background delegations open like background tasks", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "d-bg" },
      item: {
        type: "delegation",
        childRef: "agent-7",
        label: "Long audit",
        background: true,
      },
    });
    const events = assemble(assembler, { kind: "session.ended" });
    expect(events.map((event) => event.type)).toEqual(["turn/completed"]);
  });
});

describe("delta assembler extension kinds", () => {
  const presentation = {
    label: { pending: "Updating goal", completed: "Goal updated" },
    icon: { glyph: "Target" },
    title: "Ship WS1a",
  };

  function itemOf(event: ThreadEvent | undefined) {
    return event?.type === "item/started" || event?.type === "item/completed"
      ? event.item
      : undefined;
  }

  it("opens and settles an extension item with its opaque payload and the delta's presentation", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    const [started] = assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "x-1", parentRef: "agent-1" },
      item: {
        type: "extension",
        kind: "provider-codex/goal",
        payload: { objective: "Ship WS1a", tokensUsed: 12 },
      },
      presentation,
    });
    const startedItem = itemOf(started);
    expect(startedItem).toMatchObject({
      type: "extension",
      kind: "provider-codex/goal",
      payload: { objective: "Ship WS1a", tokensUsed: 12 },
      status: "pending",
      presentation,
    });
    expect(startedItem?.parentToolCallId).toBeDefined();

    const [closed] = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "x-1", parentRef: "agent-1" },
      status: "completed",
      item: {
        type: "extension",
        kind: "provider-codex/goal",
        payload: { objective: "Ship WS1a", tokensUsed: 40 },
      },
    });
    expect(itemOf(closed)).toEqual({
      ...startedItem,
      payload: { objective: "Ship WS1a", tokensUsed: 40 },
      status: "completed",
    });
  });

  it("treats two extension kinds as two classifications on close (dual-settle)", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "x-1" },
      item: { type: "extension", kind: "plugin-a/one", payload: 1 },
      presentation,
    });
    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "x-1" },
      status: "completed",
      item: { type: "extension", kind: "plugin-a/two", payload: 2 },
      presentation,
    });
    expect(
      events.map((event) => {
        const item = itemOf(event);
        return item?.type === "extension" ? item.kind : item?.type;
      }),
    ).toEqual(["plugin-a/one", "plugin-a/two"]);
  });

  it("interrupts an open extension item on session.ended with its presentation intact", () => {
    const assembler = createAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, {
      kind: "item.open",
      key: { providerItemId: "x-1" },
      item: { type: "extension", kind: "plugin-a/one", payload: null },
      presentation,
    });
    const [interrupted] = assemble(assembler, { kind: "session.ended" });
    expect(itemOf(interrupted)).toMatchObject({
      type: "extension",
      kind: "plugin-a/one",
      status: "interrupted",
      presentation,
    });
  });

  it("emits plugin thread state as a thread-scoped extensionState event", () => {
    const assembler = createAssembler();
    const events = assemble(assembler, {
      kind: "extension.state",
      extensionKind: "provider-codex/goal",
      payload: { objective: "Ship WS1a", status: "active" },
    });
    expect(events).toEqual([
      {
        type: "thread/extensionState/updated",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        kind: "provider-codex/goal",
        payload: { objective: "Ship WS1a", status: "active" },
      },
    ]);
  });
});

describe("delta assembler background tasks and progress policy", () => {
  function createClockedAssembler(progressThrottleMs?: number) {
    let nowMs = 0;
    const assembler = createDeltaAssembler({
      providerId: "claude-code",
      entropyPrefix: "as-test",
      now: () => nowMs,
      textDeltaFlushMs: 0,
      ...(progressThrottleMs === undefined ? {} : { progressThrottleMs }),
    });
    return {
      assembler,
      advance(ms: number) {
        nowMs += ms;
      },
    };
  }

  function taskShape(
    overrides: Partial<
      Extract<DeltaItemShape, { type: "backgroundTask" }>
    > = {},
  ): Extract<DeltaItemShape, { type: "backgroundTask" }> {
    return {
      type: "backgroundTask",
      familyId: "wf-1",
      taskType: "local_workflow",
      description: "run the workflow",
      status: "pending",
      taskStatus: "running",
      skipTranscript: false,
      ...overrides,
    };
  }

  const TASK_KEY = { providerItemId: "task:wf-1" };

  it("materializes started(turn) → progress(thread, throttled) → completed(thread)", () => {
    const { assembler, advance } = createClockedAssembler();
    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";

    const started = assemble(assembler, {
      kind: "item.open",
      key: TASK_KEY,
      item: taskShape(),
    });
    expect(started).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(turnId),
        item: expect.objectContaining({
          type: "backgroundTask",
          familyId: "wf-1",
          taskType: "local_workflow",
          status: "pending",
        }),
      }),
    ]);
    const itemId = assembler.getBbItemId(THREAD_ID, "task:wf-1") ?? "";
    expect(itemId).not.toBe("");

    advance(100);
    expect(
      assemble(assembler, {
        kind: "item.progress",
        key: TASK_KEY,
        snapshot: taskShape(),
      }),
    ).toEqual([]);

    advance(500);
    const progress = assemble(assembler, {
      kind: "item.progress",
      key: TASK_KEY,
      snapshot: taskShape({ summary: "still going" }),
    });
    expect(progress).toEqual([
      expect.objectContaining({
        type: "item/backgroundTask/progress",
        scope: threadScope(),
        item: expect.objectContaining({
          id: itemId,
          familyId: "wf-1",
          summary: "still going",
        }),
      }),
    ]);

    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    const completed = assemble(assembler, {
      kind: "item.close",
      key: TASK_KEY,
      status: "completed",
      item: taskShape({ status: "completed", taskStatus: "completed" }),
    });
    expect(completed).toEqual([
      expect.objectContaining({
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        item: expect.objectContaining({
          id: itemId,
          familyId: "wf-1",
          status: "completed",
          taskStatus: "completed",
        }),
      }),
    ]);
  });

  it("flush bypasses the throttle and resets the window", () => {
    const { assembler, advance } = createClockedAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      { kind: "item.open", key: TASK_KEY, item: taskShape() },
    );

    advance(100);
    const flushed = assemble(assembler, {
      kind: "item.progress",
      key: TASK_KEY,
      snapshot: taskShape({ taskStatus: "paused" }),
      flush: true,
    });
    expect(flushed).toHaveLength(1);

    advance(100);
    expect(
      assemble(assembler, {
        kind: "item.progress",
        key: TASK_KEY,
        snapshot: taskShape(),
      }),
    ).toEqual([]);
  });

  it("flushes the newest suppressed snapshot trailing-edge on later traffic", () => {
    const { assembler, advance } = createClockedAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      { kind: "item.open", key: TASK_KEY, item: taskShape() },
    );

    advance(100);
    expect(
      assemble(assembler, {
        kind: "item.progress",
        key: TASK_KEY,
        snapshot: taskShape({ summary: "suppressed" }),
      }),
    ).toEqual([]);

    advance(600);
    const events = assemble(assembler, {
      kind: "turn.boundary",
      status: "completed",
    });
    expect(events[0]).toMatchObject({
      type: "item/backgroundTask/progress",
      item: expect.objectContaining({ summary: "suppressed" }),
    });
    expect(events[1]).toMatchObject({ type: "turn/completed" });
  });

  it("session.reset drops suppressed progress instead of flushing it", () => {
    const { assembler, advance } = createClockedAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      { kind: "item.open", key: TASK_KEY, item: taskShape() },
    );
    advance(100);
    expect(
      assemble(assembler, {
        kind: "item.progress",
        key: TASK_KEY,
        snapshot: taskShape({ summary: "suppressed" }),
      }),
    ).toEqual([]);

    advance(600);
    expect(assemble(assembler, { kind: "session.reset" })).toEqual([]);

    const afterReset = assemble(assembler, { kind: "turn.open" });
    expect(afterReset.map((event) => event.type)).toEqual(["turn/started"]);
  });

  it("a close supersedes suppressed progress", () => {
    const { assembler, advance } = createClockedAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      { kind: "item.open", key: TASK_KEY, item: taskShape() },
    );
    advance(100);
    assemble(assembler, {
      kind: "item.progress",
      key: TASK_KEY,
      snapshot: taskShape({ summary: "suppressed" }),
    });
    advance(600);
    const events = assemble(assembler, {
      kind: "item.close",
      key: TASK_KEY,
      status: "completed",
      item: taskShape({ status: "completed", taskStatus: "completed" }),
    });
    expect(events.map((event) => event.type)).toEqual([
      "item/backgroundTask/progress",
      "item/backgroundTask/completed",
    ]);
  });

  it("drops turn-scoped pending progress with its turn, keeps thread pending", () => {
    const { assembler, advance } = createClockedAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      {
        kind: "item.open",
        key: { providerItemId: "tool-1" },
        item: { type: "tool", tool: "read" },
      },
    );
    advance(100);
    expect(
      assemble(assembler, {
        kind: "item.progress",
        key: { providerItemId: "tool-1" },
        message: "halfway",
      }),
    ).toEqual([]);
    assemble(assembler, { kind: "turn.boundary", status: "completed" });

    advance(600);
    expect(
      assemble(assembler, { kind: "turn.open" }).map((e) => e.type),
    ).toEqual(["turn/started"]);
  });

  it("message progress seeds its window at open and throttles per item", () => {
    const { assembler, advance } = createClockedAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      {
        kind: "item.open",
        key: { providerItemId: "tool-1" },
        item: { type: "tool", tool: "read" },
      },
    );
    advance(100);
    expect(
      assemble(assembler, {
        kind: "item.progress",
        key: { providerItemId: "tool-1" },
        message: "early",
      }),
    ).toEqual([]);
    advance(500);
    const events = assemble(assembler, {
      kind: "item.progress",
      key: { providerItemId: "tool-1" },
      message: "later",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: "later",
      }),
    ]);
  });

  it("keeps background-task ids across LRU pressure (open items pin the thread)", () => {
    const { assembler } = createClockedAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      { kind: "item.open", key: TASK_KEY, item: taskShape() },
      { kind: "turn.boundary", status: "completed" },
    );
    const itemId = assembler.getBbItemId(THREAD_ID, "task:wf-1") ?? "";
    for (let index = 0; index < 300; index += 1) {
      assembler.assemble({
        threadId: `filler-${index}`,
        deltas: [
          { kind: "turn.open" },
          { kind: "turn.boundary", status: "completed" },
        ],
      });
    }
    expect(assembler.getBbItemId(THREAD_ID, "task:wf-1")).toBe(itemId);
  });

  it("keeps queued accepted input across LRU pressure (pending input pins the thread)", () => {
    const { assembler } = createClockedAssembler();
    assemble(assembler, { kind: "input.accepted", clientRequestId: CREQ });
    for (let index = 0; index < 300; index += 1) {
      assembler.assemble({
        threadId: `filler-${index}`,
        deltas: [
          { kind: "turn.open" },
          { kind: "turn.boundary", status: "completed" },
        ],
      });
    }
    const events = assemble(assembler, { kind: "turn.open" });
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
    ]);
  });

  it("scopes provider.modelFallback to the current-or-last turn, thread when idle", () => {
    const assembler = createAssembler();
    const fallback = {
      kind: "provider.modelFallback",
      originalModel: "claude-fable-5",
      fallbackModel: "claude-opus-4-8",
      reason: "provider",
      message: "Switched from claude-fable-5 to claude-opus-4-8.",
    } as const;

    const [idle] = assemble(assembler, fallback);
    expect(idle).toMatchObject({
      type: "provider/modelFallback",
      scope: threadScope(),
      reason: "provider",
    });

    assemble(assembler, { kind: "turn.open" });
    const turnId = assembler.getOpenTurnId(THREAD_ID) ?? "";
    const [inTurn] = assemble(assembler, fallback);
    expect(inTurn).toMatchObject({ scope: turnScope(turnId) });

    assemble(assembler, { kind: "turn.boundary", status: "completed" });
    const [afterTurn] = assemble(assembler, fallback);
    expect(afterTurn).toMatchObject({ scope: turnScope(turnId) });
  });

  it("carries close resultText onto webSearch/webFetch terminal items", () => {
    const assembler = createAssembler();
    assemble(
      assembler,
      { kind: "turn.open" },
      {
        kind: "item.open",
        key: { providerItemId: "web-1" },
        item: { type: "webSearch", queries: ["react suspense"] },
      },
      {
        kind: "item.open",
        key: { providerItemId: "fetch-1" },
        item: {
          type: "webFetch",
          url: "https://example.com",
          prompt: "page title",
          pattern: null,
        },
      },
    );

    const events = assemble(
      assembler,
      {
        kind: "item.close",
        key: { providerItemId: "web-1" },
        status: "completed",
        resultText: "Found the Suspense docs",
        item: { type: "webSearch", queries: ["react suspense"] },
      },
      {
        kind: "item.close",
        key: { providerItemId: "fetch-1" },
        status: "completed",
        resultText: "Example Domain",
        item: {
          type: "webFetch",
          url: "https://example.com",
          prompt: "page title",
          pattern: null,
        },
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "webSearch",
          resultText: "Found the Suspense docs",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "webFetch",
          prompt: "page title",
          resultText: "Example Domain",
        }),
      }),
    );
  });
});

describe("bridge delta assembly helper", () => {
  it("throws on an invalid thread/delta notification instead of returning []", () => {
    const collector = createBridgeDeltaEventCollector("pi");
    expect(() =>
      collector.assembleMessage({
        method: "thread/delta",
        params: { threadId: THREAD_ID, deltas: [{ kind: "nope" }] },
      }),
    ).toThrowError(/Invalid thread\/delta notification/);
    expect(
      collector.assembleMessage({ method: "thread/identity", params: {} }),
    ).toEqual([]);
  });
});

describe("delta assembler text-delta batching", () => {
  function createBatchingAssembler(textDeltaFlushMs = 100) {
    let nowMs = 0;
    const assembler = createDeltaAssembler({
      providerId: "pi",
      entropyPrefix: "as-test",
      now: () => nowMs,
      textDeltaFlushMs,
    });
    return {
      assembler,
      advance(ms: number) {
        nowMs += ms;
      },
    };
  }

  function assistantDelta(text: string, parentRef?: string): ThreadDelta {
    return {
      kind: "item.textDelta",
      key: {
        channel: "assistant",
        ...(parentRef === undefined ? {} : { parentRef }),
      },
      channel: "agentMessage",
      text,
    };
  }

  function reasoningDelta(text: string): ThreadDelta {
    return {
      kind: "item.textDelta",
      key: { channel: "reasoning" },
      channel: "reasoningText",
      text,
    };
  }

  it("emits the first delta of a fresh stream immediately, then coalesces", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });

    const first = assemble(assembler, assistantDelta("Hel"));
    expect(first.map((event) => event.type)).toEqual([
      "item/started",
      "item/agentMessage/delta",
    ]);
    expect(first[1]).toMatchObject({ delta: "Hel" });

    advance(20);
    expect(assemble(assembler, assistantDelta("lo "))).toEqual([]);
    advance(20);
    expect(assemble(assembler, assistantDelta("wor"))).toEqual([]);

    advance(100);
    const flushed = assemble(assembler, assistantDelta("ld"));
    expect(flushed).toEqual([
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: "lo wor",
      }),
    ]);
    advance(200);
    expect(
      assemble(assembler, { kind: "turn.boundary", status: "completed" }).map(
        (event) => ("delta" in event ? event.delta : event.type),
      ),
    ).toEqual(["ld", "turn/completed"]);
  });

  it("a delta arriving after the window with no buffer emits alone at once", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("a"));
    advance(150);
    expect(assemble(assembler, assistantDelta("b"))).toEqual([
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: "b",
      }),
    ]);
  });

  it("flushes an elapsed buffer trailing-edge on the thread's next traffic", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("a"));
    advance(20);
    expect(assemble(assembler, assistantDelta("b"))).toEqual([]);

    advance(200);
    const events = assemble(assembler, {
      kind: "contextWindow",
      used: 10,
      size: 100,
      estimated: true,
      attach: "open",
    });
    expect(events.map((event) => event.type)).toEqual([
      "item/agentMessage/delta",
      "thread/contextWindowUsage/updated",
    ]);
    expect(events[0]).toMatchObject({ delta: "b" });
  });

  it("never reorders text across a non-batchable event (ordering barrier)", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("first"));
    advance(10);
    const events = assemble(
      assembler,
      assistantDelta(" second"),
      bashOpen("cmd-1"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "item/agentMessage/delta",
      "item/started",
    ]);
    expect(events[0]).toMatchObject({ delta: " second" });
  });

  it("item.textClose flushes the buffer and completes with the full text", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("Hello"));
    advance(10);
    expect(assemble(assembler, assistantDelta(" world"))).toEqual([]);

    const events = assemble(assembler, {
      kind: "item.textClose",
      key: { channel: "assistant" },
      channel: "agentMessage",
    });
    expect(events.map((event) => event.type)).toEqual([
      "item/agentMessage/delta",
      "item/completed",
    ]);
    expect(events[0]).toMatchObject({ delta: " world" });
    expect(events[1]).toMatchObject({
      item: expect.objectContaining({ text: "Hello world" }),
    });
  });

  it("window 0 disables batching entirely (one event per delta)", () => {
    const { assembler, advance } = createBatchingAssembler(0);
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("a"));
    advance(1);
    const events = assemble(
      assembler,
      assistantDelta("b"),
      assistantDelta("c"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "item/agentMessage/delta",
      "item/agentMessage/delta",
    ]);
    expect(
      events.map((event) => ("delta" in event ? event.delta : "")),
    ).toEqual(["b", "c"]);
  });

  it("keeps concurrent streams independent (no cross-stream merging)", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("A1", "tool-a"));
    assemble(assembler, assistantDelta("B1", "tool-b"));
    advance(10);
    expect(assemble(assembler, assistantDelta("A2", "tool-a"))).toEqual([]);
    expect(assemble(assembler, assistantDelta("B2", "tool-b"))).toEqual([]);

    advance(200);
    const events = assemble(assembler, {
      kind: "turn.boundary",
      status: "completed",
    });
    const deltas = events.filter(
      (event) => event.type === "item/agentMessage/delta",
    );
    expect(deltas.map((event) => event.delta)).toEqual(["A2", "B2"]);
    expect(new Set(deltas.map((event) => event.itemId)).size).toBe(2);
  });

  it("keeps assistant and reasoning channels independent", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("think? no."));
    assemble(assembler, reasoningDelta("hm"));
    advance(10);
    expect(assemble(assembler, assistantDelta(" more text"))).toEqual([]);
    expect(assemble(assembler, reasoningDelta("mm"))).toEqual([]);

    advance(200);
    const events = assemble(assembler, {
      kind: "turn.boundary",
      status: "completed",
    });
    expect(events.map((event) => event.type)).toEqual([
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "turn/completed",
    ]);
  });

  it("coalesces command output deltas and flushes before the close", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" }, bashOpen("cmd-1"));
    const first = assemble(assembler, {
      kind: "item.outputDelta",
      key: { providerItemId: "cmd-1" },
      channel: "command",
      text: "line 1\n",
    });
    expect(first).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "line 1\n",
      }),
    ]);
    advance(10);
    expect(
      assemble(assembler, {
        kind: "item.outputDelta",
        key: { providerItemId: "cmd-1" },
        channel: "command",
        text: "line 2\n",
      }),
    ).toEqual([]);

    const events = assemble(assembler, {
      kind: "item.close",
      key: { providerItemId: "cmd-1" },
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "line 1\nline 2\n",
      item: { type: "command", command: "npm test", cwd: "/repo" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "item/commandExecution/outputDelta",
      "item/completed",
    ]);
    expect(events[0]).toMatchObject({ delta: "line 2\n" });
    expect(events[1]).toMatchObject({
      item: expect.objectContaining({ aggregatedOutput: "line 1\nline 2\n" }),
    });
  });

  it("coalesces snapshot-diffed output and never absorbs a reset", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" }, bashOpen("cmd-1"));
    const key = { providerItemId: "cmd-1" };
    const snapshot = (text: string): ThreadDelta => ({
      kind: "command.outputSnapshot",
      key,
      text,
    });

    expect(assemble(assembler, snapshot("a"))).toEqual([
      expect.objectContaining({ delta: "a" }),
    ]);
    advance(10);
    expect(assemble(assembler, snapshot("ab"))).toEqual([]);
    advance(10);
    expect(assemble(assembler, snapshot("abc"))).toEqual([]);

    advance(10);
    const events = assemble(assembler, snapshot("x"));
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "bc",
      }),
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "x",
        reset: true,
      }),
    ]);
  });

  it("session.reset flushes buffered text instead of dropping it", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("kept"));
    advance(10);
    expect(assemble(assembler, assistantDelta(" tail"))).toEqual([]);

    const events = assemble(assembler, { kind: "session.reset" });
    expect(events).toEqual([
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: " tail",
      }),
    ]);
  });

  it("session.ended flushes buffered text before settlement", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open" });
    assemble(assembler, assistantDelta("partial"));
    advance(10);
    expect(assemble(assembler, assistantDelta(" answer"))).toEqual([]);

    const events = assemble(assembler, { kind: "session.ended" });
    expect(events.map((event) => event.type)).toEqual([
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    expect(events[0]).toMatchObject({ delta: " answer" });
    expect(events[1]).toMatchObject({
      item: { type: "agentMessage", text: "partial answer" },
    });
  });

  it("coalesces item-keyed text deltas (codex family) per channel", () => {
    const { assembler, advance } = createBatchingAssembler();
    assemble(assembler, { kind: "turn.open", providerTurnId: "turn-1" });
    const textDelta = (
      channel: "agentMessage" | "reasoningText",
      text: string,
    ): ThreadDelta => ({
      kind: "item.textDelta",
      key: { providerItemId: `item-${channel}` },
      channel,
      text,
      providerTurnId: "turn-1",
    });

    const first = assemble(assembler, textDelta("agentMessage", "a1"));
    expect(first.map((event) => event.type)).toEqual([
      "item/started",
      "item/agentMessage/delta",
    ]);
    assemble(assembler, textDelta("reasoningText", "r1"));
    advance(10);
    expect(assemble(assembler, textDelta("agentMessage", "a2"))).toEqual([]);
    expect(assemble(assembler, textDelta("reasoningText", "r2"))).toEqual([]);

    advance(200);
    const events = assemble(assembler, {
      kind: "turn.boundary",
      status: "completed",
      providerTurnId: "turn-1",
    });
    expect(events.map((event) => event.type)).toEqual([
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "turn/completed",
    ]);
  });
});
