import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  listRunningThreads,
  markThreadDeleted,
} from "../../src/data/threads.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const hostA = upsertHost(db, noopNotifier, {
    name: "host-a",
    type: "persistent",
  });
  const hostB = upsertHost(db, noopNotifier, {
    name: "host-b",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "project-a",
    source: { type: "local_path", hostId: hostA.id, path: "/tmp/a" },
  });
  const environmentA = createEnvironment(db, noopNotifier, {
    hostId: hostA.id,
    projectId: project.id,
    path: "/tmp/a",
    workspaceProvisionType: "unmanaged",
  });
  const environmentB = createEnvironment(db, noopNotifier, {
    hostId: hostB.id,
    projectId: project.id,
    path: "/tmp/b",
    workspaceProvisionType: "unmanaged",
  });
  return { db, environmentA, environmentB, hostA, hostB, project };
}

describe("listRunningThreads", () => {
  it("returns only the statuses that occupy capacity", () => {
    const { db, environmentA, project } = setup();
    const ids = new Map<string, string>();
    for (const status of [
      "pending",
      "idle",
      "starting",
      "active",
      "stopping",
      "error",
    ] as const) {
      ids.set(
        status,
        createThread(db, noopNotifier, {
          environmentId: environmentA.id,
          projectId: project.id,
          providerId: "codex",
          status,
        }).id,
      );
    }

    // `idle` is the one that is easy to get wrong: the thread has a live
    // session but is consuming nothing, so it holds no slot.
    expect(listRunningThreads(db).map((row) => row.id).sort()).toEqual(
      [ids.get("starting")!, ids.get("active")!].sort(),
    );
  });

  it("excludes archived and deleted threads but keeps hidden ones", () => {
    const { db, environmentA, project } = setup();
    const make = (visibility: "visible" | "hidden" = "visible") =>
      createThread(db, noopNotifier, {
        environmentId: environmentA.id,
        projectId: project.id,
        providerId: "codex",
        status: "active",
        visibility,
      });
    const live = make();
    const hidden = make("hidden");
    const archived = make();
    const deleted = make();
    archiveThread(db, noopNotifier, archived.id);
    markThreadDeleted(db, noopNotifier, { threadId: deleted.id });

    // A hidden thread burns a real slot on a real machine, so hiding it here
    // would under-report occupancy; archival and deletion actually stop one.
    expect(listRunningThreads(db).map((row) => row.id).sort()).toEqual(
      [live.id, hidden.id].sort(),
    );
  });

  it("resolves the host through the thread's environment, null when it has none", () => {
    const { db, environmentA, environmentB, hostA, hostB, project } = setup();
    const onA = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    const onB = createThread(db, noopNotifier, {
      environmentId: environmentB.id,
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });
    // A thread admitted but not yet provisioned: counts globally, on no host.
    const unplaced = createThread(db, noopNotifier, {
      environmentId: null,
      projectId: project.id,
      providerId: "codex",
      status: "starting",
    });

    const byId = new Map(
      listRunningThreads(db).map((row) => [row.id, row.hostId]),
    );
    expect(byId.get(onA.id)).toBe(hostA.id);
    expect(byId.get(onB.id)).toBe(hostB.id);
    expect(byId.get(unplaced.id)).toBeNull();
  });

  it("counts child and plugin-spawned threads like any other", () => {
    // Occupancy is about slots, not provenance: a child thread and a
    // plugin-spawned one each burn a real slot on a real machine, so a row
    // that hid them would under-report what is running.
    const { db, environmentA, project } = setup();
    const parent = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    const child = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
      parentThreadId: parent.id,
    });
    const spawned = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
      originPluginId: "workflows",
    });

    expect(listRunningThreads(db).map((row) => row.id).sort()).toEqual(
      [parent.id, child.id, spawned.id].sort(),
    );
  });
});
