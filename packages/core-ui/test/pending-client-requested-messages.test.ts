import { describe, expect, it } from "vitest";
import type { ViewMessage } from "@bb/domain";
import {
  createPendingClientRequestedMessageQueue,
  materializePendingClientRequestedMessages,
  recordPendingClientRequestedMessage,
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
  it("pairs pending requests by client request sequence", () => {
    const queue = createPendingClientRequestedMessageQueue();
    const firstMessage = buildUserMessage({ id: "first", seq: 2 });
    const secondMessage = buildUserMessage({ id: "second", seq: 4 });

    recordPendingClientRequestedMessage(queue, {
      clientRequestSequence: 2,
      message: firstMessage,
    });
    recordPendingClientRequestedMessage(queue, {
      clientRequestSequence: 4,
      message: secondMessage,
    });

    expect(
      shiftPendingClientRequestedMessage(queue, {
        clientRequestSequence: 4,
      }),
    ).toEqual({ message: secondMessage });
    expect(
      shiftPendingClientRequestedMessage(queue, {
        clientRequestSequence: 2,
      }),
    ).toEqual({ message: firstMessage });
  });

  it("tracks hidden system requests without materializing a row", () => {
    const queue = createPendingClientRequestedMessageQueue();

    recordPendingClientRequestedMessage(queue, {
      clientRequestSequence: 2,
    });

    expect(materializePendingClientRequestedMessages(queue, 10)).toEqual([]);
    expect(
      shiftPendingClientRequestedMessage(queue, {
        clientRequestSequence: 2,
      }),
    ).toEqual({});
  });

  it("materializes unacknowledged pending requests after durable rows", () => {
    const queue = createPendingClientRequestedMessageQueue();

    recordPendingClientRequestedMessage(queue, {
      clientRequestSequence: 2,
      message: buildUserMessage({ id: "pending", seq: 2 }),
    });

    expect(materializePendingClientRequestedMessages(queue, 10)).toEqual([
      {
        ...buildUserMessage({ id: "pending", seq: 2 }),
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
      },
    ]);
  });
});
