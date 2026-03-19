import { describe, expect, it } from "vitest"
import {
  formatThreadActivitySummaryForTitle,
  getThreadStatusLabelForTitle,
  isBusyThread,
  isRunningThreadStatus,
  isUnreadDoneThread,
  isVisibleProjectThread,
  summarizeThreadActivity,
} from "./thread-activity"

describe("thread-activity", () => {
  it("classifies visible threads and counts running/unread/done summary", () => {
    const summary = summarizeThreadActivity([
      {
        status: "active",
        updatedAt: 100,
        archivedAt: undefined,
        parentThreadId: undefined,
      },
      {
        status: "idle",
        updatedAt: 200,
        lastReadAt: 100,
        archivedAt: undefined,
        parentThreadId: undefined,
      },
      {
        status: "idle",
        updatedAt: 300,
        lastReadAt: 300,
        archivedAt: undefined,
        parentThreadId: undefined,
      },
      {
        status: "idle",
        updatedAt: 400,
        archivedAt: 400,
        parentThreadId: undefined,
      },
      {
        status: "created",
        updatedAt: 500,
        archivedAt: undefined,
        parentThreadId: "parent",
      },
    ])

    expect(summary).toEqual({
      running: 1,
      unreadDone: 1,
      done: 2,
    })
  })

  it("formats title summaries with running + unread, or done fallback", () => {
    expect(
      formatThreadActivitySummaryForTitle({
        running: 2,
        unreadDone: 1,
        done: 3,
      }),
    ).toBe("2 running · 1 unread")

    expect(
      formatThreadActivitySummaryForTitle({
        running: 0,
        unreadDone: 0,
        done: 4,
      }),
    ).toBe("4 done")

    expect(
      formatThreadActivitySummaryForTitle({
        running: 0,
        unreadDone: 0,
        done: 0,
      }),
    ).toBeUndefined()
  })

  it("labels individual thread state for titles", () => {
    expect(
      getThreadStatusLabelForTitle({
        status: "active",
        updatedAt: 100,
      }),
    ).toBe("Running")

    expect(
      getThreadStatusLabelForTitle({
        status: "active",
        updatedAt: 100,
      }),
    ).toBe("Running")

    expect(
      getThreadStatusLabelForTitle({
        status: "idle",
        updatedAt: 100,
        lastReadAt: 50,
      }),
    ).toBe("Unread done")

    expect(
      getThreadStatusLabelForTitle({
        status: "idle",
        updatedAt: 100,
        lastReadAt: 100,
      }),
    ).toBe("Done")

    expect(
      getThreadStatusLabelForTitle({
        status: "provisioning_failed",
        updatedAt: 100,
      }),
    ).toBe("Provisioning failed")
    expect(
      getThreadStatusLabelForTitle({
        status: "error",
        updatedAt: 100,
      }),
    ).toBe("Error")
  })

  it("exposes shared visibility/running/unread helpers", () => {
    expect(isVisibleProjectThread({ archivedAt: undefined, parentThreadId: undefined })).toBe(
      true,
    )
    expect(isVisibleProjectThread({ archivedAt: 1, parentThreadId: undefined })).toBe(false)

    expect(isRunningThreadStatus("created")).toBe(true)
    expect(isRunningThreadStatus("error")).toBe(false)
    expect(isRunningThreadStatus("idle")).toBe(false)
    expect(isBusyThread({ status: "active" })).toBe(true)

    expect(
      isUnreadDoneThread({
        status: "idle",
        updatedAt: 20,
        lastReadAt: 10,
      }),
    ).toBe(true)
    expect(
      isUnreadDoneThread({
        status: "idle",
        updatedAt: 20,
        lastReadAt: 10,
        parentThreadId: "manager-1",
      }),
    ).toBe(false)
    expect(
      isUnreadDoneThread({
        status: "active",
        updatedAt: 20,
      }),
    ).toBe(false)
  })
})
