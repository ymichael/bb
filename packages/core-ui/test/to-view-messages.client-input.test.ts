import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import { toViewMessages, toViewProjection } from "../src/to-view-messages.js";
import { buildTimelineRows } from "../src/thread-detail-rows.js";
import {
  createTimelineEventFactory,
  flattenProjectionMessages,
  fromRows,
} from "./timeline-test-harness.js";

describe("toViewMessages client input projection", () => {


  it("renders unacknowledged active-turn steer messages after durable rows", () => {
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
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "tool-before-steer",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "Please account for the restart" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "tool-after-steer",
            tool: "exec_command",
            arguments: { cmd: "sqlite3 ~/.bb-dev/bb.db '.tables'" },
            status: "completed",
          },
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Done.",
          },
        },
        createdAt: 5,
      },
      {
        id: "evt-6",
        threadId: "thread-1",
        seq: 6,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 6,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const rows = buildTimelineRows(projection, {
      includeToolGroupMessages: true,
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "tool-group",
      "message",
      "message",
    ]);
    const steerRow = rows[2];
    expect(steerRow?.kind).toBe("message");
    if (steerRow?.kind !== "message") {
      throw new Error("Expected steer message row");
    }
    expect(steerRow.message.kind).toBe("user");
    if (steerRow.message.kind !== "user") {
      throw new Error("Expected user steer message");
    }
    expect(steerRow.message.text).toBe("Please account for the restart");
    expect(steerRow.message.sourceSeqStart).toBe(7);
    expect(steerRow.message.turnId).toBeUndefined();
  });


  it("switches active-turn steer messages to the provider ack sequence", () => {
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
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "tool-before-steer",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "Please account for the restart" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "provider-user-1",
            clientRequestSequence: 3,
            content: [{ type: "text", text: "Please account for the restart" }],
          },
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "tool-after-steer",
            tool: "exec_command",
            arguments: { cmd: "sqlite3 ~/.bb-dev/bb.db '.tables'" },
            status: "completed",
          },
        },
        createdAt: 5,
      },
      {
        id: "evt-6",
        threadId: "thread-1",
        seq: 6,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Done.",
          },
        },
        createdAt: 6,
      },
      {
        id: "evt-7",
        threadId: "thread-1",
        seq: 7,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 7,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const rows = buildTimelineRows(projection, {
      includeToolGroupMessages: true,
    });
    const userRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.kind === "user",
    );

    expect(userRows).toHaveLength(1);
    const steerMessage = userRows[0]?.message;
    expect(steerMessage?.kind).toBe("user");
    if (steerMessage?.kind !== "user") {
      throw new Error("Expected user steer message");
    }
    expect(steerMessage.text).toBe("Please account for the restart");
    expect(steerMessage.sourceSeqStart).toBe(4);
    expect(steerMessage.turnId).toBe("turn-1");
  });


  it("pairs multiple unacknowledged active-turn steers with provider acks by client request sequence", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.clientTurnRequested({ text: "Repeat this" }),
      event.clientTurnRequested({ text: "Repeat this" }),
      event.userMessageAck({
        clientRequestSequence: 2,
        itemId: "provider-user-1",
        text: "Repeat this",
      }),
      event.userMessageAck({
        clientRequestSequence: 3,
        itemId: "provider-user-2",
        text: "Repeat this",
      }),
      event.assistantCompleted({ text: "Done." }),
      event.turnCompleted(),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const userMessages = flattenProjectionMessages(projection).filter(
      (message) => message.kind === "user",
    );

    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((message) => message.id)).toEqual([
      "thread-1:user:provider-user-1",
      "thread-1:user:provider-user-2",
    ]);
    expect(userMessages.map((message) => message.sourceSeqStart)).toEqual([4, 5]);
    expect(userMessages.map((message) => message.turnId)).toEqual([
      "turn-1",
      "turn-1",
    ]);
  });


  it("keeps provider user messages with repeated item ids in different turns", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted({ turnId: "turn-1" }),
      event.userMessageAck({
        itemId: "runtime-user-1",
        text: "Repeat after restart",
        turnId: "turn-1",
      }),
      event.turnCompleted({ turnId: "turn-1" }),
      event.turnStarted({ turnId: "turn-2" }),
      event.userMessageAck({
        itemId: "runtime-user-1",
        text: "Repeat after restart",
        turnId: "turn-2",
      }),
      event.turnCompleted({ turnId: "turn-2" }),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const userMessages = flattenProjectionMessages(projection).filter(
      (message) => message.kind === "user",
    );

    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((message) => message.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });


  it("renders acked active-turn steers inline and unacked steers at the bottom", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.clientTurnRequested({ text: "Acked steer" }),
      event.clientTurnRequested({ text: "Pending steer" }),
      event.userMessageAck({
        clientRequestSequence: 2,
        itemId: "provider-user-1",
        text: "Acked steer",
      }),
      event.assistantCompleted({ text: "Done." }),
      event.turnCompleted(),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const rows = buildTimelineRows(projection, {
      includeToolGroupMessages: true,
    });
    const userRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.kind === "user",
    );

    expect(userRows).toHaveLength(2);
    expect(userRows.map((row) => row.message.text)).toEqual([
      "Acked steer",
      "Pending steer",
    ]);
    expect(userRows.map((row) => row.message.sourceSeqStart)).toEqual([4, 7]);
    expect(userRows.map((row) => row.message.turnId)).toEqual([
      "turn-1",
      undefined,
    ]);
    expect(rows.at(-1)).toBe(userRows[1]);
  });


  it("replaces an active-turn steer when the provider ack arrives after turn completion", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.clientTurnRequested({ text: "Late ack steer" }),
      event.turnCompleted(),
      event.userMessageAck({
        clientRequestSequence: 2,
        itemId: "provider-user-1",
        text: "Late ack steer",
      }),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const userMessages = flattenProjectionMessages(projection).filter(
      (message) => message.kind === "user",
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe("thread-1:user:provider-user-1");
    expect(userMessages[0]?.sourceSeqStart).toBe(4);
    expect(userMessages[0]?.turnId).toBe("turn-1");
  });


  it("does not pair an uncorrelated provider ack by matching text", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.clientTurnRequested({ text: "Needs explicit correlation" }),
      event.userMessageAck({
        itemId: "provider-user-1",
        text: "Needs explicit correlation",
      }),
      event.turnCompleted(),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const userMessages = flattenProjectionMessages(projection).filter(
      (message) => message.kind === "user",
    );

    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((message) => message.sourceSeqStart)).toEqual([3, 5]);
  });


  it("does not pair an older pending request with a later ack that has the same text", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.clientTurnRequested({ text: "Same steer" }),
      event.turnStarted({ turnId: "turn-1" }),
      event.turnCompleted({ turnId: "turn-1" }),
      event.clientTurnRequested({ text: "Same steer" }),
      event.turnStarted({ turnId: "turn-2" }),
      event.userMessageAck({
        clientRequestSequence: 4,
        itemId: "provider-user-2",
        text: "Same steer",
        turnId: "turn-2",
      }),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const userMessages = flattenProjectionMessages(projection).filter(
      (message) => message.kind === "user",
    );

    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((message) => message.id)).toEqual([
      "thread-1:user:provider-user-2",
      "thread-1:user-seed:1",
    ]);
    expect(userMessages.map((message) => message.turnId)).toEqual([
      "turn-2",
      undefined,
    ]);
  });


  it("rejects provider user acks without turnId at the decode boundary", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.clientTurnRequested({ text: "Turnless ack steer" }),
      {
        id: "evt-turnless-user-ack",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          item: {
            type: "userMessage",
            id: "provider-user-1",
            content: [{ type: "text", text: "Turnless ack steer" }],
          },
        },
        createdAt: 3,
      },
    ];

    expect(() =>
      toViewProjection(fromRows(events), {
        threadStatus: "active",
        turnMessageDetail: "summary",
      })
    ).toThrow(/turnId/);
  });


  it("renders initial client thread input while provisioning has failed", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Fix the sidebar menu state bug" }],
          request: {
            method: "thread/start",
            params: {
              model: "gpt-5.3-codex",
            },
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "error",
    });

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.text.includes("Fix the sidebar menu state bug"),
      ),
    ).toBe(true);
  });


  it("projects start-first provisioning failure timelines into user + provisioning + error rows", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Fix env setup script regression" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/thread-provisioning",
        data: {
          status: "failed",
          environmentId: "env-1",
          entries: [{ type: "step", key: "setup", text: ".bb-env-setup.sh failed", status: "failed" }],
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "system/error",
        data: {
          code: "thread_provisioning_failed",
          message: "Provisioning thread failed",
          detail: "pnpm build failed",
        },
        createdAt: 4,
      },
    ];

    const rows = buildTimelineRows(
      toViewProjection(fromRows(events), {
        threadStatus: "error",
        turnMessageDetail: "full",
      }),
      { includeToolGroupMessages: false },
    );
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(3);
    expect(messageRows[0]?.message.kind).toBe("user");
    if (messageRows[0]?.message.kind === "user") {
      expect(messageRows[0].message.text).toContain("Fix env setup script regression");
    }

    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind === "operation") {
      expect(messageRows[1].message.opType).toBe("thread-provisioning");
      expect(messageRows[1].message.title).toBe("Provisioning thread failed");
    }

    expect(messageRows[2]?.message.kind).toBe("error");
    if (messageRows[2]?.message.kind === "error") {
      expect(messageRows[2].message.message).toContain("Provisioning thread failed");
      expect(messageRows[2].message.message).toContain("pnpm build failed");
    }
  });


  it("renders provider-start provisioning failures as failed instead of interrupted", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Retry the direct environment" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Provisioning thread", status: "started" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/error",
        data: {
          code: "thread_provisioning_failed",
          message: "Provisioning thread failed",
          detail: "Provider runtime is unavailable",
        },
        createdAt: 3,
      },
    ];

    const rows = buildTimelineRows(
      toViewProjection(fromRows(events), {
        threadStatus: "error",
        turnMessageDetail: "full",
      }),
      { includeToolGroupMessages: false },
    );
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(3);
    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind === "operation") {
      expect(messageRows[1].message.opType).toBe("thread-provisioning");
      expect(messageRows[1].message.title).toBe("Provisioning thread failed");
    }

    expect(messageRows[2]?.message.kind).toBe("error");
    if (messageRows[2]?.message.kind === "error") {
      expect(messageRows[2].message.message).toContain("Provider runtime is unavailable");
    }
  });


  it("renders initial client thread input while idle when no user item events exist", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Recover from provisioning failure" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.text.includes("Recover from provisioning failure"),
      ),
    ).toBe(true);
  });


  it("renders follow-up client turn input while active when no user item events exist yet", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [{ type: "text", text: "Follow up fix for lag" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.text.includes("Follow up fix for lag"),
      ),
    ).toBe(true);
  });


  it("keeps append-only tell request/start pairs as a single rendered user message", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [{ type: "text", text: "Please keep going until the roadmap is done" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "turn/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "userMessage",
            clientRequestSequence: 1,
            content: [{ type: "text", text: "Please keep going until the roadmap is done" }],
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [{ type: "text", text: "Please keep going until the roadmap is done" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 4,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const userMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe("Please keep going until the roadmap is done");
    expect(userMessages[0]?.sourceSeqStart).toBe(3);
  });


  it("keeps the client thread input and suppresses a matching later user item event", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Fix duplicate user messages" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "userMessage",
            content: [{ type: "text", text: "Fix duplicate user messages" }],
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const userMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toContain("user-seed");
    expect(userMessages[0]?.text).toBe("Fix duplicate user messages");
  });


  it("deduplicates matching spawn thread/turn start inputs before provider user items arrive", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Keep ordering sane" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Keep ordering sane" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const userMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe("thread-1:user-seed:1");
    expect(userMessages[0]?.text).toBe("Keep ordering sane");
  });


  it("keeps start-first ordering by showing one client input before provisioning when matching spawn/user item events appear later", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Keep ordering sane" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-provisioning",
        data: {
          status: "active",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/thread-provisioning",
        data: {
          status: "completed",
          environmentId: "env-1",
          entries: [{ type: "step", key: "provision", text: "Created worktree", status: "completed" }],
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Keep ordering sane" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "userMessage",
            content: [{ type: "text", text: "Keep ordering sane" }],
          },
        },
        createdAt: 5,
      },
    ];

    const rows = buildTimelineRows(
      toViewProjection(fromRows(events), {
        threadStatus: "idle",
        turnMessageDetail: "full",
      }),
      { includeToolGroupMessages: false },
    );
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(2);
    expect(messageRows[0]?.message.kind).toBe("user");
    if (messageRows[0]?.message.kind === "user") {
      expect(messageRows[0].message.id).toContain("user-seed");
      expect(messageRows[0].message.text).toBe("Keep ordering sane");
    }
    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind === "operation") {
      expect(messageRows[1].message.opType).toBe("thread-provisioning");
    }
  });


  it("keeps non-duplicated initial client thread input alongside later user items", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Original failed prompt" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-2",
          item: {
            id: "item-user-2",
            type: "userMessage",
            content: [{ type: "text", text: "sanity retry" }],
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const userMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(2);
    expect(userMessages.some((message) => message.text === "Original failed prompt")).toBe(true);
    expect(userMessages.some((message) => message.text === "sanity retry")).toBe(true);
  });


  it("preserves user attachment paths and urls from client start input", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [
            { type: "text", text: "check these" },
            { type: "image", url: "https://example.com/a.png" },
            { type: "localImage", path: "/tmp/local-a.png" },
            { type: "localFile", path: "/tmp/notes.md" },
          ],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const user = projected.find(
      (message): message is Extract<ViewMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(user).toBeDefined();
    expect(user?.attachments?.imageUrls).toEqual(["https://example.com/a.png"]);
    expect(user?.attachments?.localImagePaths).toEqual(["/tmp/local-a.png"]);
    expect(user?.attachments?.localFilePaths).toEqual(["/tmp/notes.md"]);
  });


  it("deduplicates provider userMessage image data URL in favor of client start localImage", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [
            { type: "text", text: "why is the theme selector not all the way to the right?" },
            { type: "localImage", path: "/tmp/shot.png" },
          ],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "userMessage",
            content: [
              { type: "text", text: "why is the theme selector not all the way to the right?" },
              { type: "image", url: "data:image/png;base64,abc" },
            ],
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const users = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(users).toHaveLength(1);
    expect(users[0]?.attachments?.localImages).toBe(1);
    expect(users[0]?.attachments?.localImagePaths).toEqual(["/tmp/shot.png"]);
  });


  it("does not render system-initiated client start input as a user message", () => {
    const projected = toViewMessages(fromRows([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "system",
          input: [{ type: "text", text: "[bb system] Welcome!" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
    ]), { threadStatus: "idle" });

    expect(projected).toEqual([]);
  });


  it("projects manager user messages and suppresses raw assistant text for manager threads", () => {
    const projected = toViewMessages(fromRows([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "internal manager chatter",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/manager/user_message",
        data: {
          text: "Visible manager update",
          turnId: "turn-1",
        },
        createdAt: 2,
      },
    ]), {
      threadStatus: "idle",
      threadType: "manager",
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Visible manager update");
      expect(projected[0].turnId).toBe("turn-1");
      expect(projected[0].isManagerUserMessage).toBe(true);
    }
  });


  it("suppresses internal [bb system] user messages from provider items", () => {
    const projected = toViewMessages(fromRows([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "system",
          input: [{ type: "text", text: "[bb system] Welcome!" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "[bb system] Welcome!" }],
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/manager/user_message",
        data: {
          text: "Visible manager update",
          turnId: "turn-1",
        },
        createdAt: 2,
      },
    ]), {
      threadStatus: "idle",
      threadType: "manager",
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Visible manager update");
    }
  });


  it("includes internal [bb system] messages when internal system messages are enabled", () => {
    const projected = toViewMessages(fromRows([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "system",
          input: [{ type: "text", text: "[bb system] Welcome!" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/thread/start",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "[bb system] Welcome!" }],
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/manager/user_message",
        data: {
          text: "Visible manager update",
          turnId: "turn-1",
        },
        createdAt: 3,
      },
    ]), {
      threadStatus: "idle",
      threadType: "manager",
      includeInternalSystemMessages: true,
    });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.kind).toBe("user");
    if (projected[0]?.kind === "user") {
      expect(projected[0].text).toBe("[bb system] Welcome!");
    }
    expect(projected[1]?.kind).toBe("assistant-text");
    if (projected[1]?.kind === "assistant-text") {
      expect(projected[1].text).toBe("Visible manager update");
    }
  });
});
