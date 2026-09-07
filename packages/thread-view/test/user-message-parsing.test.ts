import { describe, expect, it } from "vitest";
import { turnScope, type PromptTextMention } from "@bb/domain";
import {
  createTimelineEventFactory,
  type TimelineEventFactory,
} from "./timeline-test-harness.js";
import { decodeThreadEventRow } from "../src/event-decode.js";
import type { BuildEventProjectionMessagesOptions } from "../src/event-projection-types.js";
import type { AcceptedClientRequest } from "../src/accepted-client-request-context.js";
import {
  parsePromptInput,
  parseAcceptedSteersFromClientRequest,
  parsePendingSteersFromClientRequest,
  parseUsersFromClientRequest,
} from "../src/user-message-parsing.js";

type ClientTurnRequestedEventRow = ReturnType<
  TimelineEventFactory["clientTurnRequested"]
>;

interface AcceptedClientRequestFixtureArgs {
  turnId?: string;
}

const AGENT_STEER_TEXT = "Please account for the restart";
const SENDER_THREAD_ID = "thr_sender";

const standardProjectionOptions: BuildEventProjectionMessagesOptions = {
  threadStatus: "active",
  threadName: "",
};

function agentSteerRequest(): ClientTurnRequestedEventRow {
  const event = createTimelineEventFactory({ threadId: "thread-1" });
  return event.clientTurnRequested({
    initiator: "agent",
    senderThreadId: SENDER_THREAD_ID,
    target: { kind: "auto", expectedTurnId: "turn-1" },
    text: AGENT_STEER_TEXT,
  });
}

function systemSteerRequest(): ClientTurnRequestedEventRow {
  const event = createTimelineEventFactory({ threadId: "thread-1" });
  return event.clientTurnRequested({
    initiator: "system",
    senderThreadId: null,
    target: { kind: "auto", expectedTurnId: "turn-1" },
    text: "[bb system] Mid-turn nudge",
  });
}

function systemMessageRequest(): ClientTurnRequestedEventRow {
  const event = createTimelineEventFactory({ threadId: "thread-1" });
  return event.clientTurnRequested({
    initiator: "system",
    senderThreadId: null,
    target: { kind: "new-turn" },
    text: "[bb system] Maintenance notice.",
  });
}

function userMessageRequest(): ClientTurnRequestedEventRow {
  const event = createTimelineEventFactory({ threadId: "thread-1" });
  return event.clientTurnRequested({
    initiator: "user",
    target: { kind: "new-turn" },
    text: "Hello",
  });
}

function userSteerRequest(): ClientTurnRequestedEventRow {
  const event = createTimelineEventFactory({ threadId: "thread-1" });
  return event.clientTurnRequested({
    initiator: "user",
    target: { kind: "auto", expectedTurnId: "turn-1" },
    text: "Mid-turn steer",
  });
}

function userSteerRequestWithoutExpectedTurn(): ClientTurnRequestedEventRow {
  const event = createTimelineEventFactory({ threadId: "thread-1" });
  return event.clientTurnRequested({
    initiator: "user",
    target: { kind: "steer", expectedTurnId: null },
    text: "Fallback message",
  });
}

function acceptedClientRequest(
  args: AcceptedClientRequestFixtureArgs = {},
): AcceptedClientRequest {
  return {
    meta: {
      id: "event-accepted",
      seq: 2,
      createdAt: 2,
    },
    turnId: args.turnId ?? "turn-1",
  };
}

