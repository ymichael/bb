import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { buildProjectThreadGroups } from "./projectThreadGroups";

type ThreadListEntryOverrides = Partial<ThreadListEntry>;

function createThread(
  overrides: ThreadListEntryOverrides = {},
): ThreadListEntry {
  return {
    id: "thr_1",
    projectId: "proj_1",
    environmentId: null,
    automationId: null,
    providerId: "codex",
    type: "standard",
    title: "Thread",
    titleFallback: "Thread",
    status: "active",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    ...overrides,
  };
}

function threadIds(threads: readonly ThreadListEntry[]): string[] {
  return threads.map((thread) => thread.id);
}

describe("buildProjectThreadGroups", () => {
  it("classifies managers, known managed children, and other threads", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "root-old",
        createdAt: 10,
      }),
      createThread({
        id: "manager-old",
        type: "manager",
        createdAt: 20,
      }),
      createThread({
        id: "manager-new",
        type: "manager",
        createdAt: 40,
      }),
      createThread({
        id: "child-busy",
        parentThreadId: "manager-old",
        createdAt: 50,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "child-idle",
        parentThreadId: "manager-old",
        createdAt: 30,
      }),
      createThread({
        id: "orphan-child",
        parentThreadId: "missing-manager",
        createdAt: 60,
      }),
    ]);

    expect(threadIds(groups.managerThreads)).toEqual([
      "manager-new",
      "manager-old",
    ]);
    expect(
      threadIds(groups.managedThreadsByManagerId.get("manager-old") ?? []),
    ).toEqual(["child-busy", "child-idle"]);
    expect(
      groups.managedThreadsByManagerId.get("manager-new"),
    ).toBeUndefined();
    expect(groups.managedChildBusyCountsByManagerId.get("manager-old")).toBe(1);
    expect(threadIds(groups.otherThreads)).toEqual([
      "orphan-child",
      "root-old",
    ]);
  });
});
