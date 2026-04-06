import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  applyProvisionedEnvironmentRecord,
  clearEnvironmentCleanupRequestRecord,
  claimManagedEnvironmentReprovisionRecord,
  createEnvironment,
  recordEnvironmentCleanupRequest,
  setEnvironmentRecordDestroyed,
  setEnvironmentStatus,
  updateEnvironmentMetadata,
} from "../../src/data/environments.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { environments } from "../../src/schema.js";

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

    const updated = setEnvironmentStatus(db, notifier, environment.id, {
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

    const updated = applyProvisionedEnvironmentRecord(db, notifier, environment.id, {
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

  it("claims managed reprovision only once", () => {
    const { db, host, project } = setup();
    const notifier = createNotifierSpy();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      managed: true,
      status: "error",
    });

    const firstClaim = claimManagedEnvironmentReprovisionRecord(db, notifier, {
      environmentId: environment.id,
      now: 123,
    });
    const secondClaim = claimManagedEnvironmentReprovisionRecord(db, notifier, {
      environmentId: environment.id,
      now: 124,
    });

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    expect(db.select().from(environments).all()[0]).toMatchObject({
      id: environment.id,
      status: "provisioning",
      updatedAt: 123,
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "status-changed",
    ]);
  });

  it("records cleanup intent through the lifecycle write path", () => {
    const { db, host, project } = setup();
    const notifier = createNotifierSpy();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      managed: true,
      status: "ready",
    });

    const requested = recordEnvironmentCleanupRequest(db, notifier, environment.id, {
      cleanupMode: "safe",
      requestedAt: 123,
    });
    const escalated = recordEnvironmentCleanupRequest(db, notifier, environment.id, {
      cleanupMode: "force",
      requestedAt: 456,
    });
    const cleared = clearEnvironmentCleanupRequestRecord(
      db,
      notifier,
      environment.id,
    );

    expect(requested).toMatchObject({
      cleanupRequestedAt: 123,
      cleanupMode: "safe",
    });
    expect(escalated).toMatchObject({
      cleanupRequestedAt: 123,
      cleanupMode: "force",
    });
    expect(cleared).toMatchObject({
      cleanupRequestedAt: null,
      cleanupMode: null,
    });
    expect(notifier.notifyEnvironment).toHaveBeenNthCalledWith(
      1,
      environment.id,
      ["metadata-changed"],
    );
    expect(notifier.notifyEnvironment).toHaveBeenNthCalledWith(
      2,
      environment.id,
      ["metadata-changed"],
    );
    expect(notifier.notifyEnvironment).toHaveBeenNthCalledWith(
      3,
      environment.id,
      ["metadata-changed"],
    );
  });

  it("marks destroyed through the lifecycle write path", () => {
    const { db, host, project } = setup();
    const notifier = createNotifierSpy();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      managed: true,
      cleanupRequestedAt: 123,
      cleanupMode: "force",
      status: "destroying",
    });

    const updated = setEnvironmentRecordDestroyed(db, notifier, environment.id);

    expect(updated).toMatchObject({
      status: "destroyed",
      cleanupRequestedAt: null,
      cleanupMode: null,
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "status-changed",
      "metadata-changed",
    ]);
  });
});
