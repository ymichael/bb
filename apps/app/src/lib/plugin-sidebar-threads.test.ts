import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { toPluginSidebarThread } from "./plugin-sidebar-threads";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";

function makeThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: "A thread",
    lastReadAt: 10,
    latestAttentionAt: 5,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

describe("toPluginSidebarThread", () => {
  it("maps activity counts onto the plugin-facing names", () => {
    const mapped = toPluginSidebarThread(
      makeThread({
        activity: {
          activeWorkflowCount: 2,
          activeBackgroundAgentCount: 3,
          activeBackgroundCommandCount: 4,
          activePlanModeCount: 5,
          activeGoalCount: 6,
        },
      }),
    );
    expect(mapped.activity).toEqual({
      workflows: 2,
      backgroundAgents: 3,
      backgroundCommands: 4,
      planMode: 5,
      goals: 6,
    });
  });

  it("resolves the indicator with the host's precedence", () => {
    expect(
      toPluginSidebarThread(
        makeThread({
          hasPendingInteraction: true,
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
        }),
      ).indicator,
    ).toBe("waiting-for-input");

    expect(
      toPluginSidebarThread(
        makeThread({
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
        }),
      ).indicator,
    ).toBe("runtime");

    expect(
      toPluginSidebarThread(
        makeThread({
          activity: {
            activeWorkflowCount: 1,
            activeBackgroundAgentCount: 0,
            activeBackgroundCommandCount: 0,
            activePlanModeCount: 0,
            activeGoalCount: 0,
          },
        }),
      ).indicator,
    ).toBe("workflow");
  });

  it("carries the host's accessible label, and null for none", () => {
    expect(
      toPluginSidebarThread(makeThread({ hasPendingInteraction: true }))
        .indicatorLabel,
    ).toBe("Thread needs user input");
    const idle = toPluginSidebarThread(makeThread());
    expect(idle.indicator).toBe("none");
    expect(idle.indicatorLabel).toBeNull();
  });

  it("reports an unread failure as an error indicator", () => {
    const mapped = toPluginSidebarThread(
      makeThread({ status: "error", lastReadAt: 1, latestAttentionAt: 9 }),
    );
    expect(mapped.indicator).toBe("unread-error");
    expect(mapped.isUnread).toBe(true);
  });

  it("reports unread child threads as unread", () => {
    const mapped = toPluginSidebarThread(
      makeThread({
        parentThreadId: "thr_parent",
        lastReadAt: 1,
        latestAttentionAt: 9,
      }),
    );
    expect(mapped.isUnread).toBe(true);
    expect(mapped.indicator).toBe("none");
  });

  it("treats a never-read thread as unread", () => {
    expect(
      toPluginSidebarThread(makeThread({ lastReadAt: null })).isUnread,
    ).toBe(true);
  });

  it("maps pin, archive, and environment fields", () => {
    const mapped = toPluginSidebarThread(
      makeThread({
        pinnedAt: 12,
        archivedAt: 13,
        environmentId: "env_1",
        environmentName: "Worktree",
        environmentBranchName: "bb/feature",
        queuedWork: "none",
        environmentWorkspaceDisplayKind: "managed-worktree",
      }),
    );
    expect(mapped.isPinned).toBe(true);
    expect(mapped.isArchived).toBe(true);
    expect(mapped.environment).toEqual({
      id: "env_1",
      name: "Worktree",
      branchName: "bb/feature",
      workspaceDisplayKind: "managed-worktree",
    });
  });

  it("reports no environment when the thread has none", () => {
    expect(toPluginSidebarThread(makeThread()).environment).toBeNull();
  });

  it("carries the provider so a row can draw an agent glyph", () => {
    expect(toPluginSidebarThread(makeThread()).providerId).toBe("codex");
  });

  it("resolves the machine name for the thread's host", () => {
    const mapped = toPluginSidebarThread(
      makeThread({ environmentHostId: "host_1" }),
      new Map([["host_1", "Sawyer's MacBook"]]),
    );
    expect(mapped.host).toEqual({ id: "host_1", name: "Sawyer's MacBook" });
  });

  it("falls back to the host id when the machine is unknown", () => {
    const mapped = toPluginSidebarThread(
      makeThread({ environmentHostId: "host_gone" }),
      new Map(),
    );
    expect(mapped.host).toEqual({ id: "host_gone", name: "host_gone" });
  });

  it("reports no host when the thread has none", () => {
    expect(toPluginSidebarThread(makeThread()).host).toBeNull();
  });
});
