import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  countThreads,
  createThread,
  markThreadDeleted,
} from "../../src/data/threads.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

/**
 * Two hosts, two projects and threads spread across both, so every grouping
 * has more than one bucket and a filter that ignored its argument would show.
 */
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
  const { project: projectA } = createProject(db, noopNotifier, {
    name: "project-a",
    source: { type: "local_path", hostId: hostA.id, path: "/tmp/a" },
  });
  const { project: projectB } = createProject(db, noopNotifier, {
    name: "project-b",
    source: { type: "local_path", hostId: hostB.id, path: "/tmp/b" },
  });
  const environmentA = createEnvironment(db, noopNotifier, {
    hostId: hostA.id,
    projectId: projectA.id,
    path: "/tmp/a",
    workspaceProvisionType: "unmanaged",
  });
  const environmentB = createEnvironment(db, noopNotifier, {
    hostId: hostB.id,
    projectId: projectB.id,
    path: "/tmp/b",
    workspaceProvisionType: "unmanaged",
  });
  return { db, environmentA, environmentB, hostA, hostB, projectA, projectB };
}

describe("countThreads", () => {
  it("counts live visible threads and excludes archived and deleted ones", () => {
    const { db, environmentA, projectA } = setup();
    const live = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    const archived = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    const deleted = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    const hidden = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
      visibility: "hidden",
    });
    archiveThread(db, noopNotifier, archived.id);
    markThreadDeleted(db, noopNotifier, { threadId: deleted.id });

    expect(countThreads(db, {})).toEqual({ total: 1 });
    // Archived rows are countable on request; deleted ones never are.
    expect(countThreads(db, { includeArchived: true })).toEqual({ total: 2 });
    expect(countThreads(db, { includeHidden: true })).toEqual({ total: 2 });
    expect(
      countThreads(db, { includeArchived: true, includeHidden: true }),
    ).toEqual({ total: 3 });
    expect(countThreads(db, { status: "active" }).total).toBe(1);
    expect(countThreads(db, { status: "idle" }).total).toBe(0);
    expect(live.id).not.toBe(hidden.id);
  });

  it("groups by host, provider and project", () => {
    const { db, environmentA, environmentB, hostA, hostB, projectA, projectB } =
      setup();
    createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "claude-code",
      status: "active",
    });
    createThread(db, noopNotifier, {
      environmentId: environmentB.id,
      projectId: projectB.id,
      providerId: "codex",
      status: "active",
    });
    // A thread with no environment yet — the case a host grouping has to place
    // somewhere rather than drop.
    createThread(db, noopNotifier, {
      environmentId: null,
      projectId: projectA.id,
      providerId: "codex",
      status: "starting",
    });

    const byHost = countThreads(db, { groupBy: "host" });
    expect(byHost.total).toBe(4);
    expect(byKey(byHost.groups)).toEqual({
      "<none>": 1,
      [hostA.id]: 2,
      [hostB.id]: 1,
    });

    const byProvider = countThreads(db, { groupBy: "provider" });
    expect(byKey(byProvider.groups)).toEqual({ "claude-code": 1, codex: 3 });

    const byProject = countThreads(db, { groupBy: "project" });
    expect(byKey(byProject.groups)).toEqual({
      [projectA.id]: 3,
      [projectB.id]: 1,
    });
  });

  it("filters by host through the environment join", () => {
    const { db, environmentA, environmentB, hostA, projectA, projectB } =
      setup();
    createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    createThread(db, noopNotifier, {
      environmentId: environmentB.id,
      projectId: projectB.id,
      providerId: "codex",
      status: "active",
    });

    expect(countThreads(db, { hostId: hostA.id })).toEqual({ total: 1 });
    expect(countThreads(db, { hostId: "host_missing" })).toEqual({ total: 0 });
  });

  it("distinguishes root threads from a named parent and from no filter", () => {
    const { db, environmentA, projectA } = setup();
    const root = createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      parentThreadId: root.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });
    createThread(db, noopNotifier, {
      environmentId: environmentA.id,
      parentThreadId: root.id,
      projectId: projectA.id,
      providerId: "codex",
      status: "active",
    });

    // Three states, three answers — this is what the route's "none" sentinel
    // buys over an empty-string parameter.
    expect(countThreads(db, {}).total).toBe(3);
    expect(countThreads(db, { parent: { kind: "root" } }).total).toBe(1);
    expect(
      countThreads(db, {
        parent: { kind: "id", parentThreadId: root.id },
      }).total,
    ).toBe(2);
  });
});

/** Group ids are random, so compare as a keyed map rather than an ordered list. */
function byKey(groups: { key: string | null; count: number }[] | undefined) {
  return Object.fromEntries(
    (groups ?? []).map((group) => [group.key ?? "<none>", group.count]),
  );
}
