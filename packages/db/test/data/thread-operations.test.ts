import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  createThread,
} from "../../src/data/threads.js";
import { queueCommand } from "../../src/data/commands.js";
import {
  getThreadOperation,
  getThreadOperationByCommandId,
  markThreadOperationCompleted,
  markThreadOperationQueued,
  upsertThreadOperation,
} from "../../src/data/thread-operations.js";
import { createEnvironment } from "../../src/data/environments.js";
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
    workspaceProvisionType: "unmanaged",
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "openai",
  });
  return { db, host, thread };
}

describe("thread operations", () => {
  it("upserts thread lifecycle operations by thread and kind", () => {
    const { db, thread } = setup();

    const first = upsertThreadOperation(db, {
      threadId: thread.id,
      kind: "start",
      payload: JSON.stringify({ type: "thread.start" }),
      requestedAt: 111,
    });
    const second = upsertThreadOperation(db, {
      threadId: thread.id,
      kind: "start",
      payload: JSON.stringify({ type: "thread.start", attempt: 2 }),
      requestedAt: 222,
    });

    expect(first).toMatchObject({
      threadId: thread.id,
      kind: "start",
      state: "requested",
      requestedAt: 111,
    });
    expect(second).toMatchObject({
      id: first.id,
      payload: JSON.stringify({ type: "thread.start", attempt: 2 }),
      requestedAt: 111,
      state: "requested",
    });
  });

  it("records queued and completed thread operations", () => {
    const { db, host, thread } = setup();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "thread.stop",
      payload: JSON.stringify({
        type: "thread.stop",
        threadId: thread.id,
        environmentId: thread.environmentId,
      }),
    });

    upsertThreadOperation(db, {
      threadId: thread.id,
      kind: "stop",
      payload: JSON.stringify({ type: "thread.stop" }),
    });
    const queued = markThreadOperationQueued(db, {
      threadId: thread.id,
      kind: "stop",
      commandId: command.id,
      queuedAt: 333,
    });
    const completed = markThreadOperationCompleted(db, {
      threadId: thread.id,
      kind: "stop",
      completedAt: 444,
    });

    expect(queued).toMatchObject({
      state: "queued",
      commandId: command.id,
      queuedAt: 333,
    });
    expect(getThreadOperationByCommandId(db, command.id)?.id).toBe(
      queued?.id,
    );
    expect(completed).toMatchObject({
      state: "completed",
      completedAt: 444,
    });
    expect(
      getThreadOperation(db, {
        threadId: thread.id,
        kind: "stop",
      }),
    ).toMatchObject({
      state: "completed",
      commandId: command.id,
    });
  });
});
