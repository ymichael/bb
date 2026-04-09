import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { queueCommand } from "../../src/data/commands.js";
import {
  getEnvironmentOperation,
  getEnvironmentOperationByCommandId,
  markEnvironmentOperationRecordCompleted,
  markEnvironmentOperationRecordFailed,
  markEnvironmentOperationRecordFetched,
  markEnvironmentOperationRecordQueued,
  upsertEnvironmentOperationRecord,
} from "../../src/data/environment-operations.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";

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
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    workspaceProvisionType: "managed-worktree",
  });
  return { db, environment, host };
}

describe("environment operations", () => {
  it("upserts requested operations by environment and kind", () => {
    const { db, environment } = setup();

    const first = upsertEnvironmentOperationRecord(db, {
      environmentId: environment.id,
      kind: "destroy",
      payload: JSON.stringify({ mode: "safe" }),
      requestedAt: 123,
    });
    const second = upsertEnvironmentOperationRecord(db, {
      environmentId: environment.id,
      kind: "destroy",
      payload: JSON.stringify({ mode: "force" }),
      requestedAt: 456,
    });

    expect(first).toMatchObject({
      environmentId: environment.id,
      kind: "destroy",
      state: "requested",
      payload: JSON.stringify({ mode: "safe" }),
      requestedAt: 123,
    });
    expect(second).toMatchObject({
      id: first.id,
      environmentId: environment.id,
      kind: "destroy",
      state: "requested",
      payload: JSON.stringify({ mode: "force" }),
      requestedAt: 123,
      commandId: null,
    });
  });

  it("tracks queued, fetched, completed, and failed environment operations", () => {
    const { db, environment, host } = setup();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "environment.provision",
      payload: JSON.stringify({
        type: "environment.provision",
        environmentId: environment.id,
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/source",
        targetPath: "/tmp/target",
        branchName: "main",
        setupTimeoutMs: 1000,
      }),
    });

    upsertEnvironmentOperationRecord(db, {
      environmentId: environment.id,
      kind: "provision",
      payload: JSON.stringify({ type: "environment.provision" }),
    });
    const queued = markEnvironmentOperationRecordQueued(db, {
      environmentId: environment.id,
      kind: "provision",
      commandId: command.id,
      queuedAt: 321,
    });
    const fetched = markEnvironmentOperationRecordFetched(db, {
      environmentId: environment.id,
      kind: "provision",
    });
    const completed = markEnvironmentOperationRecordCompleted(db, {
      environmentId: environment.id,
      kind: "provision",
      completedAt: 777,
    });
    upsertEnvironmentOperationRecord(db, {
      environmentId: environment.id,
      kind: "provision",
      payload: JSON.stringify({ type: "environment.provision", retry: true }),
    });
    markEnvironmentOperationRecordQueued(db, {
      environmentId: environment.id,
      kind: "provision",
      commandId: command.id,
      queuedAt: 888,
    });
    const failed = markEnvironmentOperationRecordFailed(db, {
      environmentId: environment.id,
      kind: "provision",
      failureReason: "provision timed out",
      completedAt: 999,
    });

    expect(queued).toMatchObject({
      state: "queued",
      commandId: command.id,
      queuedAt: 321,
    });
    expect(fetched?.state).toBe("fetched");
    expect(getEnvironmentOperationByCommandId(db, command.id)?.id).toBe(
      queued?.id,
    );
    expect(completed).toMatchObject({
      state: "completed",
      completedAt: 777,
      failureReason: null,
    });
    expect(failed).toMatchObject({
      state: "failed",
      failureReason: "provision timed out",
      completedAt: 999,
    });
    expect(
      getEnvironmentOperation(db, {
        environmentId: environment.id,
        kind: "provision",
      }),
    ).toMatchObject({
      state: "failed",
      commandId: command.id,
    });
  });

  it("does not move terminal environment operations back to queued", () => {
    const { db, environment, host } = setup();
    const firstCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "environment.provision",
      payload: JSON.stringify({
        type: "environment.provision",
        environmentId: environment.id,
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/source",
        targetPath: "/tmp/target",
        branchName: "main",
        setupTimeoutMs: 1000,
      }),
    });
    const secondCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "environment.provision",
      payload: JSON.stringify({
        type: "environment.provision",
        environmentId: environment.id,
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/source",
        targetPath: "/tmp/target",
        branchName: "main",
        setupTimeoutMs: 1000,
      }),
    });

    upsertEnvironmentOperationRecord(db, {
      environmentId: environment.id,
      kind: "provision",
      payload: JSON.stringify({ type: "environment.provision" }),
    });
    markEnvironmentOperationRecordQueued(db, {
      environmentId: environment.id,
      kind: "provision",
      commandId: firstCommand.id,
    });
    markEnvironmentOperationRecordCompleted(db, {
      environmentId: environment.id,
      kind: "provision",
    });

    const regressed = markEnvironmentOperationRecordQueued(db, {
      environmentId: environment.id,
      kind: "provision",
      commandId: secondCommand.id,
    });

    expect(regressed).toBeNull();
    expect(
      getEnvironmentOperation(db, {
        environmentId: environment.id,
        kind: "provision",
      }),
    ).toMatchObject({
      commandId: firstCommand.id,
      state: "completed",
    });
  });
});
