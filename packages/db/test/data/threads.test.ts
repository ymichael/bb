import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  createThread,
  countLiveThreadsInEnvironment,
  countNonDeletedAssignedChildThreads,
  getThread,
  hasPendingThreadShutdownInEnvironment,
  listHostThreadIds,
  listThreadEnvironmentAssignmentsOnHost,
  listThreads,
  listThreadsWithPendingInteractionState,
  updateThread,
  deleteThread,
  archiveThread,
  clearThreadStopRequested,
  markThreadDeleted,
  markThreadStopRequested,
  unarchiveThread,
  transitionThreadStatus,
  InvalidThreadStatusTransitionError,
  transitionThreadsToError,
  ALLOWED_TRANSITIONS,
} from "../../src/data/threads.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createEnvironment } from "../../src/data/environments.js";
import type { ThreadStatus } from "@bb/domain";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
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

describe("threads", () => {
  it("creates and retrieves a thread", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    expect(thread.id).toMatch(/^thr_/);
    expect(thread.status).toBe("created");
    expect(thread.projectId).toBe(project.id);
    expect(thread.stopRequestedAt).toBeNull();
    expect(thread.deletedAt).toBeNull();
    expect(thread.lastReadAt).toBe(thread.latestAttentionAt);

    const fetched = getThread(db, thread.id);
    expect(fetched).toMatchObject({ id: thread.id });
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

  it("filters threads by type, parent thread, and archived state", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      type: "manager",
    });
    const child = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      type: "manager",
    });
    archiveThread(db, noopNotifier, child.id);

    expect(
      listThreads(db, { projectId: project.id, type: "manager" }),
    ).toHaveLength(2);
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

  it("counts active assigned child threads", () => {
    const { db, project } = setup();
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      type: "manager",
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
      type: "manager",
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
      type: "manager",
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
      type: "manager",
    });
    const otherParent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      type: "manager",
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
    const sandboxHost = upsertHost(db, noopNotifier, {
      name: "sandbox-host",
      type: "ephemeral",
    });
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
      workspaceProvisionType: "managed-worktree",
      isWorktree: true,
      branchName: "bb/worktree",
    });
    const sandboxEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: sandboxHost.id,
      workspaceProvisionType: "managed-worktree",
      isWorktree: true,
      branchName: "bb/sandbox",
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
    const sandboxThread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: sandboxEnvironment.id,
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
    expect(displayKindsByThreadId.get(sandboxThread.id)).toBe("sandbox");

    const environmentIdentityByThreadId = new Map(
      listThreadsWithPendingInteractionState(db, { projectId: project.id }).map(
        (thread) => [
          thread.id,
          {
            environmentBranchName: thread.environmentBranchName,
            environmentHostId: thread.environmentHostId,
          },
        ],
      ),
    );

    expect(environmentIdentityByThreadId.get(directThread.id)).toEqual({
      environmentBranchName: "main",
      environmentHostId: host.id,
    });
    expect(environmentIdentityByThreadId.get(worktreeThread.id)).toEqual({
      environmentBranchName: "bb/worktree",
      environmentHostId: host.id,
    });
    expect(environmentIdentityByThreadId.get(sandboxThread.id)).toEqual({
      environmentBranchName: "bb/sandbox",
      environmentHostId: sandboxHost.id,
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

  it("tracks stop requests independently from runtime status", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    const stopRequested = markThreadStopRequested(db, noopNotifier, {
      threadId: thread.id,
      requestedAt: 123,
    });
    expect(stopRequested?.stopRequestedAt).toBe(123);
    expect(getThread(db, thread.id)?.status).toBe("active");

    const cleared = clearThreadStopRequested(db, noopNotifier, thread.id);
    expect(cleared?.stopRequestedAt).toBeNull();
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
    createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: otherEnvironment.id,
      providerId: "codex",
    });

    expect(
      listThreadEnvironmentAssignmentsOnHost(db, {
        hostId: host.id,
        threadIds: [matchingThread.id],
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
    markThreadStopRequested(db, noopNotifier, {
      threadId: stoppingThread.id,
      requestedAt: 123,
    });

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
});

describe("transitionThreadStatus", () => {
  it("allows valid transitions", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
    });

    // created → idle
    const t1 = transitionThreadStatus(db, noopNotifier, thread.id, "idle");
    expect(t1.status).toBe("idle");

    // idle → provisioning
    const t2 = transitionThreadStatus(
      db,
      noopNotifier,
      thread.id,
      "provisioning",
    );
    expect(t2.status).toBe("provisioning");

    // provisioning → idle
    const t3 = transitionThreadStatus(db, noopNotifier, thread.id, "idle");
    expect(t3.status).toBe("idle");

    // idle → active
    const t4 = transitionThreadStatus(db, noopNotifier, thread.id, "active");
    expect(t4.status).toBe("active");

    // active → idle
    const t5 = transitionThreadStatus(db, noopNotifier, thread.id, "idle");
    expect(t5.status).toBe("idle");

    // idle → error
    const t6 = transitionThreadStatus(db, noopNotifier, thread.id, "error");
    expect(t6.status).toBe("error");

    // error → active
    const t7 = transitionThreadStatus(db, noopNotifier, thread.id, "active");
    expect(t7.status).toBe("active");
  });

  it("allows created to error when provisioning fails before activation", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
    });

    const updated = transitionThreadStatus(
      db,
      noopNotifier,
      thread.id,
      "error",
    );
    expect(updated.status).toBe("error");
  });

  it("rejects invalid transitions", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
    });

    // created → provisioning is allowed, so move through an invalid edge after that
    transitionThreadStatus(db, noopNotifier, thread.id, "provisioning");

    // provisioning → created is not allowed
    expect(() =>
      transitionThreadStatus(db, noopNotifier, thread.id, "created"),
    ).toThrow("Invalid thread status transition: provisioning → created");
    expect(() =>
      transitionThreadStatus(db, noopNotifier, thread.id, "created"),
    ).toThrow(InvalidThreadStatusTransitionError);

    // provisioning → active is allowed, so move to active before checking an invalid edge
    transitionThreadStatus(db, noopNotifier, thread.id, "active");

    // active → created is not allowed
    expect(() =>
      transitionThreadStatus(db, noopNotifier, thread.id, "created"),
    ).toThrow("Invalid thread status transition: active → created");
  });

  it("rejects transition for non-existent thread", () => {
    const { db } = setup();
    expect(() =>
      transitionThreadStatus(db, noopNotifier, "thr_nonexistent", "idle"),
    ).toThrow("Thread not found");
  });

  it("verifies all transitions in ALLOWED_TRANSITIONS map", () => {
    // Verify the transitions match the current state machine
    expect(ALLOWED_TRANSITIONS.created).toEqual([
      "provisioning",
      "active",
      "idle",
      "error",
    ]);
    expect(ALLOWED_TRANSITIONS.provisioning).toEqual([
      "active",
      "idle",
      "error",
    ]);
    expect(ALLOWED_TRANSITIONS.idle).toEqual([
      "provisioning",
      "active",
      "error",
    ]);
    expect(ALLOWED_TRANSITIONS.active).toEqual(["idle", "error"]);
    expect(ALLOWED_TRANSITIONS.error).toEqual(["active", "idle"]);
  });

  it("allows created and provisioning to move active when startup work begins", () => {
    const { db, project } = setup();
    const createdThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
    });
    const provisioningThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "provisioning",
    });

    expect(
      transitionThreadStatus(db, noopNotifier, createdThread.id, "active")
        .status,
    ).toBe("active");
    expect(
      transitionThreadStatus(db, noopNotifier, provisioningThread.id, "active")
        .status,
    ).toBe("active");
  });

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
      const idleThread = transitionThreadStatus(
        db,
        noopNotifier,
        activeThread.id,
        "idle",
      );
      expect(idleThread.updatedAt).toBe(2_000);
      expect(idleThread.latestAttentionAt).toBe(2_000);
      expect(idleThread.lastReadAt).toBe(1_000);

      updateThread(db, noopNotifier, activeThread.id, {
        lastReadAt: idleThread.latestAttentionAt,
      });
      vi.setSystemTime(3_000);
      const activeAgainThread = transitionThreadStatus(
        db,
        noopNotifier,
        activeThread.id,
        "active",
      );
      expect(activeAgainThread.updatedAt).toBe(3_000);
      expect(activeAgainThread.latestAttentionAt).toBe(2_000);
      expect(activeAgainThread.lastReadAt).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves read state for non-attention error transitions", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = setup();
      const createdThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "created",
      });
      updateThread(db, noopNotifier, createdThread.id, {
        lastReadAt: createdThread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const erroredThread = transitionThreadStatus(
        db,
        noopNotifier,
        createdThread.id,
        "error",
      );
      expect(erroredThread.updatedAt).toBe(2_000);
      expect(erroredThread.latestAttentionAt).toBe(1_000);
      expect(erroredThread.lastReadAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies on status change", () => {
    const { db, project } = setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyCommand: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
    });

    transitionThreadStatus(db, spy, thread.id, "idle");
    expect(spy.notifyThread).toHaveBeenCalledWith(thread.id, [
      "status-changed",
    ]);
  });
});

