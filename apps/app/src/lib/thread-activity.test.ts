import { describe, expect, it } from "vitest"
import {
  isBusyThread,
  isRunningThreadStatus,
  isUnreadDoneThread,
} from "./thread-activity"

describe("thread-activity", () => {
  it("exposes shared running/unread helpers", () => {
    expect(isRunningThreadStatus("created")).toBe(true)
    expect(isRunningThreadStatus("error")).toBe(false)
    expect(isRunningThreadStatus("idle")).toBe(false)
    expect(isBusyThread({ status: "active" })).toBe(true)

    expect(
      isUnreadDoneThread({
        status: "idle",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: null,
      }),
    ).toBe(true)
    expect(
      isUnreadDoneThread({
        status: "idle",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: "manager-1",
      }),
    ).toBe(false)
    expect(
      isUnreadDoneThread({
        status: "error",
        latestAttentionAt: 20,
        lastReadAt: 10,
        parentThreadId: null,
      }),
    ).toBe(true)
    expect(
      isUnreadDoneThread({
        status: "active",
        latestAttentionAt: 20,
        lastReadAt: null,
        parentThreadId: null,
      }),
    ).toBe(false)
  })
})
