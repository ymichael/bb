import { describe, expect, it, vi } from "vitest";
import { isRawThreadId } from "@bb/domain";
import { createConnection } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  createThread,
  countLiveThreadsInEnvironment,
  countNonDeletedAssignedChildThreads,
  getThread,
  getThreadExecutionOverride,
  hasActiveThreadAttention,
  setThreadExecutionOverride,
  hasPendingThreadShutdownInEnvironment,
  listHostThreadIds,
  listActiveVisiblePinnedThreadRoots,
  listThreadMentionRowsByIds,
  listThreadEnvironmentAssignmentsOnHost,
  listThreads,
  listThreadsWithPendingInteractionStateForProjects,
  listThreadsWithPendingInteractionState,
  updateThread,
  deleteThread,
  archiveThread,
  markThreadDeleted,
  markThreadAttentionRequested,
  pinThread,
  reorderPinnedThread,
  unpinThread,
  unarchiveThread,
  applyThreadLifecycleEvent,
  requireThreadLifecycleEventApplied,
} from "../../src/data/threads.js";
import { createPendingInteraction } from "../../src/data/pending-interactions.js";
import {
  createThreadSection,
  deleteThreadSection,
  listThreadSections,
  renameThreadSection,
} from "../../src/data/thread-sections.js";
import {
  createProject,
  markProjectDeleted,
} from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createEnvironment } from "../../src/data/environments.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

function mustCreateThreadSection(
  db: ReturnType<typeof createConnection>,
  name: string,
) {
  const result = createThreadSection(db, noopNotifier, { name });
  if (result.status !== "created") {
    throw new Error(`Expected section "${name}" to be created`);
  }
  return result.section;
}