describe("transitionThreadsToError", () => {
  it("errors only eligible threads and skips deleted, stop-pending, and already errored threads", () => {
    const { db, project } = setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyCommand: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    const createdThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
    });
    const activeThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    const erroredThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "error",
    });
    const deletedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const stopPendingThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });
    markThreadStopRequested(db, noopNotifier, {
      threadId: stopPendingThread.id,
      requestedAt: 123,
    });

    const transitionedIds = transitionThreadsToError(db, spy, {
      now: 456,
      threadIds: [
        createdThread.id,
        activeThread.id,
        erroredThread.id,
        deletedThread.id,
        stopPendingThread.id,
      ],
    });

    expect(transitionedIds).toEqual([createdThread.id, activeThread.id]);
    expect(getThread(db, createdThread.id)?.status).toBe("error");
    expect(getThread(db, activeThread.id)?.status).toBe("error");
    expect(getThread(db, erroredThread.id)?.status).toBe("error");
    expect(getThread(db, deletedThread.id)?.status).toBe("idle");
    expect(getThread(db, stopPendingThread.id)?.status).toBe("active");
    expect(spy.notifyThread).toHaveBeenCalledTimes(2);
    expect(spy.notifyThread).toHaveBeenCalledWith(createdThread.id, [
      "status-changed",
    ]);
    expect(spy.notifyThread).toHaveBeenCalledWith(activeThread.id, [
      "status-changed",
    ]);
  });
});
