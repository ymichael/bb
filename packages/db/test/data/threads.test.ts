import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  createThread,
  getThread,
  listThreads,
  updateThread,
  deleteThread,
  archiveThread,
  unarchiveThread,
  transitionThreadStatus,
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
  const { project } = createProject(db, noopNotifier, { name: "test-project", source: { type: "local_path", hostId: host.id, path: "/tmp/test" } });
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

    const fetched = getThread(db, thread.id);
    expect(fetched).toMatchObject({ id: thread.id });
  });

  it("lists threads by project", () => {
    const { db, project } = setup();
    createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    expect(listThreads(db, { projectId: project.id })).toHaveLength(2);
  });

  it("isolates threads by project", () => {
    const { db, host, project } = setup();
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
    });
    createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    createThread(db, noopNotifier, { projectId: otherProject.id, providerId: "codex" });

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

    expect(listThreads(db, { projectId: project.id, type: "manager" })).toHaveLength(2);
    expect(listThreads(db, { projectId: project.id, parentThreadId: parent.id })).toHaveLength(1);
    expect(listThreads(db, { projectId: project.id, archived: true })).toHaveLength(1);
    expect(listThreads(db, { projectId: project.id, archived: false })).toHaveLength(2);
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
    const t2 = transitionThreadStatus(db, noopNotifier, thread.id, "provisioning");
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

    const updated = transitionThreadStatus(db, noopNotifier, thread.id, "error");
    expect(updated.status).toBe("error");
  });

  it("rejects invalid transitions", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
    });

    // created → active is not allowed
    expect(() =>
      transitionThreadStatus(db, noopNotifier, thread.id, "active"),
    ).toThrow("Invalid thread status transition: created → active");

    // created → idle is allowed, so move to idle before checking an invalid edge
    transitionThreadStatus(db, noopNotifier, thread.id, "idle");

    // idle → created is not allowed
    expect(() =>
      transitionThreadStatus(db, noopNotifier, thread.id, "created"),
    ).toThrow("Invalid thread status transition: idle → created");
  });

  it("rejects transition for non-existent thread", () => {
    const { db } = setup();
    expect(() =>
      transitionThreadStatus(db, noopNotifier, "thr_nonexistent", "idle"),
    ).toThrow("Thread not found");
  });

  it("verifies all transitions in ALLOWED_TRANSITIONS map", () => {
    // Verify the transitions match the architecture doc
    expect(ALLOWED_TRANSITIONS.created).toEqual(["provisioning", "idle", "error"]);
    expect(ALLOWED_TRANSITIONS.provisioning).toEqual(["idle", "error"]);
    expect(ALLOWED_TRANSITIONS.idle).toEqual(["provisioning", "active", "error"]);
    expect(ALLOWED_TRANSITIONS.active).toEqual(["idle", "error"]);
    expect(ALLOWED_TRANSITIONS.error).toEqual(["active", "idle"]);
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
