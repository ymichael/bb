import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { queueCommand } from "../../src/data/commands.js";
import {
  getHostOperation,
  getHostOperationByCommandId,
  listHostOperations,
  markHostOperationRecordCompleted,
  markHostOperationRecordFailed,
  markHostOperationRecordFetched,
  markHostOperationRecordQueued,
  resetHostOperationRecordToRequested,
  upsertHostOperationRecord,
} from "../../src/data/host-operations.js";
import { upsertHost } from "../../src/data/hosts.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "ephemeral",
    provider: "e2b",
    externalId: "sandbox-test",
  });
  return { db, host };
}

describe("host operations", () => {
  it("upserts requested host operations by host and kind", () => {
    const { db, host } = setup();

    const first = upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 1 }),
      requestedAt: 111,
    });
    const second = upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 2 }),
      requestedAt: 222,
    });

    expect(first).toMatchObject({
      hostId: host.id,
      kind: "sync_runtime_material",
      state: "requested",
      requestedAt: 111,
    });
    expect(second).toMatchObject({
      id: first.id,
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 2 }),
      requestedAt: 111,
      state: "requested",
    });
  });

  it("records queued, fetched, completed, and failed host operations", () => {
    const { db, host } = setup();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "provider.list",
      payload: JSON.stringify({ type: "provider.list" }),
    });

    upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 1 }),
    });
    const queued = markHostOperationRecordQueued(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      commandId: command.id,
      queuedAt: 333,
    });
    const fetched = markHostOperationRecordFetched(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
    });
    const completed = markHostOperationRecordCompleted(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      completedAt: 444,
    });
    upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 2 }),
    });
    markHostOperationRecordQueued(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      commandId: command.id,
      queuedAt: 555,
    });
    const failed = markHostOperationRecordFailed(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      failureReason: "sync failed",
      completedAt: 666,
    });

    expect(queued).toMatchObject({
      state: "queued",
      commandId: command.id,
      queuedAt: 333,
    });
    expect(fetched?.state).toBe("fetched");
    expect(getHostOperationByCommandId(db, command.id)?.id).toBe(queued?.id);
    expect(completed).toMatchObject({
      state: "completed",
      completedAt: 444,
      failureReason: null,
    });
    expect(failed).toMatchObject({
      state: "failed",
      completedAt: 666,
      failureReason: "sync failed",
    });
    expect(
      getHostOperation(db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      }),
    ).toMatchObject({
      commandId: command.id,
      state: "failed",
    });
  });

  it("lists host operations by kind and state", () => {
    const { db, host } = setup();

    upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 1 }),
    });

    expect(
      listHostOperations(db, {
        hostIds: [host.id],
        kinds: ["sync_runtime_material"],
        states: ["requested"],
      }),
    ).toHaveLength(1);
    expect(
      listHostOperations(db, {
        hostIds: [host.id],
        kinds: ["sync_runtime_material"],
        states: ["failed"],
      }),
    ).toHaveLength(0);
  });

  it("does not move terminal host operations back to queued", () => {
    const { db, host } = setup();
    const firstCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "provider.list",
      payload: JSON.stringify({ type: "provider.list" }),
    });
    const secondCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "provider.list",
      payload: JSON.stringify({ type: "provider.list" }),
    });

    upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 1 }),
    });
    markHostOperationRecordQueued(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      commandId: firstCommand.id,
    });
    markHostOperationRecordCompleted(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
    });

    const regressed = markHostOperationRecordQueued(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      commandId: secondCommand.id,
    });

    expect(regressed).toBeNull();
    expect(
      getHostOperation(db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      }),
    ).toMatchObject({
      commandId: firstCommand.id,
      state: "completed",
    });
  });

  it("does not move completed host operations back to fetched", () => {
    const { db, host } = setup();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "provider.list",
      payload: JSON.stringify({ type: "provider.list" }),
    });

    upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 1 }),
    });
    markHostOperationRecordQueued(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      commandId: command.id,
    });
    markHostOperationRecordCompleted(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
    });

    const regressed = markHostOperationRecordFetched(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
    });

    expect(regressed).toBeNull();
    expect(
      getHostOperation(db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      }),
    ).toMatchObject({
      state: "completed",
    });
  });

  it("only resets host operations to requested from allowed states", () => {
    const { db, host } = setup();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "provider.list",
      payload: JSON.stringify({ type: "provider.list" }),
    });

    upsertHostOperationRecord(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 1 }),
    });
    markHostOperationRecordQueued(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
      commandId: command.id,
    });
    markHostOperationRecordCompleted(db, {
      hostId: host.id,
      kind: "sync_runtime_material",
    });

    const rejectedReset = resetHostOperationRecordToRequested(db, {
      allowedCurrentStates: ["queued", "fetched"],
      hostId: host.id,
      kind: "sync_runtime_material",
      payload: JSON.stringify({ version: 2 }),
    });

    expect(rejectedReset).toBeNull();
    expect(
      getHostOperation(db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      }),
    ).toMatchObject({
      payload: JSON.stringify({ version: 1 }),
      state: "completed",
    });
  });
});
