import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  applyProvisionedEnvironment,
  createEnvironment,
  updateEnvironmentMetadata,
  updateEnvironmentStatus,
} from "../../src/data/environments.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";

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

function createNotifierSpy(): DbNotifier {
  return {
    notifyThread: vi.fn(),
    notifyProject: vi.fn(),
    notifyEnvironment: vi.fn(),
    notifyHost: vi.fn(),
    notifyCommand: vi.fn(),
    notifySystem: vi.fn(),
  };
}

describe("environments", () => {
  it("emits metadata-changed when merge base branch changes", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      mergeBaseBranch: "release",
    });

    expect(updated?.mergeBaseBranch).toBe("release");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("does not emit metadata-changed when merge base branch is unchanged", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      mergeBaseBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      mergeBaseBranch: "main",
    });

    expect(updated?.mergeBaseBranch).toBe("main");
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("emits status-changed for explicit status updates", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      status: "provisioning",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentStatus(db, notifier, environment.id, {
      status: "ready",
    });

    expect(updated?.status).toBe("ready");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "status-changed",
    ]);
  });

  it("emits both status-changed and metadata-changed for provisioning results", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      status: "provisioning",
    });
    const notifier = createNotifierSpy();

    const updated = applyProvisionedEnvironment(db, notifier, environment.id, {
      path: "/tmp/project",
      status: "ready",
      isGitRepo: true,
      isWorktree: false,
      branchName: "bb/test",
      defaultBranch: "main",
    });

    expect(updated).toMatchObject({
      path: "/tmp/project",
      status: "ready",
      isGitRepo: true,
      branchName: "bb/test",
      defaultBranch: "main",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "status-changed",
      "metadata-changed",
    ]);
  });
});
