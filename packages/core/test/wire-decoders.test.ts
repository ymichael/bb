import { describe, expect, it } from "vitest";
import {
  decodeSystemShutdownBlockedResponse,
  decodeThreadIdFromWireValue,
} from "../src/index.js";

describe("wire decoders", () => {
  it("extracts thread ids from top-level and nested payload shapes", () => {
    expect(decodeThreadIdFromWireValue({ threadId: "thread-1" })).toBe("thread-1");
    expect(decodeThreadIdFromWireValue({ thread: { id: "thread-2" } })).toBe(
      "thread-2",
    );
    expect(decodeThreadIdFromWireValue({ threadId: "", thread: { id: "thread-3" } })).toBe(
      "thread-3",
    );
    expect(decodeThreadIdFromWireValue(null)).toBeUndefined();
  });

  it("extracts thread ids from conversationId and thread_id fields", () => {
    expect(decodeThreadIdFromWireValue({ conversationId: "conv-1" })).toBe("conv-1");
    expect(decodeThreadIdFromWireValue({ conversation_id: "conv-2" })).toBe("conv-2");
    expect(decodeThreadIdFromWireValue({ thread_id: "tid-3" })).toBe("tid-3");
  });

  it("prefers threadId over conversationId when both are present", () => {
    expect(
      decodeThreadIdFromWireValue({ threadId: "thread-1", conversationId: "conv-1" }),
    ).toBe("thread-1");
  });

  it("decodes shutdown-blocked responses and filters invalid blocking threads", () => {
    expect(
      decodeSystemShutdownBlockedResponse({
        code: "shutdown_blocked",
        message: "busy",
        blockingThreads: [
          { id: "thread-1", projectId: "project-1", status: "active" },
          { id: "thread-2", projectId: 42, status: "active" },
        ],
      }),
    ).toEqual({
      code: "shutdown_blocked",
      message: "busy",
      blockingThreads: [
        { id: "thread-1", projectId: "project-1", status: "active" },
      ],
    });
  });
});
