import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import { turnScope } from "@bb/domain";
import { toViewMessages } from "../src/to-view-messages.js";
import { fromRows } from "./timeline-test-harness.js";

describe("toViewMessages debug projection", () => {
  it("classifies duplicate-event types but does not emit debug rows for them", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const withDebug = toViewMessages(fromRows(events), {
      includeDebugRawEvents: true,
    });
    expect(withDebug).toEqual([]);
  });

  it("drops turn/task lifecycle duplicates in debug mode", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 4,
        scope: turnScope("turn-1"),
      },
    ];

    const withDebug = toViewMessages(fromRows(events), {
      includeDebugRawEvents: true,
    });
    expect(withDebug).toEqual([]);
  });

  it("drops structural item/started noise in debug mode", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: { type: "reasoning", id: "rs-1", summary: [], content: [] },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: { type: "agentMessage", id: "msg-1", text: "" },
          turnId: "turn-1",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const withDebug = toViewMessages(fromRows(events), {
      includeDebugRawEvents: true,
    });
    expect(withDebug).toEqual([]);
  });

  it("drops empty completed placeholder items in debug mode", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: { type: "reasoning", id: "rs-1", summary: [], content: [] },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: { type: "agentMessage", id: "msg-1", text: "" },
          turnId: "turn-1",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const withDebug = toViewMessages(fromRows(events), {
      includeDebugRawEvents: true,
    });
    expect(withDebug).toEqual([]);
  });
});
