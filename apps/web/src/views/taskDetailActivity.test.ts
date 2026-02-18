import { describe, expect, it } from "vitest";
import type { Thread, ThreadEvent, UIMessage } from "@beanbag/core";
import { toTaskThreadTurnMessages } from "./taskDetailActivity";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

type ThreadEventOverrides = Partial<Omit<ThreadEvent, "seq" | "type" | "data">> & {
  seq: number;
  type?: string;
  data?: unknown;
};

function makeEvent({ seq, ...overrides }: ThreadEventOverrides): ThreadEvent {
  return {
    id: `event-${seq}`,
    threadId: "thread-1",
    seq,
    type: "item/completed",
    data: {},
    createdAt: seq,
    ...overrides,
  } as ThreadEvent;
}

function assistantTextMessages(
  messages: UIMessage[],
): Array<Extract<UIMessage, { kind: "assistant-text" }>> {
  return messages.filter(
    (message): message is Extract<UIMessage, { kind: "assistant-text" }> =>
      message.kind === "assistant-text",
  );
}

describe("toTaskThreadTurnMessages", () => {
  it("keeps only the latest agent message for the same explicit turn id", () => {
    const thread = makeThread();
    const messages = assistantTextMessages(
      toTaskThreadTurnMessages(thread, [
      makeEvent({
        seq: 1,
        data: { turnId: "turn-1", item: { type: "agentMessage", text: "first" } },
      }),
      makeEvent({
        seq: 2,
        data: { turnId: "turn-1", item: { type: "agentMessage", text: "last" } },
      }),
      ]),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("last");
    expect(messages[0]?.sourceSeqStart).toBe(2);
  });

  it("infers turn ids from lifecycle events when item completion events omit turn ids", () => {
    const thread = makeThread();
    const messages = assistantTextMessages(
      toTaskThreadTurnMessages(thread, [
      makeEvent({ seq: 1, type: "turn/started", data: { turnId: "turn-1" } }),
      makeEvent({
        seq: 2,
        data: { item: { type: "agentMessage", text: "first" } },
      }),
      makeEvent({
        seq: 3,
        data: { item: { type: "agentMessage", text: "last" } },
      }),
      makeEvent({ seq: 4, type: "turn/completed", data: { turnId: "turn-1" } }),
      ]),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("last");
    expect(messages[0]?.sourceSeqStart).toBe(3);
  });

  it("falls back to seq grouping when turn information is unavailable", () => {
    const thread = makeThread();
    const messages = assistantTextMessages(
      toTaskThreadTurnMessages(thread, [
      makeEvent({
        seq: 1,
        data: { item: { type: "agentMessage", text: "alpha" } },
      }),
      makeEvent({
        seq: 2,
        data: { item: { type: "agentMessage", text: "beta" } },
      }),
      ]),
    );

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.text)).toEqual(["alpha", "beta"]);
  });
});
