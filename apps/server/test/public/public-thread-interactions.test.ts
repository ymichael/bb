import { createDraft } from "@bb/db";
import type { PendingInteractionCreate } from "@bb/domain";
import { describe, expect, it } from "vitest";
import type { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import { readJson } from "../helpers/json.js";
import {
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

function registerPendingInteraction(
  lifecycle: PendingInteractionLifecycle,
  interaction: PendingInteractionCreate,
) {
  return lifecycle.registerPendingInteraction({
    interaction,
    sessionId: "session-1",
  });
}

describe("public thread interaction routes", () => {
  it("lists, gets, and resolves thread-owned interactions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-interactions",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const otherThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const registered = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-public-1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        providerRequestId: "request-1",
        payload: {
          kind: "command_approval",
          itemId: "item-1",
          reason: "Approve command",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${registered.reason}`);
      }

      const listResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions`,
      );
      expect(listResponse.status).toBe(200);
      await expect(readJson(listResponse)).resolves.toMatchObject([
        {
          id: registered.interaction.id,
          threadId: thread.id,
          status: "pending",
          payload: {
            kind: "command_approval",
            command: "git push",
          },
        },
      ]);

      const getResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${registered.interaction.id}`,
      );
      expect(getResponse.status).toBe(200);
      await expect(readJson(getResponse)).resolves.toMatchObject({
        id: registered.interaction.id,
        threadId: thread.id,
        status: "pending",
      });

      const invalidInteractionIdResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/not-an-interaction-id`,
      );
      expect(invalidInteractionIdResponse.status).toBe(400);
      await expect(readJson(invalidInteractionIdResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Invalid pending interaction id",
      });

      const wrongThreadResponse = await harness.app.request(
        `/api/v1/threads/${otherThread.id}/interactions/${registered.interaction.id}`,
      );
      expect(wrongThreadResponse.status).toBe(404);
      await expect(readJson(wrongThreadResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Pending interaction not found",
      });

      const resolveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${registered.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "command_approval",
            decision: "accept_for_session",
          }),
        },
      );
      expect(resolveResponse.status).toBe(200);
      await expect(readJson(resolveResponse)).resolves.toMatchObject({
        id: registered.interaction.id,
        status: "resolved",
        resolution: {
          kind: "command_approval",
          decision: "accept_for_session",
        },
      });

      const duplicateResolveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${registered.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "command_approval",
            decision: "accept_for_session",
          }),
        },
      );
      expect(duplicateResolveResponse.status).toBe(200);
      await expect(readJson(duplicateResolveResponse)).resolves.toMatchObject({
        id: registered.interaction.id,
        status: "resolved",
        resolution: {
          kind: "command_approval",
          decision: "accept_for_session",
        },
      });

      const conflictingResolveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${registered.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "command_approval",
            decision: "decline",
          }),
        },
      );
      expect(conflictingResolveResponse.status).toBe(409);
      await expect(readJson(conflictingResolveResponse)).resolves.toEqual({
        code: "invalid_request",
        message: `Pending interaction ${registered.interaction.id} is already resolved`,
      });

      const postResolveListResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions`,
      );
      expect(postResolveListResponse.status).toBe(200);
      await expect(readJson(postResolveListResponse)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unavailable command decisions and mismatched resolution kinds", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-invalid-resolution",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const commandApproval = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-invalid-command-resolution",
        providerId: "codex",
        providerThreadId: "provider-thread-invalid-command-resolution",
        providerRequestId: "request-invalid-command-resolution",
        payload: {
          kind: "command_approval",
          itemId: "item-invalid-command-resolution",
          reason: "Approve command",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "decline", "cancel"],
        },
      });
      if (commandApproval.outcome === "rejected") {
        throw new Error(`Expected command interaction registration to succeed: ${commandApproval.reason}`);
      }

      const invalidCommandResolution = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${commandApproval.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "command_approval",
            decision: "accept_for_session",
          }),
        },
      );
      expect(invalidCommandResolution.status).toBe(400);
      await expect(readJson(invalidCommandResolution)).resolves.toEqual({
        code: "invalid_request",
        message: `Command approval decision 'accept_for_session' is not available for interaction ${commandApproval.interaction.id}`,
      });

      const mismatchedKindResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${commandApproval.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "file_change_approval",
            decision: "accept",
          }),
        },
      );
      expect(mismatchedKindResponse.status).toBe(400);
      await expect(readJson(mismatchedKindResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Pending interaction resolution kind does not match the interaction payload",
      });

      harness.deps.pendingInteractions.interruptPendingInteraction({
        interactionId: commandApproval.interaction.id,
        reason: "Provider exited",
      });

      const interruptedResolution = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${commandApproval.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "command_approval",
            decision: "accept",
          }),
        },
      );
      expect(interruptedResolution.status).toBe(409);
      await expect(readJson(interruptedResolution)).resolves.toEqual({
        code: "invalid_request",
        message: `Pending interaction ${commandApproval.interaction.id} is already interrupted`,
      });

      const malformedBodyResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${commandApproval.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "permission_request",
            decision: "allow",
          }),
        },
      );
      expect(malformedBodyResponse.status).toBe(400);
      await expect(readJson(malformedBodyResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Invalid input",
      });

    } finally {
      await harness.cleanup();
    }
  });

  it("resolves permission requests and rejects grants outside the requested scope", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-permission-resolution",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const permissionRequest = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-permission-resolution",
        providerId: "codex",
        providerThreadId: "provider-thread-permission-resolution",
        providerRequestId: "request-permission-resolution",
        payload: {
          kind: "permission_request",
          itemId: "item-permission-resolution",
          reason: "Grant workspace access",
          toolName: null,
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: ["/tmp/project/notes.md"],
            },
          },
        },
      });
      if (permissionRequest.outcome === "rejected") {
        throw new Error(`Expected permission interaction registration to succeed: ${permissionRequest.reason}`);
      }

      const grantResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${permissionRequest.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "permission_request",
            decision: "allow",
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/project/README.md"],
                write: [],
              },
            },
            scope: "session",
          }),
        },
      );
      expect(grantResponse.status).toBe(200);
      await expect(readJson(grantResponse)).resolves.toMatchObject({
        id: permissionRequest.interaction.id,
        status: "resolved",
        resolution: {
          kind: "permission_request",
          decision: "allow",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
          scope: "session",
        },
      });

      const deniedPermissionRequest = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-permission-resolution-denied",
        providerId: "codex",
        providerThreadId: "provider-thread-permission-resolution",
        providerRequestId: "request-permission-resolution-denied",
        payload: {
          kind: "permission_request",
          itemId: "item-permission-resolution-denied",
          reason: "Grant network access",
          toolName: null,
          permissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
      });
      if (deniedPermissionRequest.outcome === "rejected") {
        throw new Error(`Expected permission interaction registration to succeed: ${deniedPermissionRequest.reason}`);
      }

      const denyResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${deniedPermissionRequest.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "permission_request",
            decision: "deny",
          }),
        },
      );
      expect(denyResponse.status).toBe(200);
      await expect(readJson(denyResponse)).resolves.toMatchObject({
        id: deniedPermissionRequest.interaction.id,
        status: "resolved",
        resolution: {
          kind: "permission_request",
          decision: "deny",
        },
      });

      const invalidPermissionRequest = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-permission-resolution-invalid",
        providerId: "codex",
        providerThreadId: "provider-thread-permission-resolution",
        providerRequestId: "request-permission-resolution-invalid",
        payload: {
          kind: "permission_request",
          itemId: "item-permission-resolution-invalid",
          reason: "Grant workspace access",
          toolName: null,
          permissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      });
      if (invalidPermissionRequest.outcome === "rejected") {
        throw new Error(`Expected permission interaction registration to succeed: ${invalidPermissionRequest.reason}`);
      }

      const invalidGrantResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${invalidPermissionRequest.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "permission_request",
            decision: "allow",
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/project/README.md"],
                write: [],
              },
            },
            scope: "turn",
          }),
        },
      );
      expect(invalidGrantResponse.status).toBe(400);
      await expect(readJson(invalidGrantResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Granted network permissions must be a subset of the requested permissions",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts command approval amendment resolutions that were offered by the provider", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-amendment-resolution",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const commandApproval = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-amendment-resolution",
        providerId: "codex",
        providerThreadId: "provider-thread-amendment-resolution",
        providerRequestId: "request-amendment-resolution",
        payload: {
          kind: "command_approval",
          itemId: "item-amendment-resolution",
          reason: "Approve command",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: [
            {
              kind: "accept_with_exec_policy_amendment",
              execPolicyAmendment: ["allow", "git", "push"],
            },
            "decline",
            "cancel",
          ],
        },
      });
      if (commandApproval.outcome === "rejected") {
        throw new Error(`Expected command interaction registration to succeed: ${commandApproval.reason}`);
      }

      const resolveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${commandApproval.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "command_approval",
            decision: {
              kind: "accept_with_exec_policy_amendment",
              execPolicyAmendment: ["allow", "git", "push"],
            },
          }),
        },
      );
      expect(resolveResponse.status).toBe(200);
      await expect(readJson(resolveResponse)).resolves.toMatchObject({
        id: commandApproval.interaction.id,
        status: "resolved",
        resolution: {
          kind: "command_approval",
          decision: {
            kind: "accept_with_exec_policy_amendment",
            execPolicyAmendment: ["allow", "git", "push"],
          },
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects send and draft-send while a thread awaits user interaction", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-blocked-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/blocked-send-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const draft = createDraft(harness.db, harness.hub, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued draft" }],
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });
      const pending = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-blocked-send",
        providerId: "codex",
        providerThreadId: "provider-thread-blocked",
        providerRequestId: "request-blocked",
        payload: {
          kind: "command_approval",
          itemId: "item-blocked",
          reason: "Approve command",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (pending.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${pending.reason}`);
      }

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "Try to send" }],
          }),
        },
      );
      expect(sendResponse.status).toBe(409);
      await expect(readJson(sendResponse)).resolves.toEqual({
        code: "awaiting_user_interaction",
        message: "Thread is awaiting user interaction. Resolve the pending interaction before sending another prompt.",
      });

      const draftSendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(draftSendResponse.status).toBe(409);
      await expect(readJson(draftSendResponse)).resolves.toEqual({
        code: "awaiting_user_interaction",
        message: "Thread is awaiting user interaction. Resolve the pending interaction before sending another prompt.",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues turn commands with the resolved permission mode", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-permission-mode",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/permission-mode-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-permission-mode",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "Run the command" }],
          }),
        },
      );
      expect(response.status).toBe(200);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" &&
          command.threadId === thread.id,
      );
      expect(queued.command.options).toMatchObject({
        permissionMode: "full",
        permissionEscalation: null,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("resolves file-change interactions through thread routes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-extra-interactions",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const fileChange = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-file-change",
        providerId: "codex",
        providerThreadId: "provider-thread-file-change",
        providerRequestId: "request-file-change",
        payload: {
          kind: "file_change_approval",
          itemId: "item-file-change",
          reason: "Approve file changes",
          grantRoot: "/tmp/project",
        },
      });
      if (fileChange.outcome === "rejected") {
        throw new Error(`Expected file-change interaction registration to succeed: ${fileChange.reason}`);
      }

      const fileChangeResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${fileChange.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "file_change_approval",
            decision: "accept_for_session",
          }),
        },
      );
      expect(fileChangeResponse.status).toBe(200);
      await expect(readJson(fileChangeResponse)).resolves.toMatchObject({
        id: fileChange.interaction.id,
        status: "resolved",
        resolution: {
          kind: "file_change_approval",
          decision: "accept_for_session",
        },
      });

    } finally {
      await harness.cleanup();
    }
  });

  it("projects pending-interaction lifecycle updates into the thread timeline", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-interaction-timeline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const registered = registerPendingInteraction(harness.deps.pendingInteractions, {
        threadId: thread.id,
        turnId: "turn-timeline",
        providerId: "codex",
        providerThreadId: "provider-thread-timeline",
        providerRequestId: "request-timeline",
        payload: {
          kind: "command_approval",
          itemId: "item-timeline",
          reason: "Approve command",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${registered.reason}`);
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
        resolution: {
          kind: "command_approval",
          decision: "accept_for_session",
        },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({
              kind: "message",
              message: expect.objectContaining({
                kind: "operation",
                opType: "operation",
                status: "completed",
                threadOperation: expect.objectContaining({
                  rawOperation: "command_approval",
                  operationId: registered.interaction.id,
                }),
                detail: expect.stringContaining("Command approved for this session"),
              }),
            }),
          ]),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });
});