describe("threads", () => {
  it("summarizes favicon attention for active sidebar threads", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      expect(hasActiveThreadAttention(db)).toBe(false);

      vi.setSystemTime(2_000);
      markThreadAttentionRequested(db, noopNotifier, {
        threadId: thread.id,
      });
      expect(hasActiveThreadAttention(db)).toBe(true);

      updateThread(db, noopNotifier, thread.id, { lastReadAt: 2_000 });
      expect(hasActiveThreadAttention(db)).toBe(false);

      createPendingInteraction(db, {
        payload: "{}",
        providerId: "codex",
        providerRequestId: "request-1",
        providerThreadId: "provider-thread-1",
        threadId: thread.id,
        turnId: "turn-1",
      });
      expect(hasActiveThreadAttention(db)).toBe(true);

      archiveThread(db, noopNotifier, thread.id);
      expect(hasActiveThreadAttention(db)).toBe(false);

      const sideChat = createThread(db, noopNotifier, {
        originKind: "fork",
        originPluginId: "side-chat",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: thread.id,
        visibility: "hidden",
      });
      vi.setSystemTime(3_000);
      markThreadAttentionRequested(db, noopNotifier, {
        threadId: sideChat.id,
      });
      expect(hasActiveThreadAttention(db)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates and retrieves a thread", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    expect(isRawThreadId(thread.id)).toBe(true);
    expect(thread.status).toBe("starting");
    expect(thread.projectId).toBe(project.id);
    expect(thread.deletedAt).toBeNull();
    expect(thread.lastReadAt).toBe(thread.latestAttentionAt);
    expect(thread.visibility).toBe("visible");

    const fetched = getThread(db, thread.id);
    expect(fetched?.visibility).toBe("visible");
    expect(fetched).toMatchObject({ id: thread.id });
  });

  it("resolves only exact non-deleted mention thread rows", () => {
    const { db, project } = setup();
    const visible = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Visible title",
      titleFallback: "Visible fallback",
    });
    const deleted = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Deleted title",
    });
    markThreadDeleted(db, noopNotifier, { threadId: deleted.id });

    expect(
      listThreadMentionRowsByIds(db, [
        visible.id,
        deleted.id,
        "thr_2222222222",
      ]),
    ).toEqual([
      {
        id: visible.id,
        projectId: project.id,
        title: "Visible title",
        titleFallback: "Visible fallback",
      },
    ]);
    expect(listThreadMentionRowsByIds(db, [])).toEqual([]);

    markProjectDeleted(db, noopNotifier, { projectId: project.id });
    expect(listThreadMentionRowsByIds(db, [visible.id])).toEqual([]);
  });

  it("supports an explicit visible-only list with a hidden opt-in", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const visible = createThread(db, noopNotifier, {
      parentThreadId: parent.id,
      projectId: project.id,
      providerId: "codex",
    });
    const hidden = createThread(db, noopNotifier, {
      parentThreadId: parent.id,
      projectId: project.id,
      providerId: "codex",
      visibility: "hidden",
    });

    pinThread(db, noopNotifier, { threadId: hidden.id });
    markThreadAttentionRequested(db, noopNotifier, { threadId: hidden.id });
    createPendingInteraction(db, {
      payload: "{}",
      providerId: "codex",
      providerRequestId: "hidden-request",
      providerThreadId: "hidden-provider-thread",
      threadId: hidden.id,
      turnId: "hidden-turn",
    });

    expect(getThread(db, hidden.id)?.visibility).toBe("hidden");
    expect(
      listThreads(db, { projectId: project.id, includeHidden: false }).map(
        (thread) => thread.id,
      ),
    ).not.toContain(hidden.id);
    expect(
      listThreads(db, { projectId: project.id }).map((thread) => thread.id),
    ).not.toContain(hidden.id);
    expect(
      listThreads(db, { projectId: project.id, includeHidden: true })
        .map((thread) => thread.id)
        .sort(),
    ).toEqual([hidden.id, visible.id, parent.id].sort());
    expect(
      listThreadsWithPendingInteractionStateForProjects(db, {
        projectIds: [project.id],
      }).map((thread) => thread.id),
    ).not.toContain(hidden.id);
    expect(
      listActiveVisiblePinnedThreadRoots(db).map((thread) => thread.id),
    ).not.toContain(hidden.id);
    expect(hasActiveThreadAttention(db)).toBe(false);
    expect(
      countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(2);
  });

  it("allows hidden threads to belong to sections", () => {
    const { db, project } = setup();
    const section = mustCreateThreadSection(db, "Work");
    const createdInSection = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
      visibility: "hidden",
    });
    expect(createdInSection.sectionId).toBe(section.id);

    const movedIntoSection = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      visibility: "hidden",
    });
    updateThread(db, noopNotifier, movedIntoSection.id, {
      sectionId: section.id,
    });
    expect(getThread(db, movedIntoSection.id)?.sectionId).toBe(section.id);
  });

  it("persists, reads, and clears the thread execution override", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
    });

    expect(getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: null,
      reasoningLevelOverride: null,
    });

    setThreadExecutionOverride(db, {
      threadId: thread.id,
      modelOverride: "claude-opus-4-8",
      reasoningLevelOverride: "high",
    });
    expect(getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: "claude-opus-4-8",
      reasoningLevelOverride: "high",
    });

    setThreadExecutionOverride(db, {
      threadId: thread.id,
      reasoningLevelOverride: "max",
    });
    expect(getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: "claude-opus-4-8",
      reasoningLevelOverride: "max",
    });

    setThreadExecutionOverride(db, {
      threadId: thread.id,
      modelOverride: null,
      reasoningLevelOverride: null,
    });
    expect(getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: null,
      reasoningLevelOverride: null,
    });
  });

  it("pins and unpins threads with durable pin order keys", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const spy: DbNotifier = {
        notifyThread: vi.fn(),
        notifyEnvironment: vi.fn(),
        notifyHost: vi.fn(),
        notifyProject: vi.fn(),
        notifySystem: vi.fn(),
      };
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      const pinned = pinThread(db, spy, {
        pinnedAt: 2_000,
        threadId: thread.id,
      });

      expect(pinned?.pinnedAt).toBe(2_000);
      expect(pinned?.pinSortKey).not.toBeNull();
      expect(spy.notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["pin-state-changed"],
        { projectId: project.id },
      );

      const pinnedAgain = pinThread(db, spy, { threadId: thread.id });
      expect(pinnedAgain?.pinSortKey).toBe(pinned?.pinSortKey);
      expect(spy.notifyThread).toHaveBeenCalledTimes(1);

      const unpinned = unpinThread(db, spy, { threadId: thread.id });
      expect(unpinned?.pinnedAt).toBeNull();
      expect(unpinned?.pinSortKey).toBeNull();
      expect(spy.notifyThread).toHaveBeenCalledTimes(2);

      unpinThread(db, spy, { threadId: thread.id });
      expect(spy.notifyThread).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders pinned threads before unpinned siblings", () => {
    vi.useFakeTimers();
    try {
      const { db, project } = setup();
      vi.setSystemTime(1_000);
      const first = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      vi.setSystemTime(2_000);
      const second = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      vi.setSystemTime(3_000);
      const third = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      vi.setSystemTime(4_000);
      const fourth = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      pinThread(db, noopNotifier, { threadId: first.id });
      pinThread(db, noopNotifier, { threadId: third.id });

      expect(
        listThreads(db, { projectId: project.id }).map((thread) => thread.id),
      ).toEqual([third.id, first.id, fourth.id, second.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reorders active visible pinned roots globally", () => {
    const { db, host, project } = setup();
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
    });
    const first = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const second = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const third = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const otherProjectThread = createThread(db, noopNotifier, {
      projectId: otherProject.id,
      providerId: "codex",
    });
    pinThread(db, noopNotifier, { threadId: first.id });
    pinThread(db, noopNotifier, { threadId: second.id });
    pinThread(db, noopNotifier, { threadId: third.id });
    pinThread(db, noopNotifier, { threadId: otherProjectThread.id });

    expect(listActiveVisiblePinnedThreadRoots(db).map((thread) => thread.id))
      .toEqual([otherProjectThread.id, third.id, second.id, first.id]);

    const result = reorderPinnedThread({
      db,
      notifier: noopNotifier,
      threadId: first.id,
      previousThreadId: null,
      nextThreadId: otherProjectThread.id,
    });

    expect(result.kind).toBe("reordered");
    expect(listActiveVisiblePinnedThreadRoots(db).map((thread) => thread.id))
      .toEqual([first.id, otherProjectThread.id, third.id, second.id]);
  });

  it("rejects pinned reorder for unpinned threads, stale neighbors, and hidden child pins", () => {
    const { db, project } = setup();
    const pinned = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const unpinned = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const pinnedParent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const pinnedChild = createThread(db, noopNotifier, {
      parentThreadId: pinnedParent.id,
      projectId: project.id,
      providerId: "codex",
    });
    pinThread(db, noopNotifier, { threadId: pinned.id });
    pinThread(db, noopNotifier, { threadId: pinnedParent.id });
    pinThread(db, noopNotifier, { threadId: pinnedChild.id });

    expect(
      reorderPinnedThread({
        db,
        notifier: noopNotifier,
        threadId: unpinned.id,
        previousThreadId: null,
        nextThreadId: pinned.id,
      }).kind,
    ).toBe("not_pinned");
    expect(
      reorderPinnedThread({
        db,
        notifier: noopNotifier,
        threadId: pinned.id,
        previousThreadId: unpinned.id,
        nextThreadId: null,
      }).kind,
    ).toBe("stale_neighbor");
    expect(
      reorderPinnedThread({
        db,
        notifier: noopNotifier,
        threadId: pinned.id,
        previousThreadId: pinnedChild.id,
        nextThreadId: null,
      }).kind,
    ).toBe("stale_neighbor");
    expect(
      reorderPinnedThread({
        db,
        notifier: noopNotifier,
        threadId: pinnedChild.id,
        previousThreadId: null,
        nextThreadId: pinned.id,
      }).kind,
    ).toBe("stale_neighbor");
  });

  it("lists threads by project", () => {
    const { db, project } = setup();
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    expect(listThreads(db, { projectId: project.id })).toHaveLength(2);
  });

  it("filters archived threads by section id", () => {
    const { db, project } = setup();
    const workSection = mustCreateThreadSection(db, "work");
    const playSection = mustCreateThreadSection(db, "play");
    const archivedInWork = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: workSection.id,
    });
    const otherArchivedInWork = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: workSection.id,
    });
    const archivedInPlay = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: playSection.id,
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: workSection.id,
    });
    archiveThread(db, noopNotifier, archivedInWork.id);
    archiveThread(db, noopNotifier, otherArchivedInWork.id);
    archiveThread(db, noopNotifier, archivedInPlay.id);

    const workArchived = listThreads(db, {
      projectId: project.id,
      archived: true,
      sectionId: workSection.id,
    });
    expect(workArchived.map((thread) => thread.id).sort()).toEqual(
      [archivedInWork.id, otherArchivedInWork.id].sort(),
    );

    expect(
      listThreads(db, {
        projectId: project.id,
        archived: true,
        sectionId: playSection.id,
      }),
    ).toHaveLength(1);
  });

  it("filters archived threads to loose (unsectioned) only", () => {
    const { db, project } = setup();
    const section = mustCreateThreadSection(db, "work");
    const looseArchived = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const sectioned = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    archiveThread(db, noopNotifier, looseArchived.id);
    archiveThread(db, noopNotifier, sectioned.id);

    const unsectionedArchived = listThreads(db, {
      projectId: project.id,
      archived: true,
      unsectioned: true,
    });
    expect(unsectionedArchived.map((thread) => thread.id)).toEqual([
      looseArchived.id,
    ]);
  });

  it("isolates threads by project", () => {
    const { db, host, project } = setup();
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    createThread(db, noopNotifier, {
      projectId: otherProject.id,
      providerId: "codex",
    });

    expect(listThreads(db, { projectId: project.id })).toHaveLength(1);
    expect(listThreads(db, { projectId: otherProject.id })).toHaveLength(1);
  });

  it("filters threads by parent thread and archived state", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const child = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    archiveThread(db, noopNotifier, child.id);

    expect(
      listThreads(db, { projectId: project.id, parentThreadId: parent.id }),
    ).toHaveLength(1);
    expect(
      listThreads(db, { projectId: project.id, archived: true }),
    ).toHaveLength(1);
    expect(
      listThreads(db, { projectId: project.id, archived: false }),
    ).toHaveLength(2);
  });

  it("filters threads by parent presence", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const child = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const childThreads = listThreads(db, {
      projectId: project.id,
      hasParent: true,
    });
    expect(childThreads).toHaveLength(1);
    expect(childThreads[0]?.id).toBe(child.id);

    const rootThreads = listThreads(db, {
      projectId: project.id,
      hasParent: false,
    });
    expect(rootThreads).toHaveLength(2);
    expect(rootThreads.map((thread) => thread.id)).toContain(parent.id);
  });

  it("paginates archived threads ordered by archive recency", async () => {
    const { db, project } = setup();
    const created: { id: string }[] = [];
    for (let index = 0; index < 5; index += 1) {
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      created.push(thread);
    }
    for (const thread of created) {
      archiveThread(db, noopNotifier, thread.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const archivedFirstPage = listThreads(db, {
      projectId: project.id,
      archived: true,
      limit: 3,
    });
    expect(archivedFirstPage.map((thread) => thread.id)).toEqual([
      created[4]?.id,
      created[3]?.id,
      created[2]?.id,
    ]);

    const archivedSecondPage = listThreads(db, {
      projectId: project.id,
      archived: true,
      limit: 3,
      offset: 3,
    });
    expect(archivedSecondPage.map((thread) => thread.id)).toEqual([
      created[1]?.id,
      created[0]?.id,
    ]);
  });

  it("counts active assigned child threads", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });

    expect(
      countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(1);
  });

  it("counts archived assigned child threads", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const archivedChild = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });

    archiveThread(db, noopNotifier, archivedChild.id);

    expect(
      countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(1);
  });

  it("excludes deleted assigned child threads", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const deletedChild = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });

    markThreadDeleted(db, noopNotifier, { threadId: deletedChild.id });

    expect(
      countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(0);
  });

  it("excludes assigned child threads under a different parent", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const otherParent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: otherParent.id,
    });

    expect(
      countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(0);
  });

  it("lists thread environment workspace display kind without per-thread lookups", () => {
    const { db, host, project } = setup();
    const directEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
    });
    const worktreeEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      name: "Review workspace",
      workspaceProvisionType: "managed-worktree",
      isWorktree: true,
      branchName: "bb/worktree",
    });
    const personalEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "personal",
      isGitRepo: false,
      isWorktree: false,
    });
    const directThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: directEnvironment.id,
      providerId: "codex",
    });
    const worktreeThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: worktreeEnvironment.id,
      providerId: "codex",
    });
    const personalThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: personalEnvironment.id,
      providerId: "codex",
    });

    const displayKindsByThreadId = new Map(
      listThreadsWithPendingInteractionState(db, { projectId: project.id }).map(
        (thread) => [thread.id, thread.environmentWorkspaceDisplayKind],
      ),
    );

    expect(displayKindsByThreadId.get(directThread.id)).toBe("other");
    expect(displayKindsByThreadId.get(worktreeThread.id)).toBe(
      "managed-worktree",
    );
    expect(displayKindsByThreadId.get(personalThread.id)).toBe("other");

    const environmentIdentityByThreadId = new Map(
      listThreadsWithPendingInteractionState(db, { projectId: project.id }).map(
        (thread) => [
          thread.id,
          {
            environmentBranchName: thread.environmentBranchName,
            environmentHostId: thread.environmentHostId,
            environmentName: thread.environmentName,
          },
        ],
      ),
    );

    expect(environmentIdentityByThreadId.get(directThread.id)).toEqual({
      environmentBranchName: "main",
      environmentHostId: host.id,
      environmentName: null,
    });
    expect(environmentIdentityByThreadId.get(worktreeThread.id)).toEqual({
      environmentBranchName: "bb/worktree",
      environmentHostId: host.id,
      environmentName: "Review workspace",
    });
  });

  it("updates thread title", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const updated = updateThread(db, noopNotifier, thread.id, {
      title: "New title",
    });
    expect(updated?.title).toBe("New title");
  });

  it("updates thread section id", () => {
    const { db, project } = setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const section = mustCreateThreadSection(db, "Work/Q3");

    const updated = updateThread(db, spy, thread.id, {
      sectionId: section.id,
    });

    expect(updated?.sectionId).toBe(section.id);
    expect(spy.notifyThread).toHaveBeenCalledWith(
      thread.id,
      ["title-changed"],
      { projectId: project.id },
    );
  });

  it("creates explicit thread sections with literal slash names", () => {
    const { db } = setup();

    const result = createThreadSection(db, noopNotifier, {
      name: " Work / Q3 ",
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.section.name).toBe("Work / Q3");
    expect(listThreadSections(db).map((entry) => entry.name)).toEqual([
      "Work / Q3",
    ]);
  });

  it("returns duplicate when creating a section with an existing name", () => {
    const { db } = setup();
    const existing = mustCreateThreadSection(db, "Work");

    const result = createThreadSection(db, noopNotifier, {
      name: "Work",
    });

    expect(result).toEqual({ status: "duplicate", section: existing });
  });

  it("renames a section by id without changing member thread ids", () => {
    const { db, project } = setup();
    const section = mustCreateThreadSection(db, "Work");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });

    const result = renameThreadSection(db, noopNotifier, {
      id: section.id,
      name: "Archive",
    });

    expect(result).toEqual({
      status: "renamed",
      result: { id: section.id, name: "Archive", updatedThreadCount: 0 },
    });
    expect(getThread(db, thread.id)?.sectionId).toBe(section.id);
    expect(listThreadSections(db).map((entry) => entry.name)).toEqual([
      "Archive",
    ]);
  });

  it("returns duplicate when renaming a section to an existing name", () => {
    const { db } = setup();
    const work = mustCreateThreadSection(db, "Work");
    const archive = mustCreateThreadSection(db, "Archive");

    const result = renameThreadSection(db, noopNotifier, {
      id: work.id,
      name: "Archive",
    });

    expect(result).toEqual({ status: "duplicate", section: archive });
    expect(listThreadSections(db).map((entry) => entry.name)).toEqual([
      "Archive",
      "Work",
    ]);
  });

  it("returns not_found when renaming a missing section id", () => {
    const { db } = setup();
    const result = renameThreadSection(db, noopNotifier, {
      id: "sec_missing",
      name: "Archive",
    });

    expect(result).toEqual({ status: "not_found" });
  });

  it("removes a section and clears direct member thread section ids", () => {
    const { db, project } = setup();
    const section = mustCreateThreadSection(db, "Work");
    const siblingSection = mustCreateThreadSection(db, "Work / Q3");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    const siblingThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: siblingSection.id,
    });

    const result = deleteThreadSection(db, noopNotifier, { id: section.id });

    expect(result).toEqual({
      id: section.id,
      name: "Work",
      updatedThreadCount: 1,
    });
    expect(getThread(db, thread.id)?.sectionId).toBeNull();
    expect(getThread(db, siblingThread.id)?.sectionId).toBe(siblingSection.id);
    expect(listThreadSections(db).map((entry) => entry.name)).toEqual([
      "Work / Q3",
    ]);
  });

  it("includes hidden members in section lists and deletion counts", () => {
    const { db, project } = setup();
    const section = mustCreateThreadSection(db, "Work");
    const visible = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    const hidden = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
      visibility: "hidden",
    });

    expect(
      listThreads(db, {
        projectId: project.id,
        sectionId: section.id,
        includeHidden: true,
      })
        .map((thread) => thread.id)
        .sort(),
    ).toEqual([visible.id, hidden.id].sort());

    expect(deleteThreadSection(db, noopNotifier, { id: section.id })).toEqual({
      id: section.id,
      name: "Work",
      updatedThreadCount: 2,
    });
    expect(getThread(db, visible.id)?.sectionId).toBeNull();
    expect(getThread(db, hidden.id)?.sectionId).toBeNull();
  });

  it("removes a section for threads across every project", () => {
    const { db, host, project } = setup();
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
    });
    const section = mustCreateThreadSection(db, "Work");
    const projectThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    const otherProjectThread = createThread(db, noopNotifier, {
      projectId: otherProject.id,
      providerId: "codex",
      sectionId: section.id,
    });

    const result = deleteThreadSection(db, noopNotifier, { id: section.id });

    expect(result).toEqual({
      id: section.id,
      name: "Work",
      updatedThreadCount: 2,
    });
    expect(getThread(db, projectThread.id)?.sectionId).toBeNull();
    expect(getThread(db, otherProjectThread.id)?.sectionId).toBeNull();
    expect(listThreadSections(db)).toEqual([]);
  });

  it("notifies when a thread parent changes", () => {
    const { db, project } = setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const parentThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const childThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    updateThread(db, spy, childThread.id, {
      parentThreadId: parentThread.id,
    });

    expect(spy.notifyThread).toHaveBeenCalledWith(
      childThread.id,
      ["parent-changed"],
      { projectId: project.id },
    );
  });

  it("notifies when a thread environment changes", () => {
    const { db, host, project } = setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      path: "/tmp/test-workspace",
      status: "ready",
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    updateThread(db, spy, thread.id, {
      environmentId: environment.id,
    });

    expect(spy.notifyThread).toHaveBeenCalledWith(
      thread.id,
      ["environment-changed"],
      { projectId: project.id },
    );
  });

  it("preserves read state when renaming a read thread", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      updateThread(db, noopNotifier, thread.id, {
        lastReadAt: thread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const updated = updateThread(db, noopNotifier, thread.id, {
        title: "New title",
      });

      expect(updated?.title).toBe("New title");
      expect(updated?.updatedAt).toBe(2_000);
      expect(updated?.lastReadAt).toBe(1_000);
      expect(updated?.latestAttentionAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unread threads unread when renaming", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      updateThread(db, noopNotifier, thread.id, {
        lastReadAt: null,
      });

      vi.setSystemTime(2_000);
      const updated = updateThread(db, noopNotifier, thread.id, {
        title: "New title",
      });

      expect(updated?.updatedAt).toBe(2_000);
      expect(updated?.lastReadAt).toBeNull();
      expect(updated?.latestAttentionAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a thread as needing attention without changing read position", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const spy: DbNotifier = {
        notifyThread: vi.fn(),
        notifyEnvironment: vi.fn(),
        notifyHost: vi.fn(),
        notifyProject: vi.fn(),
        notifySystem: vi.fn(),
      };
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      updateThread(db, noopNotifier, thread.id, {
        lastReadAt: thread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const updated = markThreadAttentionRequested(db, spy, {
        threadId: thread.id,
      });

      expect(updated?.updatedAt).toBe(2_000);
      expect(updated?.lastReadAt).toBe(1_000);
      expect(updated?.latestAttentionAt).toBe(2_000);
      expect(spy.notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["read-state-changed"],
        { projectId: project.id },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a thread", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    expect(deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(getThread(db, thread.id)).toBeNull();
    expect(deleteThread(db, noopNotifier, thread.id)).toBe(false);
  });

  it("marks a thread deleted and hides it from public list queries", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const deleted = markThreadDeleted(db, noopNotifier, {
      threadId: thread.id,
    });

    expect(deleted?.deletedAt).toBeTypeOf("number");
    expect(getThread(db, thread.id)?.deletedAt).toBeTypeOf("number");
    expect(listThreads(db, { projectId: project.id })).toHaveLength(0);
  });

  it("archives a thread", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const archived = archiveThread(db, noopNotifier, thread.id);
    expect(archived?.archivedAt).toBeTypeOf("number");
  });

  it("unarchives a thread", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    archiveThread(db, noopNotifier, thread.id);

    const unarchived = unarchiveThread(db, noopNotifier, thread.id);
    expect(unarchived?.archivedAt).toBeNull();
    expect(unarchived?.latestAttentionAt).toBe(thread.latestAttentionAt);
  });

  it("moves an active thread to stopping on stop.requested and settles to idle on stop.settled", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    const stopping = requireThreadLifecycleEventApplied(
      applyThreadLifecycleEvent(db, {
        event: { type: "stop.requested" },
        threadId: thread.id,
      }),
    );
    expect(stopping.status).toBe("stopping");
    expect(getThread(db, thread.id)?.status).toBe("stopping");

    const settled = requireThreadLifecycleEventApplied(
      applyThreadLifecycleEvent(db, {
        event: { type: "stop.settled" },
        threadId: thread.id,
      }),
    );
    expect(settled.status).toBe("idle");
    expect(getThread(db, thread.id)?.status).toBe("idle");
  });

  it("counts only non-archived, non-deleted threads as live", () => {
    const { db, project, host } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-live-count",
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const liveThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      status: "idle",
    });
    const archivedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      status: "idle",
    });
    const deletedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      status: "idle",
    });

    archiveThread(db, noopNotifier, archivedThread.id);
    markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    expect(
      countLiveThreadsInEnvironment(db, { environmentId: environment.id }),
    ).toBe(1);
    expect(
      countLiveThreadsInEnvironment(db, {
        environmentId: environment.id,
        excludeThreadId: liveThread.id,
      }),
    ).toBe(0);
  });

  it("lists canonical thread environments for a host", () => {
    const { db, project, host } = setup();
    const otherHost = upsertHost(db, noopNotifier, {
      name: "other-host",
      type: "persistent",
    });
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-host-match",
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const otherEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: otherHost.id,
      path: "/tmp/thread-host-other",
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const matchingThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: otherEnvironment.id,
      providerId: "codex",
    });

    expect(
      listThreadEnvironmentAssignmentsOnHost(db, {
        hostId: host.id,
        threadIds: [matchingThread.id, otherThread.id],
      }),
    ).toEqual([
      {
        threadId: matchingThread.id,
        environmentId: environment.id,
      },
    ]);
  });

  it("lists host thread ids and detects pending shutdowns by environment", () => {
    const { db, project, host } = setup();
    const otherHost = upsertHost(db, noopNotifier, {
      name: "other-host",
      type: "persistent",
    });
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-host-match",
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const otherEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: otherHost.id,
      path: "/tmp/thread-host-other",
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const activeThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const stoppingThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: otherEnvironment.id,
      providerId: "codex",
    });
    requireThreadLifecycleEventApplied(
      applyThreadLifecycleEvent(db, {
        event: { type: "stop.requested" },
        threadId: stoppingThread.id,
      }),
    );
    expect(getThread(db, stoppingThread.id)?.status).toBe("stopping");

    expect(listHostThreadIds(db, { hostId: host.id })).toEqual([
      activeThread.id,
      stoppingThread.id,
    ]);
    expect(
      hasPendingThreadShutdownInEnvironment(db, {
        environmentId: environment.id,
      }),
    ).toBe(true);
    expect(
      hasPendingThreadShutdownInEnvironment(db, {
        environmentId: otherEnvironment.id,
      }),
    ).toBe(false);
  });

  it("lists every host thread id including archived, deleted, and destroyed-environment threads", () => {
    const { db, project, host } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-storage-targets",
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const destroyedEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/destroyed-thread-storage-targets",
      workspaceProvisionType: "managed-worktree",
      status: "destroyed",
    });
    const activeThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const destroyedEnvironmentThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: destroyedEnvironment.id,
      providerId: "codex",
    });
    const archivedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const deletedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    archiveThread(db, noopNotifier, archivedThread.id);
    markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    expect([...listHostThreadIds(db, { hostId: host.id })].sort()).toEqual(
      [
        activeThread.id,
        archivedThread.id,
        deletedThread.id,
        destroyedEnvironmentThread.id,
      ].sort(),
    );
  });
});

