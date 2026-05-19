import { describe, expect, it } from "vitest";
import {
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  createThreadProvisioningId,
  getThreadOperation,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { upsertThreadOperationRecord } from "@bb/db/internal-lifecycle";
import type { PromptInput } from "@bb/domain";
import {
  requestThreadProvision,
  requestThreadReprovision,
} from "../../src/services/threads/thread-provisioning.js";
import {
  readThreadProvisioningIdFromRecord,
  readThreadProvisioningStateFromRecord,
} from "../../src/services/threads/thread-provisioning-state.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { assertPromptHistoryForTurnRequest } from "../helpers/prompt-history.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/source" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    projectId: project.id,
    workspaceProvisionType: "unmanaged",
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "provisioning",
  });
  const hub = new NotificationHub();
  return { db, environment, host, thread, hub };
}

describe("thread provisioning operation state", () => {
  it("stores lifecycle progress in operation columns instead of the request payload", () => {
    const { db, host, hub, thread } = setup();
    const input: PromptInput[] = [
      { type: "text", text: "start this workspace" },
    ];

    requestThreadProvision(
      { db, hub },
      {
        thread,
        environmentIntent: {
          type: "direct-unmanaged",
          hostId: host.id,
          path: "/tmp/source",
        },
        input,
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        managerTemplateName: null,
        titleProvided: true,
      },
    );

    const operation = getThreadOperation(db, {
      kind: "provision",
      threadId: thread.id,
    });

    expect(operation?.provisioningId).toMatch(/^tpv_/);
    expect(operation?.provisioningStage).toBe("metadata-pending");
    expect(operation?.provisioningEnvironmentId).toBeNull();
    expect(operation?.provisionEventSequence).toBeNull();
    expect(operation?.workspaceReadyEventSequence).toBeNull();
    expect(operation?.payload).not.toContain('"provisioningId"');
    expect(operation?.payload).not.toContain('"stage"');
    assertPromptHistoryForTurnRequest({
      db,
      threadId: thread.id,
      scope: "project",
      input,
    });
  });

  it("records thread prompt history for reprovision requests", () => {
    const { db, environment, hub, thread } = setup();
    const input: PromptInput[] = [
      { type: "text", text: "resume after reprovision" },
    ];

    requestThreadReprovision(
      { db, hub },
      {
        thread,
        environment,
        provisionEventSequence: 0,
        input,
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "user",
        provisioningId: createThreadProvisioningId(),
      },
    );

    assertPromptHistoryForTurnRequest({
      db,
      threadId: thread.id,
      scope: "thread",
      input,
    });
  });

  it("rejects payload-only provisioning records without provisioning columns", () => {
    const legacyRecord = {
      payload: JSON.stringify({
        provisioningId: "tpv_legacy",
        stage: "metadata-pending",
      }),
      provisionEventSequence: null,
      provisioningEnvironmentId: null,
      provisioningId: null,
      provisioningStage: null,
      workspaceReadyEventSequence: null,
    };

    expect(() => readThreadProvisioningStateFromRecord(legacyRecord)).toThrow();
    expect(() => readThreadProvisioningIdFromRecord(legacyRecord)).toThrow();
  });

  it("reads environment-provisioning and workspace-ready state from operation columns", () => {
    const { db, environment, thread } = setup();

    const environmentProvisioning = upsertThreadOperationRecord(db, {
      threadId: thread.id,
      kind: "provision",
      payload: JSON.stringify({ clientRequestId: "creq_23456789ab" }),
      provisioningState: {
        environmentId: environment.id,
        provisionEventSequence: 13,
        provisioningId: "tpv_progress",
        stage: "environment-provisioning",
        workspaceReadyEventSequence: null,
      },
    });
    expect(
      readThreadProvisioningStateFromRecord(environmentProvisioning),
    ).toEqual({
      environmentId: environment.id,
      provisionEventSequence: 13,
      provisioningId: "tpv_progress",
      stage: "environment-provisioning",
      workspaceReadyEventSequence: null,
    });

    const workspaceReady = upsertThreadOperationRecord(db, {
      threadId: thread.id,
      kind: "provision",
      payload: JSON.stringify({ clientRequestId: "creq_23456789ac" }),
      provisioningState: {
        environmentId: environment.id,
        provisionEventSequence: 13,
        provisioningId: "tpv_progress",
        stage: "workspace-ready",
        workspaceReadyEventSequence: 17,
      },
    });
    expect(readThreadProvisioningStateFromRecord(workspaceReady)).toEqual({
      environmentId: environment.id,
      provisionEventSequence: 13,
      provisioningId: "tpv_progress",
      stage: "workspace-ready",
      workspaceReadyEventSequence: 17,
    });
  });
});
