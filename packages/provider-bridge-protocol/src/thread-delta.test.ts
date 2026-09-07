import { describe, expect, it } from "vitest";
import {
  THREAD_DELTA_KEY_SEPARATOR,
  threadDeltaNotificationParamsSchema,
  threadDeltaSchema,
} from "./thread-delta.js";

describe("thread delta schemas", () => {
  it("discriminates every delta kind by `kind`", () => {
    const deltas = [
      { kind: "input.accepted", clientRequestId: "creq_abcdefghjk" },
      { kind: "turn.open" },
      { kind: "turn.boundary", status: "completed", claimIfIdle: true },
      {
        kind: "item.open",
        key: { providerItemId: "tc-1" },
        item: { type: "command", command: "ls", cwd: "/repo" },
      },
      {
        kind: "item.close",
        key: { providerItemId: "tc-1" },
        status: "completed",
        exitCode: 0,
        item: { type: "command", command: "ls", cwd: "/repo" },
      },
      { kind: "item.progress", key: { providerItemId: "tc-1" }, message: "…" },
      {
        kind: "item.textDelta",
        key: { channel: "assistant" },
        channel: "agentMessage",
        text: "hi",
      },
      {
        kind: "item.textClose",
        key: { channel: "assistant" },
        channel: "agentMessage",
      },
      {
        kind: "command.outputSnapshot",
        key: { providerItemId: "tc-1" },
        text: "OUT\n",
      },
      {
        kind: "usage",
        total: {
          totalTokens: 10,
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 10,
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 200_000,
      },
      {
        kind: "contextWindow",
        used: 1234,
        size: 200_000,
        estimated: true,
        attach: "currentOrLast",
      },
      { kind: "context.compacted" },
      { kind: "context.cleared" },
      { kind: "provider.error", message: "boom", settlesTurn: true },
      { kind: "provider.warning", summary: "careful" },
      {
        kind: "unhandled",
        raw: { jsonrpc: "2.0", method: "sdk/message", params: { x: 1 } },
        rawType: "sdk/unknown",
        vouchedTurn: true,
      },
      { kind: "session.ended" },
    ];
    for (const delta of deltas) {
      const parsed = threadDeltaSchema.safeParse(delta);
      expect(parsed.success, `expected ${delta.kind} to parse`).toBe(true);
    }
  });

  it("rejects unknown kinds and malformed members", () => {
    expect(threadDeltaSchema.safeParse({ kind: "nope" }).success).toBe(false);
    expect(
      threadDeltaSchema.safeParse({
        kind: "input.accepted",
        clientRequestId: "not-a-creq",
      }).success,
    ).toBe(false);
    expect(
      threadDeltaSchema.safeParse({ kind: "turn.boundary", status: "done" })
        .success,
    ).toBe(false);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.open",
        key: {},
        item: { type: "mystery" },
      }).success,
    ).toBe(false);
    expect(
      threadDeltaSchema.safeParse({
        kind: "unhandled",
        raw: { method: "x" },
        rawType: "x",
        vouchedTurn: false,
      }).success,
    ).toBe(false);
  });

  it("rejects empty-string join-key members while allowing their omission", () => {
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.open",
        key: { providerItemId: "" },
        item: { type: "compaction" },
      }).success,
    ).toBe(false);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.open",
        key: {},
        item: { type: "compaction" },
      }).success,
    ).toBe(true);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.textDelta",
        key: { channel: "" },
        channel: "agentMessage",
        text: "hi",
      }).success,
    ).toBe(false);
  });

  it("rejects key members containing the internal separator", () => {
    const poisoned = `tc${THREAD_DELTA_KEY_SEPARATOR}1`;
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.open",
        key: { providerItemId: poisoned },
        item: { type: "compaction" },
      }).success,
    ).toBe(false);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.close",
        key: { providerItemId: "tc-1", parentRef: poisoned },
        status: "completed",
        item: { type: "compaction" },
      }).success,
    ).toBe(false);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.textDelta",
        key: { channel: poisoned },
        channel: "agentMessage",
        text: "hi",
      }).success,
    ).toBe(false);
    expect(
      threadDeltaSchema.safeParse({
        kind: "turn.open",
        providerTurnId: poisoned,
      }).success,
    ).toBe(false);
  });

  it("parses batched notification params and requires a thread id", () => {
    expect(
      threadDeltaNotificationParamsSchema.safeParse({
        threadId: "thr_1",
        deltas: [{ kind: "turn.open" }, { kind: "context.compacted" }],
      }).success,
    ).toBe(true);
    expect(
      threadDeltaNotificationParamsSchema.safeParse({
        threadId: "",
        deltas: [],
      }).success,
    ).toBe(false);
  });
});
