import { describe, expect, it } from "vitest";
import {
  createTimelineEventFactory,
  type TimelineEventFactory,
} from "./timeline-test-harness.js";
import { decodeThreadEventRow } from "../src/event-decode.js";
import type {
  BuildEventProjectionMessagesOptions,
} from "../src/event-projection-types.js";
import {
  type AcceptedClientRequest,
  parseAcceptedSteerFromClientRequest,
  parsePendingSteerFromClientRequest,
} from "../src/user-message-parsing.js";

type ClientTurnRequestedEventRow = ReturnType<
  TimelineEventFactory["clientTurnRequested"]
>;

const AGENT_STEER_TEXT = "Please account for the restart";

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

const managerDebugVisibilityOptions: BuildEventProjectionMessagesOptions = {
  systemClientRequestVisibility: "visible",
  threadStatus: "active",
  threadType: "manager",
};

function agentSteerRequest(): ClientTurnRequestedEventRow {
  const event = createTimelineEventFactory({ threadId: "thread-1" });
  return event.clientTurnRequested({
    initiator: "agent",
    target: { kind: "auto", expectedTurnId: "turn-1" },
    text: AGENT_STEER_TEXT,
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
  it("hides agent-originated pending steers from manager conversation visibility", () => {
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
      parsePendingSteerFromClientRequest({
        acceptedClientRequest: undefined,
        decoded: event,
        meta,
        options: standardVisibilityOptions,
      }),
    ).toMatchObject({
      kind: "user",
      request: { kind: "steer", status: "pending" },
      text: AGENT_STEER_TEXT,
    });

    expect(
      parsePendingSteerFromClientRequest({
        acceptedClientRequest: undefined,
        decoded: event,
        meta,
        options: managerDebugVisibilityOptions,
      }),
    ).toMatchObject({
      kind: "user",
      request: { kind: "steer", status: "pending" },
      text: AGENT_STEER_TEXT,
    });
  });

  it("hides agent-originated accepted steers from manager conversation visibility", () => {
    const { event, meta } = decodeThreadEventRow(agentSteerRequest());
    const acceptedRequest = acceptedClientRequest();

    expect(
      parseAcceptedSteerFromClientRequest({
        acceptedClientRequest: acceptedRequest,
        decoded: event,
        meta,
        options: managerConversationVisibilityOptions,
      }),
    ).toBeNull();

    expect(
      parseAcceptedSteerFromClientRequest({
        acceptedClientRequest: acceptedRequest,
        decoded: event,
        meta,
        options: standardVisibilityOptions,
      }),
    ).toMatchObject({
      kind: "user",
      request: { kind: "steer", status: "accepted" },
      sourceSeqStart: acceptedRequest.meta.seq,
      text: AGENT_STEER_TEXT,
    });

    expect(
      parseAcceptedSteerFromClientRequest({
        acceptedClientRequest: acceptedRequest,
        decoded: event,
        meta,
        options: managerDebugVisibilityOptions,
      }),
    ).toMatchObject({
      kind: "user",
      request: { kind: "steer", status: "accepted" },
      sourceSeqStart: acceptedRequest.meta.seq,
      text: AGENT_STEER_TEXT,
    });
  });
});
