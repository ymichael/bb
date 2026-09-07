import { describe, expect, it } from "vitest";
import { badgeCountFromSidebar } from "./app-badge";

function thread(over: Record<string, unknown>) {
  return {
    id: "t",
    status: "idle",
    parentThreadId: null,
    archivedAt: null,
    deletedAt: null,
    lastReadAt: 10,
    latestAttentionAt: 5,
    hasPendingInteraction: false,
    ...over,
  } as never;
}

describe("badgeCountFromSidebar", () => {
  it("counts unread finished root threads and pending interactions once each", () => {
    const count = badgeCountFromSidebar({
      projects: [
        {
          threads: [
            thread({ id: "read" }),
            thread({ id: "unread-idle", lastReadAt: 1 }),
            thread({ id: "unread-error", status: "error", lastReadAt: null }),
            thread({ id: "running-unread", status: "active", lastReadAt: 1 }),
            thread({ id: "pending", hasPendingInteraction: true }),
            thread({
              id: "pending-and-unread",
              hasPendingInteraction: true,
              lastReadAt: 1,
            }),
            thread({ id: "child", parentThreadId: "x", lastReadAt: 1 }),
            thread({ id: "archived", archivedAt: 1, lastReadAt: 1 }),
            thread({ id: "deleted", deletedAt: 1, lastReadAt: 1 }),
          ],
        } as never,
      ],
      personalProject: {
        threads: [thread({ id: "personal-unread", lastReadAt: 1 })],
      } as never,
    });
    expect(count).toBe(5);
  });
});
