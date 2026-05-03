import { turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { groupCompletedTurnMessages } from "../src/completed-turn-grouping.js";
import type {
  CompletedTurnMessageGroups,
} from "../src/completed-turn-grouping.js";
import type {
  EventProjectionAssistantTextMessage,
  EventProjectionMessage,
  EventProjectionTurn,
  EventProjectionUserMessage,
} from "../src/event-projection-types.js";

interface MessageBaseArgs {
  id: string;
  seq: number;
}

function messageBase({ id, seq }: MessageBaseArgs) {
  return {
    id,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    startedAt: seq,
    scope: turnScope("turn-1"),
  };
}

function assistantMessage(
  args: MessageBaseArgs,
): EventProjectionAssistantTextMessage {
  return {
    ...messageBase(args),
    kind: "assistant-text",
    text: args.id,
    status: "completed",
  };
}

function userMessage(args: MessageBaseArgs): EventProjectionUserMessage {
  return {
    ...messageBase(args),
    kind: "user",
    request: {
      kind: "message",
      status: "accepted",
    },
    text: args.id,
  };
}

function completedTurn(
  messages: EventProjectionMessage[],
  terminalMessage: EventProjectionMessage | undefined,
): EventProjectionTurn {
  return {
    turnId: "turn-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: messages.length,
    startedAt: 1,
    createdAt: messages.length,
    completedAt: messages.length,
    status: "completed",
    summaryCount: messages.length,
    durationMs: 10,
    messages,
    ...(terminalMessage ? { terminalMessage } : {}),
  };
}

function summarySourceMessageIds(groups: CompletedTurnMessageGroups): string[][] {
  return groups.summaryItems.flatMap((item) =>
    item.kind === "summary"
      ? [item.sourceMessages.map((message) => message.id)]
      : [],
  );
}

describe("groupCompletedTurnMessages", () => {
  it("uses one summary group when no messages are ungroupable", () => {
    const messages = [
      assistantMessage({ id: "assistant-1", seq: 1 }),
      assistantMessage({ id: "assistant-2", seq: 2 }),
    ];
    const groups = groupCompletedTurnMessages(completedTurn(messages, undefined));

    expect(groups.summaryItems).toMatchObject([
      {
        kind: "summary",
        durationMs: 10,
        segmentIndex: null,
        summaryCount: 2,
      },
    ]);
    expect(summarySourceMessageIds(groups)).toEqual([
      ["assistant-1", "assistant-2"],
    ]);
  });

  it("segments summary groups around ungroupable user messages", () => {
    const turn = completedTurn(
      [
        assistantMessage({ id: "assistant-before", seq: 1 }),
        userMessage({ id: "user", seq: 2 }),
        assistantMessage({ id: "assistant-after", seq: 3 }),
      ],
      undefined,
    );
    const groups = groupCompletedTurnMessages(turn);

    expect(groups.summaryItems).toMatchObject([
      {
        kind: "summary",
        durationMs: null,
        segmentIndex: 0,
        summaryCount: 1,
      },
      {
        kind: "ungrouped-message",
        message: {
          id: "user",
        },
      },
      {
        kind: "summary",
        durationMs: null,
        segmentIndex: 1,
        summaryCount: 1,
      },
    ]);
    expect(summarySourceMessageIds(groups)).toEqual([
      ["assistant-before"],
      ["assistant-after"],
    ]);
  });

  it("slices terminal and trailing messages out of the summary groups", () => {
    const before = assistantMessage({ id: "before", seq: 1 });
    const terminal = assistantMessage({ id: "terminal", seq: 2 });
    const trailing = assistantMessage({ id: "trailing", seq: 3 });
    const groups = groupCompletedTurnMessages(
      completedTurn([before, terminal, trailing], terminal),
    );

    expect(summarySourceMessageIds(groups)).toEqual([["before"]]);
    expect(groups.summaryItems).toMatchObject([
      {
        kind: "summary",
        sourceMessages: [{ id: "before" }],
      },
    ]);
    expect(groups.terminalMessages.map((message) => message.id)).toEqual([
      "terminal",
    ]);
    expect(groups.trailingMessages.map((message) => message.id)).toEqual([
      "trailing",
    ]);
  });
});
