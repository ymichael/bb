import { describe, expect, it } from "vitest";
import {
  createTimelineEventFactory,
  type TimelineEventFactory,
} from "./timeline-test-harness.js";
import { decodeThreadEventRow } from "../src/event-decode.js";
import type { BuildEventProjectionMessagesOptions } from "../src/event-projection-types.js";
import {
  type AcceptedClientRequest,
  parsePromptInput,
  parseAcceptedSteerFromClientRequest,
  parsePendingSteerFromClientRequest,
  parseUserFromClientRequest,
} from "../src/user-message-parsing.js";

type ClientTurnRequestedEventRow = ReturnType<
  TimelineEventFactory["clientTurnRequested"]
>;

const AGENT_STEER_TEXT = "Please account for the restart";
const SENDER_THREAD_ID = "thr_sender";

const standardVisibilityOptions: BuildEventProjectionMessagesOptions = {
  systemClientRequestVisibility: "hidden",
  threadStatus: "active",
};

const managerConversationVisibilityOptions: BuildEventProjectionMessagesOptions =
  {
    systemClientRequestVisibility: "hidden",
    threadStatus: "active",
    threadType: "manager",
  };

const managerStandardVisibilityOptions: BuildEventProjectionMessagesOptions = {
  systemClientRequestVisibility: "visible",
  threadStatus: "active",
  threadType: "manager",
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
    text: "[bb system] Scheduled nudge: daily. Check ASYNC.md.",
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

function acceptedClientRequest(): AcceptedClientRequest {
  return {
    meta: {
      id: "event-accepted",
      seq: 2,
      createdAt: 2,
    },
    turnId: "turn-1",
  };
}

describe("user message parsing", () => {
  it("omits agent-only prompt input parts from timeline text and attachments", () => {
    const parsed = parsePromptInput([
      {
        type: "text",
        text: "[bb system]\n\nCurrent PREFERENCES.md contents:\n\nsecret",
        visibility: "agent-only",
      },
      { type: "text", text: "Visible request" },
      {
        type: "localFile",
        path: "/tmp/hidden.md",
        visibility: "agent-only",
      },
      { type: "localFile", path: "/tmp/visible.md" },
    ]);

    expect(parsed).toEqual({
      text: "Visible request",
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
        text: "[bb system]\n\nPREFERENCES.md was removed.",
        visibility: "agent-only",
      },
    ]);

    expect(parsed).toBeNull();
  });

  it("populates initiator, senderThreadId, and turnRequest for user-initiated messages", () => {
    const { event, meta } = decodeThreadEventRow(userMessageRequest());

    const message = parseUserFromClientRequest({
      decoded: event,
      meta,
      options: standardVisibilityOptions,
    });

    expect(message).toMatchObject({
      kind: "user",
      initiator: "user",
      senderThreadId: null,
      turnRequest: { kind: "message", status: "pending" },
      text: "Hello",
    });
  });

  it("populates initiator, senderThreadId, and turnRequest for agent-initiated messages", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const agentText =
      "[bb message from thread:thr_sender; reply with …]\n\nHi";
    const row = factory.clientTurnRequested({
      initiator: "agent",
      senderThreadId: SENDER_THREAD_ID,
      target: { kind: "new-turn" },
      text: agentText,
    });
    const { event, meta } = decodeThreadEventRow(row);

    const message = parseUserFromClientRequest({
      decoded: event,
      meta,
      options: standardVisibilityOptions,
    });

    expect(message).toMatchObject({
      kind: "user",
      initiator: "agent",
      senderThreadId: SENDER_THREAD_ID,
      turnRequest: { kind: "message", status: "pending" },
      // Text passes through unchanged — the renderer mutes the `[bb …]`
      // prefix at display time; the projection never slices.
      text: agentText,
    });
  });

  it("populates initiator for system-initiated messages with a turnRequest", () => {
    const { event, meta } = decodeThreadEventRow(systemMessageRequest());

    const message = parseUserFromClientRequest({
      decoded: event,
      meta,
      options: managerStandardVisibilityOptions,
    });

    expect(message).toMatchObject({
      kind: "user",
      initiator: "system",
      senderThreadId: null,
      turnRequest: { kind: "message", status: "pending" },
    });
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
      const visibilityOptions =
        event.initiator === "system"
          ? managerStandardVisibilityOptions
          : standardVisibilityOptions;
      const expectedText = event.input
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const accepted = acceptedClientRequest();

      expect(
        parsePendingSteerFromClientRequest({
          acceptedClientRequest: undefined,
          decoded: event,
          meta,
          options: visibilityOptions,
        }),
      ).toMatchObject({
        kind: "user",
        turnRequest: { kind: "steer", status: "pending" },
        // Pending steers anchor at the request's own meta — there is no
        // accept event yet to route to.
        text: expectedText,
        sourceSeqStart: meta.seq,
      });
      expect(
        parseAcceptedSteerFromClientRequest({
          acceptedClientRequest: accepted,
          decoded: event,
          meta,
          options: visibilityOptions,
        }),
      ).toMatchObject({
        kind: "user",
        turnRequest: { kind: "steer", status: "accepted" },
        // Accepted steers anchor at the accept event's seq, not the request's,
        // so they land at the right point in the timeline once accepted.
        text: expectedText,
        sourceSeqStart: accepted.meta.seq,
      });
      // Steers flow through the steer-specific parsers — parseUser short-circuits.
      expect(
        parseUserFromClientRequest({
          decoded: event,
          meta,
          options: visibilityOptions,
        }),
      ).toBeNull();
    }
  });

  it("hides agent-originated steers from manager conversation visibility", () => {
    const { event, meta } = decodeThreadEventRow(agentSteerRequest());

    expect(
      parsePendingSteerFromClientRequest({
        acceptedClientRequest: undefined,
        decoded: event,
        meta,
        options: managerConversationVisibilityOptions,
      }),
    ).toBeNull();

    expect(
      parseAcceptedSteerFromClientRequest({
        acceptedClientRequest: acceptedClientRequest(),
        decoded: event,
        meta,
        options: managerConversationVisibilityOptions,
      }),
    ).toBeNull();
  });

  it("hides system-originated turns in non-manager-standard views", () => {
    const { event, meta } = decodeThreadEventRow(systemMessageRequest());

    expect(
      parseUserFromClientRequest({
        decoded: event,
        meta,
        options: standardVisibilityOptions,
      }),
    ).toBeNull();
  });
});
