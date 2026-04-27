import { describe, expect, it } from "vitest";
import { parseThreadEventRow, turnScope } from "@bb/domain";
import { decodeRow } from "../src/event-decode.js";

describe("decodeRow", () => {
  it("reconstructs typed persisted provider events", () => {
    const row = parseThreadEventRow({
      id: "row-1",
      threadId: "thread-1",
      seq: 1,
      scope: turnScope("turn-1"),
      type: "item/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "Read",
          status: "completed",
        },
      },
      createdAt: 123,
    });

    expect(decodeRow(row)).toEqual({
      event: {
        type: "item/completed",
        threadId: "thread-1",
        scope: turnScope("turn-1"),
        providerThreadId: "provider-thread-1",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "Read",
          status: "completed",
        },
      },
      meta: {
        id: "row-1",
        seq: 1,
        createdAt: 123,
      },
    });
  });

  it("throws when persisted event data does not match the stored row schema", () => {
    const row = {
      id: "row-1",
      threadId: "thread-1",
      seq: 1,
      scope: turnScope("turn-1"),
      type: "item/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "Read",
          status: "bogus",
        },
      },
      createdAt: 123,
    };

    expect(() => parseThreadEventRow(row)).toThrow();
  });

  it("throws when turn/completed rows omit canonical status", () => {
    const row = {
      id: "row-turn-status-missing",
      threadId: "thread-1",
      seq: 2,
      scope: turnScope("turn-1"),
      type: "turn/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
      },
      createdAt: 456,
    };

    expect(() => parseThreadEventRow(row)).toThrow();
  });

  it("throws when web-search items do not match the canonical shape", () => {
    const row = {
      id: "row-web-search-action",
      threadId: "thread-1",
      seq: 3,
      scope: turnScope("turn-1"),
      type: "item/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-1",
          query: "react suspense",
          outputText: "Found the React Suspense docs",
        },
      },
      createdAt: 789,
    };

    expect(() => parseThreadEventRow(row)).toThrow();
  });
});
