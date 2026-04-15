import { describe, expect, it } from "vitest";
import type { ViewMessage } from "@bb/domain";
import {
  appendPendingClientRequestedMessage,
  attachPendingClientRequestedMessagesToTurn,
  createPendingClientRequestedMessageQueue,
  materializePendingClientRequestedMessages,
  shiftPendingClientRequestedMessage,
} from "../src/pending-client-requested-messages.js";

type UserMessage = Extract<ViewMessage, { kind: "user" }>;

interface BuildUserMessageArgs {
  id: string;
  seq: number;
  text?: string;
  threadId?: string;
}

function buildUserMessage(args: BuildUserMessageArgs): UserMessage {
  return {
    kind: "user",
    id: args.id,
    threadId: args.threadId ?? "thread-1",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    createdAt: args.seq,
    text: args.text ?? "Same steer",
  };
}

describe("pending client requested messages", () => {
  it("binds turnless requests to turns so later acks do not consume stale entries", () => {
    const queue = createPendingClientRequestedMessageQueue();

    appendPendingClientRequestedMessage(queue, {
      signature: "same",
      message: buildUserMessage({ id: "old", seq: 1 }),
    });
    attachPendingClientRequestedMessagesToTurn(queue, {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    appendPendingClientRequestedMessage(queue, {
      signature: "same",
      message: buildUserMessage({ id: "new", seq: 4 }),
    });
    attachPendingClientRequestedMessagesToTurn(queue, {
      threadId: "thread-1",
      turnId: "turn-2",
    });

    expect(
      shiftPendingClientRequestedMessage(queue, {
        signature: "same",
        turnId: "turn-2",
      }),
    ).toEqual({
      message: {
        ...buildUserMessage({ id: "new", seq: 4 }),
        turnId: "turn-2",
      },
      turnId: "turn-2",
    });
    expect(
      shiftPendingClientRequestedMessage(queue, {
        signature: "same",
        turnId: "turn-1",
      }),
    ).toEqual({
      message: {
        ...buildUserMessage({ id: "old", seq: 1 }),
        turnId: "turn-1",
      },
      turnId: "turn-1",
    });
  });

  it("materializes pending requests after durable rows without turn attachment", () => {
    const queue = createPendingClientRequestedMessageQueue();

    appendPendingClientRequestedMessage(queue, {
      signature: "same",
      message: buildUserMessage({ id: "pending", seq: 2 }),
    });
    attachPendingClientRequestedMessagesToTurn(queue, {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(materializePendingClientRequestedMessages(queue, 10)).toEqual([
      {
        ...buildUserMessage({ id: "pending", seq: 2 }),
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
      },
    ]);
  });

  it("does not pair turnless matches with turn-scoped pending requests", () => {
    const queue = createPendingClientRequestedMessageQueue();

    appendPendingClientRequestedMessage(queue, {
      signature: "same",
      message: {
        ...buildUserMessage({ id: "pending", seq: 2 }),
        turnId: "turn-1",
      },
      turnId: "turn-1",
    });

    expect(
      shiftPendingClientRequestedMessage(queue, {
        signature: "same",
      }),
    ).toBeUndefined();
    expect(
      shiftPendingClientRequestedMessage(queue, {
        signature: "same",
        turnId: "turn-1",
      }),
    ).toEqual({
      message: {
        ...buildUserMessage({ id: "pending", seq: 2 }),
        turnId: "turn-1",
      },
      turnId: "turn-1",
    });
  });
});
