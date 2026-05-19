// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BB_STATUS_TELL_MAX_BYTES,
  BB_STATUS_TELL_MESSAGE_TYPE,
  BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
  handleBbStatusMessage,
  isBbStatusTellEnvelope,
  parseBbStatusTellMessage,
  type BbStatusTellSender,
} from "./iframe-status-bridge";

interface FakeWindowOptions {
  postMessage?: ReturnType<typeof vi.fn>;
}

function makeFakeWindow(options: FakeWindowOptions = {}): Window {
  const postMessage = options.postMessage ?? vi.fn();
  // The bridge only invokes postMessage on the reply window; the rest of the
  // Window surface is unused, so cast through unknown is safe in test scope.
  return { postMessage } as unknown as Window;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("isBbStatusTellEnvelope", () => {
  it("recognises a well-formed envelope", () => {
    expect(
      isBbStatusTellEnvelope({ type: BB_STATUS_TELL_MESSAGE_TYPE, text: "x" }),
    ).toBe(true);
  });

  it("rejects null, primitives, and wrong-type messages", () => {
    expect(isBbStatusTellEnvelope(null)).toBe(false);
    expect(isBbStatusTellEnvelope("bb-status:tell")).toBe(false);
    expect(isBbStatusTellEnvelope({ type: "other:event", text: "x" })).toBe(
      false,
    );
  });
});

describe("parseBbStatusTellMessage", () => {
  it("parses a message with an integer id and non-empty text", () => {
    const parsed = parseBbStatusTellMessage({
      id: 7,
      type: BB_STATUS_TELL_MESSAGE_TYPE,
      text: "hello",
    });
    expect(parsed).toEqual({ ok: true, message: { id: 7, text: "hello" } });
  });

  it("treats missing id as null (still ok)", () => {
    const parsed = parseBbStatusTellMessage({
      type: BB_STATUS_TELL_MESSAGE_TYPE,
      text: "hello",
    });
    expect(parsed).toEqual({ ok: true, message: { id: null, text: "hello" } });
  });

  it("rejects messages with the wrong type", () => {
    const parsed = parseBbStatusTellMessage({
      id: 1,
      type: "other",
      text: "hi",
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects non-string text", () => {
    const parsed = parseBbStatusTellMessage({
      id: 1,
      type: BB_STATUS_TELL_MESSAGE_TYPE,
      text: 42,
    });
    expect(parsed).toMatchObject({ ok: false, id: 1 });
  });

  it("rejects empty text", () => {
    const parsed = parseBbStatusTellMessage({
      id: 2,
      type: BB_STATUS_TELL_MESSAGE_TYPE,
      text: "",
    });
    expect(parsed).toMatchObject({ ok: false, id: 2 });
  });

  it("rejects text larger than the 4 KiB byte limit", () => {
    const oversize = "a".repeat(BB_STATUS_TELL_MAX_BYTES + 1);
    const parsed = parseBbStatusTellMessage({
      id: 3,
      type: BB_STATUS_TELL_MESSAGE_TYPE,
      text: oversize,
    });
    expect(parsed).toMatchObject({ ok: false, id: 3 });
    if (!parsed.ok) {
      expect(parsed.error).toContain(`${BB_STATUS_TELL_MAX_BYTES}`);
    }
  });

  it("counts bytes, not characters, against the cap", () => {
    // A 4-byte UTF-8 character. Repeating it 1024 times = 4096 bytes, exactly
    // at the cap. 1025 of them = 4100 bytes, over the cap.
    const fourBytes = "\u{1F600}";
    const atCap = fourBytes.repeat(1024);
    const overCap = fourBytes.repeat(1025);
    expect(parseBbStatusTellMessage({
      type: BB_STATUS_TELL_MESSAGE_TYPE,
      text: atCap,
    }).ok).toBe(true);
    expect(parseBbStatusTellMessage({
      type: BB_STATUS_TELL_MESSAGE_TYPE,
      text: overCap,
    }).ok).toBe(false);
  });
});

describe("handleBbStatusMessage", () => {
  it("dispatches to the configured thread and posts an ok reply", async () => {
    const postMessage = vi.fn();
    const replyTo = makeFakeWindow({ postMessage });
    const send: BbStatusTellSender = vi.fn(async () => {});

    await handleBbStatusMessage({
      data: {
        id: 9,
        type: BB_STATUS_TELL_MESSAGE_TYPE,
        text: "Mark todo #3 done",
      },
      replyTo,
      threadId: "thr_abc",
      send,
    });

    expect(send).toHaveBeenCalledWith({
      threadId: "thr_abc",
      text: "Mark todo #3 done",
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
        id: 9,
        ok: true,
      },
      "*",
    );
  });

  it("posts an error reply when the sender throws", async () => {
    const postMessage = vi.fn();
    const replyTo = makeFakeWindow({ postMessage });
    const send: BbStatusTellSender = vi.fn(async () => {
      throw new Error("network down");
    });

    await handleBbStatusMessage({
      data: { id: 11, type: BB_STATUS_TELL_MESSAGE_TYPE, text: "hello" },
      replyTo,
      threadId: "thr_abc",
      send,
    });

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
        id: 11,
        ok: false,
        error: "network down",
      },
      "*",
    );
  });

  it("posts an error reply when the message is oversize", async () => {
    const postMessage = vi.fn();
    const replyTo = makeFakeWindow({ postMessage });
    const send: BbStatusTellSender = vi.fn(async () => {});

    await handleBbStatusMessage({
      data: {
        id: 12,
        type: BB_STATUS_TELL_MESSAGE_TYPE,
        text: "a".repeat(BB_STATUS_TELL_MAX_BYTES + 1),
      },
      replyTo,
      threadId: "thr_abc",
      send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [payload] = postMessage.mock.calls[0]!;
    expect(payload).toMatchObject({
      type: BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
      id: 12,
      ok: false,
    });
  });

  it("ignores non-tell envelopes without replying", async () => {
    const postMessage = vi.fn();
    const replyTo = makeFakeWindow({ postMessage });
    const send: BbStatusTellSender = vi.fn(async () => {});

    await handleBbStatusMessage({
      data: { type: "other:event", text: "hi" },
      replyTo,
      threadId: "thr_abc",
      send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("replies with an error when no thread context is available", async () => {
    const postMessage = vi.fn();
    const replyTo = makeFakeWindow({ postMessage });
    const send: BbStatusTellSender = vi.fn(async () => {});

    await handleBbStatusMessage({
      data: { id: 4, type: BB_STATUS_TELL_MESSAGE_TYPE, text: "hi" },
      replyTo,
      threadId: null,
      send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [payload] = postMessage.mock.calls[0]!;
    expect(payload).toMatchObject({
      type: BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
      id: 4,
      ok: false,
    });
  });

  it("echoes a null id when the request omitted it", async () => {
    const postMessage = vi.fn();
    const replyTo = makeFakeWindow({ postMessage });
    const send: BbStatusTellSender = vi.fn(async () => {});

    await handleBbStatusMessage({
      data: { type: BB_STATUS_TELL_MESSAGE_TYPE, text: "no id here" },
      replyTo,
      threadId: "thr_abc",
      send,
    });

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: BB_STATUS_TELL_RESULT_MESSAGE_TYPE,
        id: null,
        ok: true,
      },
      "*",
    );
  });
});