describe("thread lifecycle transitions and read state", () => {
  it("only attention-worthy status transitions make a read thread unread", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const activeThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "active",
      });
      updateThread(db, noopNotifier, activeThread.id, {
        lastReadAt: activeThread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const idleThread = requireThreadLifecycleEventApplied(
        applyThreadLifecycleEvent(db, {
          event: { type: "run.succeeded" },
          threadId: activeThread.id,
        }),
      );
      expect(idleThread.status).toBe("idle");
      expect(idleThread.updatedAt).toBe(2_000);
      expect(idleThread.latestAttentionAt).toBe(2_000);
      expect(idleThread.lastReadAt).toBe(1_000);

      updateThread(db, noopNotifier, activeThread.id, {
        lastReadAt: idleThread.latestAttentionAt,
      });
      vi.setSystemTime(3_000);
      const activeAgainThread = requireThreadLifecycleEventApplied(
        applyThreadLifecycleEvent(db, {
          event: { type: "run.started" },
          threadId: activeThread.id,
        }),
      );
      expect(activeAgainThread.status).toBe("active");
      expect(activeAgainThread.updatedAt).toBe(3_000);
      expect(activeAgainThread.latestAttentionAt).toBe(2_000);
      expect(activeAgainThread.lastReadAt).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mark child thread completion as unread by itself", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const parentThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const childThread = createThread(db, noopNotifier, {
        parentThreadId: parentThread.id,
        projectId: project.id,
        providerId: "codex",
        status: "active",
      });
      updateThread(db, noopNotifier, childThread.id, {
        lastReadAt: childThread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const idleThread = requireThreadLifecycleEventApplied(
        applyThreadLifecycleEvent(db, {
          event: { type: "run.succeeded" },
          threadId: childThread.id,
        }),
      );

      expect(idleThread.status).toBe("idle");
      expect(idleThread.updatedAt).toBe(2_000);
      expect(idleThread.latestAttentionAt).toBe(1_000);
      expect(idleThread.lastReadAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves read state for non-attention error transitions", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const stoppingThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "stopping",
      });
      updateThread(db, noopNotifier, stoppingThread.id, {
        lastReadAt: stoppingThread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const erroredThread = requireThreadLifecycleEventApplied(
        applyThreadLifecycleEvent(db, {
          event: { type: "run.failed" },
          threadId: stoppingThread.id,
        }),
      );
      expect(erroredThread.status).toBe("error");
      expect(erroredThread.updatedAt).toBe(2_000);
      expect(erroredThread.latestAttentionAt).toBe(1_000);
      expect(erroredThread.lastReadAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("thread originKind", () => {
  it("defaults to null for threads created without an origin", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    expect(thread.originKind).toBeNull();
    expect(getThread(db, thread.id)?.originKind).toBeNull();
  });

  it("persists and filters by originKind", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const fork = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
      originKind: "fork",
    });
    expect(getThread(db, fork.id)).toMatchObject({
      originKind: "fork",
    });
    const forks = listThreads(db, {
      projectId: project.id,
      originKind: "fork",
    });
    expect(forks.map((thread) => thread.id)).toEqual([fork.id]);

    const all = listThreads(db, { projectId: project.id });
    expect(all.map((thread) => thread.id).sort()).toEqual(
      [parent.id, fork.id].sort(),
    );
  });

  it("filters listings by originPluginId", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const ownFork = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
      originKind: "fork",
      originPluginId: "side-chat",
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
      originKind: "fork",
      originPluginId: "some-other-plugin",
    });

    const own = listThreads(db, {
      projectId: project.id,
      originKind: "fork",
      originPluginId: "side-chat",
    });

    expect(own.map((thread) => thread.id)).toEqual([ownFork.id]);
  });
});
