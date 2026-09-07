import { describe, expect, it } from "vitest";
import {
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { getActiveThreadProvisionContext } from "../../src/services/threads/thread-provisioning-active-context.js";
import { requestThreadProvision } from "../../src/services/threads/thread-provisioning.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { assertPromptHistoryForTurnRequest } from "../helpers/prompt-history.js";
import { textInput } from "../helpers/prompt-input.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/source" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: host.id,
    projectId: project.id,
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "starting",
  });
  const hub = new NotificationHub();
  return { db, environment, host, thread, hub };
}

describe("thread provisioning state", () => {
  it("stores provisioning progress in live context without a durable row payload", () => {
    const { db, host, hub, thread } = setup();
    const input = textInput("start this workspace");

    const context = requestThreadProvision(
      { db, hub },
      {
        thread,
        environmentIntent: {
          type: "provider",
          environmentProviderId: "project-checkout",
          machine: { type: "existing", hostId: host.id },
          inputs: {},
          selectionResolved: true,
          produced: {
            hostId: host.id,
            path: "/tmp/source",
            mergeBaseBranch: null,
            ownsPath: false,
          },
        },
        input,
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        fork: null,
        startedOnBehalfOf: null,
        titleProvided: true,
      },
    );

    expect(context.state.provisioningId).toMatch(/^tpv_/);
    expect(context.state.stage).toBe("metadata-pending");
    expect(context.state.environmentId).toBeNull();
    expect(context.state.provisionEventSequence).toBeNull();
    expect(context.state.workspaceReadyEventSequence).toBeNull();
    expect(getActiveThreadProvisionContext(thread.id)).toEqual(context);
    assertPromptHistoryForTurnRequest({
      db,
      threadId: thread.id,
      scope: "project",
      input,
    });
  });
});
