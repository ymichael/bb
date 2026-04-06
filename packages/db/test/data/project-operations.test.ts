import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { queueCommand } from "../../src/data/commands.js";
import {
  getProjectOperation,
  getProjectOperationByCommandId,
  listProjectOperations,
  markProjectOperationRecordCompleted,
  markProjectOperationRecordFailed,
  markProjectOperationRecordQueued,
  upsertProjectOperationRecord,
} from "../../src/data/project-operations.js";
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

describe("project operations", () => {
  it("upserts requested project operations by project and kind", () => {
    const { db, project } = setup();

    const first = upsertProjectOperationRecord(db, {
      projectId: project.id,
      kind: "delete",
      payload: JSON.stringify({ stage: "requested" }),
      requestedAt: 555,
    });
    const second = upsertProjectOperationRecord(db, {
      projectId: project.id,
      kind: "delete",
      payload: JSON.stringify({ stage: "retry" }),
      requestedAt: 666,
    });

    expect(first).toMatchObject({
      projectId: project.id,
      kind: "delete",
      state: "requested",
      requestedAt: 555,
    });
    expect(second).toMatchObject({
      id: first.id,
      payload: JSON.stringify({ stage: "retry" }),
      requestedAt: 555,
      state: "requested",
    });
  });

  it("records queued and failed project operations", () => {
    const { db, host, project } = setup();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "environment.destroy",
      payload: JSON.stringify({
        type: "environment.destroy",
        environmentId: "env_placeholder",
        workspaceContext: {
          workspacePath: "/tmp/test",
          workspaceProvisionType: "managed-worktree",
        },
      }),
    });

    upsertProjectOperationRecord(db, {
      projectId: project.id,
      kind: "delete",
      payload: JSON.stringify({ stage: "requested" }),
    });
    const queued = markProjectOperationRecordQueued(db, {
      projectId: project.id,
      kind: "delete",
      commandId: command.id,
      queuedAt: 777,
    });
    const failed = markProjectOperationRecordFailed(db, {
      projectId: project.id,
      kind: "delete",
      failureReason: "environment destroy failed",
      completedAt: 888,
    });

    expect(queued).toMatchObject({
      state: "queued",
      commandId: command.id,
      queuedAt: 777,
    });
    expect(getProjectOperationByCommandId(db, command.id)?.id).toBe(
      queued?.id,
    );
    expect(failed).toMatchObject({
      state: "failed",
      failureReason: "environment destroy failed",
      completedAt: 888,
    });
    expect(
      getProjectOperation(db, {
        projectId: project.id,
        kind: "delete",
      }),
    ).toMatchObject({
      state: "failed",
      commandId: command.id,
    });
  });

  it("lists project operations by kind and state", () => {
    const { db, project } = setup();

    upsertProjectOperationRecord(db, {
      projectId: project.id,
      kind: "delete",
      payload: JSON.stringify({ stage: "requested" }),
    });

    expect(
      listProjectOperations(db, {
        kind: "delete",
        states: ["requested"],
      }),
    ).toHaveLength(1);
    expect(
      listProjectOperations(db, {
        kind: "delete",
        states: ["failed"],
      }),
    ).toHaveLength(0);
  });

  it("does not move terminal project operations back to queued", () => {
    const { db, host, project } = setup();
    const firstCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "environment.destroy",
      payload: JSON.stringify({
        type: "environment.destroy",
        environmentId: "env_placeholder",
        workspaceContext: {
          workspacePath: "/tmp/test",
          workspaceProvisionType: "managed-worktree",
        },
      }),
    });
    const secondCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "environment.destroy",
      payload: JSON.stringify({
        type: "environment.destroy",
        environmentId: "env_placeholder",
        workspaceContext: {
          workspacePath: "/tmp/test",
          workspaceProvisionType: "managed-worktree",
        },
      }),
    });

    upsertProjectOperationRecord(db, {
      projectId: project.id,
      kind: "delete",
      payload: JSON.stringify({ stage: "requested" }),
    });
    markProjectOperationRecordQueued(db, {
      projectId: project.id,
      kind: "delete",
      commandId: firstCommand.id,
    });
    markProjectOperationRecordCompleted(db, {
      projectId: project.id,
      kind: "delete",
    });

    const regressed = markProjectOperationRecordQueued(db, {
      projectId: project.id,
      kind: "delete",
      commandId: secondCommand.id,
    });

    expect(regressed).toBeNull();
    expect(
      getProjectOperation(db, {
        projectId: project.id,
        kind: "delete",
      }),
    ).toMatchObject({
      commandId: firstCommand.id,
      state: "completed",
    });
  });
});