describe("user message parsing", () => {
  it("omits agent-only prompt input parts from timeline text and attachments", () => {
    const parsed = parsePromptInput([
      {
        type: "text",
        text: "[bb system]\n\nHidden agent-only context:\n\nsecret",
        mentions: [],
        visibility: "agent-only",
      },
      { type: "text", text: "Visible request", mentions: [] },
      {
        type: "localFile",
        path: "/tmp/hidden.md",
        visibility: "agent-only",
      },
      { type: "localFile", path: "/tmp/visible.md" },
    ]);

    expect(parsed).toEqual({
      text: "Visible request",
      mentions: [],
      webImages: 0,
      localImages: 0,
      localFiles: 1,
      imageUrls: [],
      localImagePaths: [],
      localFilePaths: ["/tmp/visible.md"],
    });
  });

  it("hides prompt input rows that only contain agent-only parts", () => {
    const parsed = parsePromptInput([
      {
        type: "text",
        text: "[bb system]\n\nHidden agent-only context was removed.",
        mentions: [],
        visibility: "agent-only",
      },
    ]);

    expect(parsed).toBeNull();
  });

  it("populates initiator, senderThreadId, and turnRequest for user-initiated messages", () => {
    const { event, meta } = decodeThreadEventRow(userMessageRequest());

    const message =
      parseUsersFromClientRequest({
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null;

    expect(message).toMatchObject({
      kind: "user",
      initiator: "user",
      senderThreadId: null,
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
      text: "Hello",
    });
  });

  it("renders grouped queued turn requests as separate user messages", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const row = factory.clientTurnRequested({
      initiator: "user",
      target: { kind: "new-turn" },
      text: "First\n\nSecond",
      input: [{ type: "text", text: "First\n\nSecond", mentions: [] }],
      inputGroups: [
        [{ type: "text", text: "First", mentions: [] }],
        [{ type: "text", text: "Second", mentions: [] }],
      ],
    });
    const { event, meta } = decodeThreadEventRow(row);

    const messages = parseUsersFromClientRequest({
      decoded: event,
      meta,
      options: standardProjectionOptions,
    });

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.text)).toEqual([
      "First",
      "Second",
    ]);
    expect(messages.map((message) => message.id)).toEqual([
      `${event.threadId}:user-seed:${meta.seq}`,
      `${event.threadId}:user-seed:${meta.seq}-1`,
    ]);
    expect(messages.map((message) => message.turnRequest)).toEqual([
      { isGrouped: true, kind: "message", status: "pending" },
      { isGrouped: true, kind: "message", status: "pending" },
    ]);
  });

  it("uses the base id for the first visible grouped turn request", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const row = factory.clientTurnRequested({
      initiator: "user",
      target: { kind: "new-turn" },
      text: "Visible",
      input: [
        {
          type: "text",
          text: "Hidden agent context",
          mentions: [],
          visibility: "agent-only",
        },
        { type: "text", text: "Visible", mentions: [] },
      ],
      inputGroups: [
        [
          {
            type: "text",
            text: "Hidden agent context",
            mentions: [],
            visibility: "agent-only",
          },
        ],
        [{ type: "text", text: "Visible", mentions: [] }],
      ],
    });
    const { event, meta } = decodeThreadEventRow(row);

    const messages = parseUsersFromClientRequest({
      decoded: event,
      meta,
      options: standardProjectionOptions,
    });

    expect(
      messages.map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      { id: `${event.threadId}:user-seed:${meta.seq}`, text: "Visible" },
    ]);
  });

  it("populates initiator, senderThreadId, and turnRequest for agent-initiated messages", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const agentText = "[bb message from thread:thr_sender]\n\nHi";
    const row = factory.clientTurnRequested({
      initiator: "agent",
      senderThreadId: SENDER_THREAD_ID,
      target: { kind: "new-turn" },
      text: agentText,
    });
    const { event, meta } = decodeThreadEventRow(row);

    const message =
      parseUsersFromClientRequest({
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null;

    expect(message).toMatchObject({
      kind: "user",
      initiator: "agent",
      senderThreadId: SENDER_THREAD_ID,
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
      text: agentText,
    });
  });

  it("recovers agent attribution from a legacy cross-thread envelope", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const row = factory.clientTurnRequested({
      initiator: "user",
      senderThreadId: null,
      target: { kind: "new-turn" },
      text: "[bb message from thread:thr_legacy; reply later]\n\nLegacy handoff",
    });
    const { event, meta } = decodeThreadEventRow(row);

    const message =
      parseUsersFromClientRequest({
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null;

    expect(message).toMatchObject({
      kind: "user",
      initiator: "agent",
      senderThreadId: "thr_legacy",
      text: "[bb message from thread:thr_legacy; reply later]\n\nLegacy handoff",
    });
  });

  it("populates initiator for system-initiated messages with a turnRequest", () => {
    const { event, meta } = decodeThreadEventRow(systemMessageRequest());

    const message =
      parseUsersFromClientRequest({
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null;

    expect(message).toMatchObject({
      kind: "user",
      initiator: "system",
      senderThreadId: null,
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
    });
  });

  it("preserves mentions for system-initiated messages", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const mentionText = "@thread:thr_child";
    const text = `[bb system]\n\n${mentionText} needs help.\nIt is blocked on a pending interaction.\n\nReview the blocker. If you can resolve it from existing context, reply to the thread with guidance. Otherwise, ask the user for the missing decision.`;
    const mentionStart = "[bb system]\n\n".length;
    const mention: PromptTextMention = {
      start: mentionStart,
      end: mentionStart + mentionText.length,
      resource: {
        kind: "thread",
        label: "Backend cleanup",
        projectId: "proj_alpha",
        threadId: "thr_child",
      },
    };
    const row = factory.clientTurnRequested({
      initiator: "system",
      senderThreadId: null,
      target: { kind: "new-turn" },
      text,
      input: [{ type: "text", text, mentions: [mention] }],
    });
    const { event, meta } = decodeThreadEventRow(row);

    const message =
      parseUsersFromClientRequest({
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null;

    expect(message).toMatchObject({
      kind: "user",
      initiator: "system",
      senderThreadId: null,
      text,
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
    });
    expect(message?.mentions).toEqual([mention]);
  });

  it("treats steers as steer requests regardless of initiator", () => {
    for (const row of [
      userSteerRequest(),
      agentSteerRequest(),
      systemSteerRequest(),
    ]) {
      const { event, meta } = decodeThreadEventRow(row);
      if (event.type !== "client/turn/requested") {
        throw new Error("Expected client/turn/requested event");
      }
      const expectedText = event.input
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const accepted = acceptedClientRequest();

      expect(
        parsePendingSteersFromClientRequest({
          acceptedClientRequest: undefined,
          decoded: event,
          meta,
          options: standardProjectionOptions,
        })[0] ?? null,
      ).toMatchObject({
        kind: "user",
        turnRequest: { isGrouped: false, kind: "steer", status: "pending" },
        text: expectedText,
        sourceSeqStart: meta.seq,
      });
      expect(
        parseAcceptedSteersFromClientRequest({
          acceptedClientRequest: accepted,
          decoded: event,
          meta,
          options: standardProjectionOptions,
        })[0] ?? null,
      ).toMatchObject({
        kind: "user",
        turnRequest: { isGrouped: false, kind: "steer", status: "accepted" },
        text: expectedText,
        sourceSeqStart: accepted.meta.seq,
      });
      expect(
        parseUsersFromClientRequest({
          decoded: event,
          meta,
          options: standardProjectionOptions,
        })[0] ?? null,
      ).toBeNull();
    }
  });

  it("splits grouped steers into separate pending and accepted user messages", () => {
    const eventFactory = createTimelineEventFactory({ threadId: "thread-1" });
    const row = eventFactory.clientTurnRequested({
      initiator: "user",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "flattened",
      input: [
        { type: "text", text: "First grouped steer", mentions: [] },
        { type: "text", text: "\n\n", mentions: [] },
        { type: "text", text: "Second grouped steer", mentions: [] },
      ],
      inputGroups: [
        [{ type: "text", text: "First grouped steer", mentions: [] }],
        [{ type: "text", text: "Second grouped steer", mentions: [] }],
      ],
    });
    const { event, meta } = decodeThreadEventRow(row);
    if (event.type !== "client/turn/requested") {
      throw new Error("Expected client/turn/requested event");
    }
    const accepted = acceptedClientRequest();

    expect(
      parsePendingSteersFromClientRequest({
        acceptedClientRequest: undefined,
        decoded: event,
        meta,
        options: standardProjectionOptions,
      }).map((message) => ({
        id: message.id,
        text: message.text,
        turnRequest: message.turnRequest,
      })),
    ).toEqual([
      {
        id: "thread-1:user-seed:1",
        text: "First grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "pending" },
      },
      {
        id: "thread-1:user-seed:1-1",
        text: "Second grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "pending" },
      },
    ]);
    expect(
      parseAcceptedSteersFromClientRequest({
        acceptedClientRequest: accepted,
        decoded: event,
        meta,
        options: standardProjectionOptions,
      }).map((message) => ({
        id: message.id,
        sourceSeqStart: message.sourceSeqStart,
        text: message.text,
        turnRequest: message.turnRequest,
      })),
    ).toEqual([
      {
        id: "thread-1:user-seed:1",
        sourceSeqStart: accepted.meta.seq,
        text: "First grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "accepted" },
      },
      {
        id: "thread-1:user-seed:1-1",
        sourceSeqStart: accepted.meta.seq,
        text: "Second grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "accepted" },
      },
    ]);
  });

  it("uses visible grouped steer order when assigning ids", () => {
    const eventFactory = createTimelineEventFactory({ threadId: "thread-1" });
    const row = eventFactory.clientTurnRequested({
      initiator: "user",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "Visible steer\n\nSecond visible steer",
      input: [
        {
          type: "text",
          text: "Hidden steer context",
          mentions: [],
          visibility: "agent-only",
        },
        { type: "text", text: "Visible steer", mentions: [] },
        { type: "text", text: "\n\n", mentions: [] },
        { type: "text", text: "Second visible steer", mentions: [] },
      ],
      inputGroups: [
        [
          {
            type: "text",
            text: "Hidden steer context",
            mentions: [],
            visibility: "agent-only",
          },
        ],
        [{ type: "text", text: "Visible steer", mentions: [] }],
        [{ type: "text", text: "Second visible steer", mentions: [] }],
      ],
    });
    const { event, meta } = decodeThreadEventRow(row);
    if (event.type !== "client/turn/requested") {
      throw new Error("Expected client/turn/requested event");
    }
    const accepted = acceptedClientRequest();

    expect(
      parsePendingSteersFromClientRequest({
        acceptedClientRequest: undefined,
        decoded: event,
        meta,
        options: standardProjectionOptions,
      }).map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      { id: "thread-1:user-seed:1", text: "Visible steer" },
      { id: "thread-1:user-seed:1-1", text: "Second visible steer" },
    ]);
    expect(
      parseAcceptedSteersFromClientRequest({
        acceptedClientRequest: accepted,
        decoded: event,
        meta,
        options: standardProjectionOptions,
      }).map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      { id: "thread-1:user-seed:1", text: "Visible steer" },
      { id: "thread-1:user-seed:1-1", text: "Second visible steer" },
    ]);
  });

  it("renders a steer accepted by a different turn as a message", () => {
    const { event, meta } = decodeThreadEventRow(userSteerRequest());
    const accepted = acceptedClientRequest({ turnId: "turn-2" });

    expect(
      parseAcceptedSteersFromClientRequest({
        acceptedClientRequest: accepted,
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null,
    ).toBeNull();

    expect(
      parseUsersFromClientRequest({
        acceptedClientRequest: accepted,
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null,
    ).toMatchObject({
      kind: "user",
      scope: turnScope("turn-2"),
      sourceSeqStart: meta.seq,
      text: "Mid-turn steer",
      turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
    });
  });

  it("renders an explicit steer without an expected turn as a message", () => {
    const { event, meta } = decodeThreadEventRow(
      userSteerRequestWithoutExpectedTurn(),
    );

    expect(
      parsePendingSteersFromClientRequest({
        acceptedClientRequest: undefined,
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null,
    ).toBeNull();

    expect(
      parseUsersFromClientRequest({
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null,
    ).toMatchObject({
      kind: "user",
      text: "Fallback message",
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
    });
  });

  it("renders system-originated turns as user messages", () => {
    const { event, meta } = decodeThreadEventRow(systemMessageRequest());

    expect(
      parseUsersFromClientRequest({
        decoded: event,
        meta,
        options: standardProjectionOptions,
      })[0] ?? null,
    ).toMatchObject({
      initiator: "system",
      kind: "user",
      text: "[bb system] Maintenance notice.",
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
    });
  });
});
