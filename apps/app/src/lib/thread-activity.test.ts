import { describe, expect, it } from "vitest";
import {
  isBusyThread,
  isUnreadDoneThread,
} from "./thread-activity";

describe("thread-activity", () => {
  it("exposes shared running/unread helpers", () => {
    expect(
      isBusyThread({
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    ).toBe(true);
    expect(
      isBusyThread({
        runtime: {
          displayStatus: "host-reconnecting",
          hostReconnectGraceExpiresAt: 100,
        },
      }),
    ).toBe(true);
    expect(
      isBusyThread({
        runtime: {
          displayStatus: "waiting-for-host",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    ).toBe(false);

    expect(
      isUnreadDoneThread({
        status: "idle",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: null,
      }),
    ).toBe(true);
    expect(
      isUnreadDoneThread({
        status: "idle",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: "manager-1",
      }),
    ).toBe(false);
    expect(
      isUnreadDoneThread({
        status: "error",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: null,
      }),
    ).toBe(true);
    expect(
      isUnreadDoneThread({
        status: "active",
        latestAttentionAt: 20,
        lastReadAt: null,
        parentThreadId: null,
      }),
    ).toBe(false);
  });
});
