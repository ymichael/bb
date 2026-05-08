import { describe, expect, it } from "vitest";
import { getThreadReadToggleAction } from "./threadReadState";

describe("getThreadReadToggleAction", () => {
  it("marks a thread read when it has never been read", () => {
    expect(
      getThreadReadToggleAction({
        lastReadAt: null,
        latestAttentionAt: 10,
      }),
    ).toBe("mark_read");
  });

  it("marks a thread read when its last read timestamp trails the latest attention", () => {
    expect(
      getThreadReadToggleAction({
        lastReadAt: 4,
        latestAttentionAt: 10,
      }),
    ).toBe("mark_read");
  });

  it("marks a thread unread when the latest attention is already covered", () => {
    expect(
      getThreadReadToggleAction({
        lastReadAt: 10,
        latestAttentionAt: 10,
      }),
    ).toBe("mark_unread");
  });

  it("keeps the unread action when lastReadAt is ahead of latestAttentionAt", () => {
    expect(
      getThreadReadToggleAction({
        lastReadAt: 12,
        latestAttentionAt: 10,
      }),
    ).toBe("mark_unread");
  });
});
