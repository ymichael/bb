import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildProjectThreadGroups,
  type ProjectThreadItem,
} from "./projectThreadGroups";

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
    status: "idle",
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

type ItemSummary =
  | string
  | { env: string; threads: string[] }
  | { manager: string; items: ItemSummary[] };

function summarizeItems(items: readonly ProjectThreadItem[]): ItemSummary[] {
  return items.map((item) => {
    switch (item.kind) {
      case "thread":
        return item.thread.id;
      case "environment":
        return {
          env: item.group.environmentId,
          threads: item.group.threads.map((thread) => thread.id),
        };
      case "manager":
        return {
          manager: item.group.managerThread.id,
          items: summarizeItems(item.group.managedItems),
        };
    }
  });
}

function looseThreadIds(items: readonly ProjectThreadItem[]): string[] {
  return items.map((item) => {
    if (item.kind === "environment") {
      throw new Error(
        `expected thread item, got env group ${item.group.environmentId}`,
      );
    }
    if (item.kind === "manager") {
      throw new Error(
        `expected thread item, got nested manager ${item.group.managerThread.id}`,
      );
    }
    return item.thread.id;
  });
}

describe("buildProjectThreadGroups", () => {
  it("groups managers with managed child stats while sorting unmanaged standards separately", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "root-old",
        createdAt: 10,
        latestAttentionAt: 10,
        updatedAt: 10,
      }),
      createThread({
        id: "manager-old",
        type: "manager",
        createdAt: 20,
        updatedAt: 20,
      }),
      createThread({
        id: "manager-new",
        type: "manager",
        createdAt: 40,
        updatedAt: 40,
      }),
      createThread({
        id: "child-busy",
        parentThreadId: "manager-old",
        createdAt: 50,
        latestAttentionAt: 80,
        updatedAt: 80,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "child-idle",
        parentThreadId: "manager-old",
        createdAt: 30,
        latestAttentionAt: 90,
        updatedAt: 90,
      }),
      createThread({
        id: "orphan-child",
        parentThreadId: "missing-manager",
        createdAt: 60,
        latestAttentionAt: 70,
        updatedAt: 70,
      }),
    ]);

    expect(
      groups.managerThreadGroups.map((group) => group.managerThread.id),
    ).toEqual(["manager-new", "manager-old"]);
    expect(groups.managerThreadGroups[0]?.stats).toEqual({
      managedChildBusyCount: 0,
      managedChildCount: 0,
    });
    expect(looseThreadIds(groups.managerThreadGroups[0]?.managedItems ?? []))
      .toEqual([]);
    expect(groups.managerThreadGroups[1]?.stats).toEqual({
      managedChildBusyCount: 1,
      managedChildCount: 2,
    });
    expect(looseThreadIds(groups.managerThreadGroups[1]?.managedItems ?? []))
      .toEqual(["child-idle", "child-busy"]);
    expect(looseThreadIds(groups.unmanagedItems)).toEqual([
      "orphan-child",
      "root-old",
    ]);
  });

  it("sorts unmanaged standard threads with active rows before inactive attention recency", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "active-older-created",
        status: "active",
        createdAt: 10,
        latestAttentionAt: 2_000,
        updatedAt: 1_000,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "active-newer-created",
        status: "active",
        createdAt: 20,
        latestAttentionAt: 1_500,
        updatedAt: 500,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "idle-newer-attention",
        createdAt: 40,
        latestAttentionAt: 900,
        updatedAt: 900,
      }),
      createThread({
        id: "idle-older-attention",
        createdAt: 30,
        latestAttentionAt: 750,
        updatedAt: 750,
      }),
    ]);

    expect(looseThreadIds(groups.unmanagedItems)).toEqual([
      "active-newer-created",
      "active-older-created",
      "idle-newer-attention",
      "idle-older-attention",
    ]);
  });

  it("keeps inactive rows stable when only maintenance updatedAt changes", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "older-attention-recently-maintained",
        createdAt: 10,
        latestAttentionAt: 100,
        updatedAt: 1_000,
      }),
      createThread({
        id: "newer-attention",
        createdAt: 20,
        latestAttentionAt: 200,
        updatedAt: 300,
      }),
    ]);

    expect(looseThreadIds(groups.unmanagedItems)).toEqual([
      "newer-attention",
      "older-attention-recently-maintained",
    ]);
  });

  it("applies deterministic tiebreaks inside standard thread buckets", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "active-b",
        status: "active",
        createdAt: 100,
        updatedAt: 1_000,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "active-a",
        status: "active",
        createdAt: 100,
        updatedAt: 500,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "idle-created-a",
        createdAt: 10,
        latestAttentionAt: 400,
        updatedAt: 400,
      }),
      createThread({
        id: "idle-created-b",
        createdAt: 20,
        latestAttentionAt: 400,
        updatedAt: 400,
      }),
      createThread({
        id: "idle-id-b",
        createdAt: 5,
        latestAttentionAt: 300,
        updatedAt: 300,
      }),
      createThread({
        id: "idle-id-a",
        createdAt: 5,
        latestAttentionAt: 300,
        updatedAt: 300,
      }),
    ]);

    expect(looseThreadIds(groups.unmanagedItems)).toEqual([
      "active-a",
      "active-b",
      "idle-created-b",
      "idle-created-a",
      "idle-id-a",
      "idle-id-b",
    ]);
  });

  it("sorts managed children with active rows before inactive attention recency", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "manager",
        type: "manager",
      }),
      createThread({
        id: "active-older-created-child",
        parentThreadId: "manager",
        status: "active",
        createdAt: 10,
        latestAttentionAt: 2_000,
        updatedAt: 5_000,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "active-newer-created-child",
        parentThreadId: "manager",
        status: "active",
        createdAt: 20,
        latestAttentionAt: 1_500,
        updatedAt: 500,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "idle-newer-attention-child",
        parentThreadId: "manager",
        createdAt: 40,
        latestAttentionAt: 900,
        updatedAt: 900,
      }),
      createThread({
        id: "idle-older-attention-child",
        parentThreadId: "manager",
        createdAt: 30,
        latestAttentionAt: 750,
        updatedAt: 750,
      }),
    ]);

    expect(looseThreadIds(groups.managerThreadGroups[0]?.managedItems ?? []))
      .toEqual([
      "active-newer-created-child",
      "active-older-created-child",
      "idle-newer-attention-child",
      "idle-older-attention-child",
    ]);
  });

  it("groups standard threads that share a worktree environment", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "wt-thread-a",
        environmentId: "env_shared",
        environmentWorkspaceDisplayKind: "managed-worktree",
        environmentBranchName: "feat/sidebar",
        createdAt: 10,
        latestAttentionAt: 100,
      }),
      createThread({
        id: "wt-thread-b",
        environmentId: "env_shared",
        environmentWorkspaceDisplayKind: "managed-worktree",
        environmentBranchName: "feat/sidebar",
        createdAt: 20,
        latestAttentionAt: 200,
      }),
      createThread({
        id: "loose-thread",
        createdAt: 5,
        latestAttentionAt: 50,
      }),
    ]);

    expect(summarizeItems(groups.unmanagedItems)).toEqual([
      { env: "env_shared", threads: ["wt-thread-b", "wt-thread-a"] },
      "loose-thread",
    ]);
  });

  it("leaves a solo worktree thread loose instead of building a 1-thread group", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "solo-wt",
        environmentId: "env_solo",
        environmentWorkspaceDisplayKind: "managed-worktree",
      }),
    ]);

    expect(summarizeItems(groups.unmanagedItems)).toEqual(["solo-wt"]);
  });

  it("does not group threads with non-worktree environments even when they share an environmentId", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "other-a",
        environmentId: "env_other",
        environmentWorkspaceDisplayKind: "other",
      }),
      createThread({
        id: "other-b",
        environmentId: "env_other",
        environmentWorkspaceDisplayKind: "other",
      }),
    ]);

    expect(summarizeItems(groups.unmanagedItems)).toEqual([
      "other-a",
      "other-b",
    ]);
  });

  it("interleaves env groups with loose threads at the project level by recency", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "old-loose",
        createdAt: 1,
        latestAttentionAt: 100,
      }),
      createThread({
        id: "wt-old-a",
        environmentId: "env_old_wt",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 2,
        latestAttentionAt: 200,
      }),
      createThread({
        id: "wt-old-b",
        environmentId: "env_old_wt",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 3,
        latestAttentionAt: 250,
      }),
      createThread({
        id: "recent-loose",
        createdAt: 4,
        latestAttentionAt: 900,
      }),
      createThread({
        id: "wt-new-a",
        environmentId: "env_new_wt",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 5,
        latestAttentionAt: 800,
      }),
      createThread({
        id: "wt-new-b",
        environmentId: "env_new_wt",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 6,
        latestAttentionAt: 950,
      }),
    ]);

    expect(summarizeItems(groups.unmanagedItems)).toEqual([
      { env: "env_new_wt", threads: ["wt-new-b", "wt-new-a"] },
      "recent-loose",
      { env: "env_old_wt", threads: ["wt-old-b", "wt-old-a"] },
      "old-loose",
    ]);
  });

  it("floats an env group above an idle loose thread when one of its threads is active", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "idle-loose-recent",
        createdAt: 1,
        latestAttentionAt: 5_000,
      }),
      createThread({
        id: "active-in-env",
        status: "active",
        environmentId: "env_active",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 10,
        latestAttentionAt: 100,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
      createThread({
        id: "idle-in-env",
        environmentId: "env_active",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 5,
        latestAttentionAt: 200,
      }),
    ]);

    expect(summarizeItems(groups.unmanagedItems)).toEqual([
      { env: "env_active", threads: ["active-in-env", "idle-in-env"] },
      "idle-loose-recent",
    ]);
  });

  it("keeps a manager child out of the project-level env group even when sharing an environmentId with a standalone", () => {
    const groups = buildProjectThreadGroups([
      createThread({ id: "manager", type: "manager", createdAt: 100 }),
      createThread({
        id: "managed-child",
        parentThreadId: "manager",
        environmentId: "env_shared",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 90,
      }),
      createThread({
        id: "standalone-on-same-env",
        environmentId: "env_shared",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 80,
      }),
    ]);

    expect(
      summarizeItems(groups.managerThreadGroups[0]?.managedItems ?? []),
    ).toEqual(["managed-child"]);
    expect(summarizeItems(groups.unmanagedItems)).toEqual([
      "standalone-on-same-env",
    ]);
  });

  it("sub-groups managed children that share a worktree environment under their manager", () => {
    const groups = buildProjectThreadGroups([
      createThread({ id: "manager", type: "manager", createdAt: 100 }),
      createThread({
        id: "managed-loose-a",
        parentThreadId: "manager",
        createdAt: 90,
        latestAttentionAt: 50,
      }),
      createThread({
        id: "managed-loose-b",
        parentThreadId: "manager",
        createdAt: 80,
        latestAttentionAt: 40,
      }),
      createThread({
        id: "managed-env-a",
        parentThreadId: "manager",
        environmentId: "env_managed_worktree",
        environmentWorkspaceDisplayKind: "managed-worktree",
        environmentBranchName: "bb/feat",
        createdAt: 70,
        latestAttentionAt: 700,
      }),
      createThread({
        id: "managed-env-b",
        parentThreadId: "manager",
        environmentId: "env_managed_worktree",
        environmentWorkspaceDisplayKind: "managed-worktree",
        environmentBranchName: "bb/feat",
        createdAt: 60,
        latestAttentionAt: 800,
      }),
    ]);

    expect(
      summarizeItems(groups.managerThreadGroups[0]?.managedItems ?? []),
    ).toEqual([
      {
        env: "env_managed_worktree",
        threads: ["managed-env-b", "managed-env-a"],
      },
      "managed-loose-a",
      "managed-loose-b",
    ]);
  });

  it("does not sub-group a solo managed child on a worktree environment", () => {
    const groups = buildProjectThreadGroups([
      createThread({ id: "manager", type: "manager", createdAt: 100 }),
      createThread({
        id: "managed-env-solo",
        parentThreadId: "manager",
        environmentId: "env_solo",
        environmentWorkspaceDisplayKind: "managed-worktree",
        createdAt: 90,
      }),
    ]);

    expect(
      summarizeItems(groups.managerThreadGroups[0]?.managedItems ?? []),
    ).toEqual(["managed-env-solo"]);
  });

  it("nests a manager whose parent is another manager under its parent's group", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "root-manager",
        type: "manager",
        createdAt: 100,
      }),
      createThread({
        id: "nested-manager",
        type: "manager",
        parentThreadId: "root-manager",
        createdAt: 200,
      }),
      createThread({
        id: "nested-child",
        parentThreadId: "nested-manager",
        createdAt: 300,
        latestAttentionAt: 500,
      }),
      createThread({
        id: "root-child",
        parentThreadId: "root-manager",
        createdAt: 250,
        latestAttentionAt: 400,
      }),
    ]);

    expect(groups.managerThreadGroups).toHaveLength(1);
    expect(groups.managerThreadGroups[0]?.managerThread.id).toBe(
      "root-manager",
    );
    expect(groups.managerThreadGroups[0]?.stats).toEqual({
      managedChildBusyCount: 0,
      managedChildCount: 2,
    });
    expect(
      summarizeItems(groups.managerThreadGroups[0]?.managedItems ?? []),
    ).toEqual([
      "root-child",
      {
        manager: "nested-manager",
        items: ["nested-child"],
      },
    ]);
    expect(summarizeItems(groups.unmanagedItems)).toEqual([]);
  });

  it("renders a manager whose parent is missing as a root manager", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "orphan-manager",
        type: "manager",
        parentThreadId: "deleted-manager",
        createdAt: 100,
      }),
      createThread({
        id: "orphan-child",
        parentThreadId: "orphan-manager",
        createdAt: 50,
      }),
    ]);

    expect(groups.managerThreadGroups).toHaveLength(1);
    expect(groups.managerThreadGroups[0]?.managerThread.id).toBe(
      "orphan-manager",
    );
    expect(looseThreadIds(groups.managerThreadGroups[0]?.managedItems ?? []))
      .toEqual(["orphan-child"]);
    expect(summarizeItems(groups.unmanagedItems)).toEqual([]);
  });

  it("recurses through 3+ levels of nested managers", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "m-root",
        type: "manager",
        createdAt: 100,
      }),
      createThread({
        id: "m-mid",
        type: "manager",
        parentThreadId: "m-root",
        createdAt: 200,
      }),
      createThread({
        id: "m-deep",
        type: "manager",
        parentThreadId: "m-mid",
        createdAt: 300,
      }),
      createThread({
        id: "leaf",
        parentThreadId: "m-deep",
        createdAt: 400,
      }),
    ]);

    expect(summarizeItems(groups.managerThreadGroups.map((group) => ({
      kind: "manager" as const,
      group,
    })))).toEqual([
      {
        manager: "m-root",
        items: [
          {
            manager: "m-mid",
            items: [
              {
                manager: "m-deep",
                items: ["leaf"],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("does not infinite-loop when a manager forms a cycle with another manager", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "m-a",
        type: "manager",
        parentThreadId: "m-b",
        createdAt: 100,
      }),
      createThread({
        id: "m-b",
        type: "manager",
        parentThreadId: "m-a",
        createdAt: 200,
      }),
    ]);

    // Both managers reference each other as parent, so each is an in-project
    // parent for the other. The grouping pass picks the first manager visited
    // as the root and breaks the cycle when it would recurse back into a
    // visited manager. Either ordering is fine, but the renderer must not
    // hang and each manager must appear exactly once.
    const managerIds = new Set<string>();
    function collectManagerIds(items: readonly ProjectThreadItem[]): void {
      for (const item of items) {
        if (item.kind === "manager") {
          managerIds.add(item.group.managerThread.id);
          collectManagerIds(item.group.managedItems);
        }
      }
    }
    for (const group of groups.managerThreadGroups) {
      managerIds.add(group.managerThread.id);
      collectManagerIds(group.managedItems);
    }
    expect(managerIds).toEqual(new Set(["m-a", "m-b"]));
  });

  it("counts both standard and nested-manager direct children in stats", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "root-manager",
        type: "manager",
        createdAt: 100,
      }),
      createThread({
        id: "nested-manager",
        type: "manager",
        parentThreadId: "root-manager",
        createdAt: 200,
      }),
      createThread({
        id: "standard-child",
        parentThreadId: "root-manager",
        createdAt: 300,
      }),
    ]);

    expect(groups.managerThreadGroups[0]?.stats).toEqual({
      managedChildBusyCount: 0,
      managedChildCount: 2,
    });
  });

  it("interleaves a nested manager between standard children by recency", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "root-manager",
        type: "manager",
        createdAt: 100,
      }),
      createThread({
        id: "older-child",
        parentThreadId: "root-manager",
        createdAt: 200,
        latestAttentionAt: 200,
      }),
      createThread({
        id: "nested-manager",
        type: "manager",
        parentThreadId: "root-manager",
        createdAt: 300,
        latestAttentionAt: 500,
      }),
      createThread({
        id: "newer-child",
        parentThreadId: "root-manager",
        createdAt: 400,
        latestAttentionAt: 700,
      }),
    ]);

    // newer-child (attention 700) > nested-manager (attention 500) > older-child (attention 200)
    expect(
      summarizeItems(groups.managerThreadGroups[0]?.managedItems ?? []),
    ).toEqual([
      "newer-child",
      {
        manager: "nested-manager",
        items: [],
      },
      "older-child",
    ]);
  });

  it("keeps managed children inside their manager group instead of globally interleaving them", () => {
    const groups = buildProjectThreadGroups([
      createThread({
        id: "manager-older",
        type: "manager",
        createdAt: 10,
      }),
      createThread({
        id: "manager-newer",
        type: "manager",
        createdAt: 20,
      }),
      createThread({
        id: "older-manager-recent-child",
        parentThreadId: "manager-older",
        createdAt: 30,
        updatedAt: 1_000,
      }),
      createThread({
        id: "newer-manager-older-child",
        parentThreadId: "manager-newer",
        createdAt: 40,
        updatedAt: 100,
      }),
      createThread({
        id: "unmanaged-standard",
        createdAt: 50,
        updatedAt: 900,
      }),
    ]);

    expect(
      groups.managerThreadGroups.map((group) => [
        group.managerThread.id,
        looseThreadIds(group.managedItems),
      ]),
    ).toEqual([
      ["manager-newer", ["newer-manager-older-child"]],
      ["manager-older", ["older-manager-recent-child"]],
    ]);
    expect(looseThreadIds(groups.unmanagedItems)).toEqual([
      "unmanaged-standard",
    ]);
  });
});
