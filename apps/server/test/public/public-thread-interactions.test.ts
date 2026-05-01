import { createDraft } from "@bb/db";
import { turnScope } from "@bb/domain";
import type { PendingInteractionCreate } from "@bb/domain";
import { describe, expect, it } from "vitest";
import type { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import { readJson } from "../helpers/json.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  createAllowForSessionResolution,
  createAllowOnceResolution,
  createCommandApprovalPayload,
  createDenyResolution,
  createFileChangeApprovalPayload,
  createPermissionGrantApprovalPayload,
} from "../helpers/pending-interactions.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { appendThreadEvent } from "../../src/services/threads/thread-events.js";

function registerPendingInteraction(
  lifecycle: PendingInteractionLifecycle,
  interaction: PendingInteractionCreate,
  sessionId: string,
) {
  return lifecycle.registerPendingInteraction({
    interaction,
    sessionId,
  });
}

describe("public thread interaction routes", () => {
  it("lists, gets, and resolves thread-owned interactions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
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

      const registered = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-public-1",
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          providerRequestId: "request-1",
          payload: createCommandApprovalPayload({
            itemId: "item-1",
            reason: "Approve command",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
        session.id,
      );
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
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
            subject: {
              kind: "command",
              command: "git push",
            },
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
          body: JSON.stringify(createAllowOnceResolution()),
        },
      );
      expect(resolveResponse.status).toBe(200);
      await expect(readJson(resolveResponse)).resolves.toMatchObject({
        id: registered.interaction.id,
        status: "resolving",
        resolution: createAllowOnceResolution(),
      });

      const duplicateResolveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${registered.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(createAllowOnceResolution()),
        },
      );
      expect(duplicateResolveResponse.status).toBe(200);
      await expect(readJson(duplicateResolveResponse)).resolves.toMatchObject({
        id: registered.interaction.id,
        status: "resolving",
        resolution: createAllowOnceResolution(),
      });

      const conflictingResolveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${registered.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(createDenyResolution()),
        },
      );
      expect(conflictingResolveResponse.status).toBe(409);
      await expect(readJson(conflictingResolveResponse)).resolves.toEqual({
        code: "invalid_request",
        message: `Pending interaction ${registered.interaction.id} is already resolving`,
      });

      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === registered.interaction.id,
      );
      const commandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(commandResultResponse.status).toBe(200);

      const postResolveListResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions`,
      );
      expect(postResolveListResponse.status).toBe(200);
      await expect(readJson(postResolveListResponse)).resolves.toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unavailable command decisions and malformed provider-specific resolutions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
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

      const commandApproval = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-invalid-command-resolution",
          providerId: "codex",
          providerThreadId: "provider-thread-invalid-command-resolution",
          providerRequestId: "request-invalid-command-resolution",
          payload: createCommandApprovalPayload({
            itemId: "item-invalid-command-resolution",
            reason: "Approve command",
            command: "git push",
            cwd: "/tmp/project",
            availableDecisions: ["allow_once", "deny"],
          }),
        },
        session.id,
      );
      if (commandApproval.outcome === "rejected") {
        throw new Error(
          `Expected command interaction registration to succeed: ${commandApproval.reason}`,
        );
      }

      const invalidCommandResolution = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${commandApproval.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(createAllowForSessionResolution()),
        },
      );
      expect(invalidCommandResolution.status).toBe(400);
      await expect(readJson(invalidCommandResolution)).resolves.toEqual({
        code: "invalid_request",
        message: `Approval decision 'allow_for_session' is not available for interaction ${commandApproval.interaction.id}`,
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
        message:
          "Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'",
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
            decision: "allow_once",
            grantedPermissions: null,
          }),
        },
      );
      expect(interruptedResolution.status).toBe(409);
      await expect(readJson(interruptedResolution)).resolves.toEqual({
        code: "invalid_request",
        message: `Pending interaction ${commandApproval.interaction.id} is already interrupted`,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("resolves permission requests and rejects grants outside the requested scope", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
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

      const permissionRequest = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-permission-resolution",
          providerId: "codex",
          providerThreadId: "provider-thread-permission-resolution",
          providerRequestId: "request-permission-resolution",
          payload: createPermissionGrantApprovalPayload({
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
          }),
        },
        session.id,
      );
      if (permissionRequest.outcome === "rejected") {
        throw new Error(
          `Expected permission interaction registration to succeed: ${permissionRequest.reason}`,
        );
      }

      const grantResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${permissionRequest.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createAllowForSessionResolution({
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/project/README.md"],
                write: [],
              },
            }),
          ),
        },
      );
      expect(grantResponse.status).toBe(200);
      await expect(readJson(grantResponse)).resolves.toMatchObject({
        id: permissionRequest.interaction.id,
        status: "resolving",
        resolution: createAllowForSessionResolution({
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/project/README.md"],
            write: [],
          },
        }),
      });
      const grantCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === permissionRequest.interaction.id,
      );
      const grantCommandResponse = await reportQueuedCommandSuccess(
        harness,
        grantCommand,
        {},
      );
      expect(grantCommandResponse.status).toBe(200);

      const deniedPermissionRequest = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-permission-resolution-denied",
          providerId: "codex",
          providerThreadId: "provider-thread-permission-resolution",
          providerRequestId: "request-permission-resolution-denied",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-permission-resolution-denied",
            reason: "Grant network access",
            toolName: null,
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
        session.id,
      );
      if (deniedPermissionRequest.outcome === "rejected") {
        throw new Error(
          `Expected permission interaction registration to succeed: ${deniedPermissionRequest.reason}`,
        );
      }

      const denyResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${deniedPermissionRequest.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(createDenyResolution()),
        },
      );
      expect(denyResponse.status).toBe(200);
      await expect(readJson(denyResponse)).resolves.toMatchObject({
        id: deniedPermissionRequest.interaction.id,
        status: "resolving",
        resolution: createDenyResolution(),
      });
      const denyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === deniedPermissionRequest.interaction.id,
      );
      const denyCommandResponse = await reportQueuedCommandSuccess(
        harness,
        denyCommand,
        {},
      );
      expect(denyCommandResponse.status).toBe(200);

      const invalidPermissionRequest = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-permission-resolution-invalid",
          providerId: "codex",
          providerThreadId: "provider-thread-permission-resolution",
          providerRequestId: "request-permission-resolution-invalid",
          payload: createPermissionGrantApprovalPayload({
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
          }),
        },
        session.id,
      );
      if (invalidPermissionRequest.outcome === "rejected") {
        throw new Error(
          `Expected permission interaction registration to succeed: ${invalidPermissionRequest.reason}`,
        );
      }

      const invalidGrantResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${invalidPermissionRequest.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            decision: "allow_once",
            grantedPermissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/project/README.md"],
                write: [],
              },
            },
          }),
        },
      );
      expect(invalidGrantResponse.status).toBe(400);
      await expect(readJson(invalidGrantResponse)).resolves.toEqual({
        code: "invalid_request",
        message:
          "Granted network permissions must be a subset of the requested permissions",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects provider-specific command approval amendment resolutions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
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

      const commandApproval = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-amendment-resolution",
          providerId: "codex",
          providerThreadId: "provider-thread-amendment-resolution",
          providerRequestId: "request-amendment-resolution",
          payload: createCommandApprovalPayload({
            itemId: "item-amendment-resolution",
            reason: "Approve command",
            command: "git push",
            cwd: "/tmp/project",
            availableDecisions: ["allow_once", "deny"],
          }),
        },
        session.id,
      );
      if (commandApproval.outcome === "rejected") {
        throw new Error(
          `Expected command interaction registration to succeed: ${commandApproval.reason}`,
        );
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
      expect(resolveResponse.status).toBe(400);
      await expect(readJson(resolveResponse)).resolves.toEqual({
        code: "invalid_request",
        message:
          "Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects send and draft-send while a thread awaits user interaction", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
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
      const pending = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-blocked-send",
          providerId: "codex",
          providerThreadId: "provider-thread-blocked",
          providerRequestId: "request-blocked",
          payload: createCommandApprovalPayload({
            itemId: "item-blocked",
            reason: "Approve command",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
        session.id,
      );
      if (pending.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${pending.reason}`,
        );
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
        message:
          "Thread is awaiting user interaction. Resolve the pending interaction before sending another prompt.",
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
        message:
          "Thread is awaiting user interaction. Resolve the pending interaction before sending another prompt.",
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
          command.type === "turn.submit" && command.threadId === thread.id,
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
      const { host, session } = seedHostSession(harness.deps, {
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

      const fileChange = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-file-change",
          providerId: "codex",
          providerThreadId: "provider-thread-file-change",
          providerRequestId: "request-file-change",
          payload: createFileChangeApprovalPayload({
            itemId: "item-file-change",
            reason: "Approve file changes",
          }),
        },
        session.id,
      );
      if (fileChange.outcome === "rejected") {
        throw new Error(
          `Expected file-change interaction registration to succeed: ${fileChange.reason}`,
        );
      }

      const fileChangeResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${fileChange.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(createAllowOnceResolution()),
        },
      );
      expect(fileChangeResponse.status).toBe(200);
      await expect(readJson(fileChangeResponse)).resolves.toMatchObject({
        id: fileChange.interaction.id,
        status: "resolving",
        resolution: createAllowOnceResolution(),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("projects pending-interaction lifecycle updates into the thread timeline", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
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
        status: "active",
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "turn/started",
        providerThreadId: "provider-thread-timeline",
        turnId: "turn-timeline",
        scope: turnScope("turn-timeline"),
        data: {
          providerThreadId: "provider-thread-timeline",
          turnId: "turn-timeline",
        },
      });

      const registered = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-timeline",
          providerId: "codex",
          providerThreadId: "provider-thread-timeline",
          providerRequestId: "request-timeline",
          payload: createCommandApprovalPayload({
            itemId: "item-timeline",
            reason: "Approve command",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
        session.id,
      );
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
        resolution: createAllowOnceResolution(),
      });
      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === registered.interaction.id,
      );
      const commandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(commandResultResponse.status).toBe(200);

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({
              kind: "work",
              workKind: "command",
              callId: "item-timeline",
              command: "git push",
              cwd: "/tmp/project",
              status: "pending",
              approvalStatus: "waiting_for_approval",
            }),
          ]),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("projects denied command approvals into target-specific timeline rows", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-public-thread-interaction-denied-timeline",
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
        status: "active",
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "turn/started",
        providerThreadId: "provider-thread-denied-timeline",
        turnId: "turn-denied-timeline",
        scope: turnScope("turn-denied-timeline"),
        data: {
          providerThreadId: "provider-thread-denied-timeline",
          turnId: "turn-denied-timeline",
        },
      });

      const registered = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-denied-timeline",
          providerId: "codex",
          providerThreadId: "provider-thread-denied-timeline",
          providerRequestId: "request-denied-timeline",
          payload: createCommandApprovalPayload({
            itemId: "item-denied-timeline",
            reason: "Approve command",
            command: "rm -rf build",
            cwd: "/tmp/project",
          }),
        },
        session.id,
      );
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
        resolution: createDenyResolution(),
      });
      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === registered.interaction.id,
      );
      const commandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(commandResultResponse.status).toBe(200);

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({
              kind: "work",
              workKind: "command",
              callId: "item-denied-timeline",
              command: "rm -rf build",
              cwd: "/tmp/project",
              status: "interrupted",
              approvalStatus: "denied",
            }),
          ]),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("projects file-change approvals into item-specific timeline rows without diffs", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-public-thread-interaction-file-timeline",
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
        status: "active",
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "turn/started",
        providerThreadId: "provider-thread-file-timeline",
        turnId: "turn-file-timeline",
        scope: turnScope("turn-file-timeline"),
        data: {
          providerThreadId: "provider-thread-file-timeline",
          turnId: "turn-file-timeline",
        },
      });

      const registered = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-file-timeline",
          providerId: "codex",
          providerThreadId: "provider-thread-file-timeline",
          providerRequestId: "request-file-timeline",
          payload: createFileChangeApprovalPayload({
            itemId: "item-file-timeline",
            reason: "Approve file edits",
            writeScope: "/tmp/project",
          }),
        },
        session.id,
      );
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
      }

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({
              kind: "work",
              workKind: "approval",
              interactionId: "item-file-timeline",
              status: "pending",
            }),
          ]),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("projects permission-grant approvals into typed lifecycle timeline rows", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-public-thread-interaction-permission-timeline",
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
        status: "active",
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "turn/started",
        providerThreadId: "provider-thread-permission-timeline",
        turnId: "turn-permission-timeline",
        scope: turnScope("turn-permission-timeline"),
        data: {
          providerThreadId: "provider-thread-permission-timeline",
          turnId: "turn-permission-timeline",
        },
      });

      const registered = registerPendingInteraction(
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-permission-timeline",
          providerId: "codex",
          providerThreadId: "provider-thread-permission-timeline",
          providerRequestId: "request-permission-timeline",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-permission-timeline",
            reason: "Need network access",
            toolName: "Bash",
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
        session.id,
      );
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
      }

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({
              kind: "work",
              workKind: "approval",
              title: "Waiting for approval to grant Bash",
              status: "pending",
              target: {
                itemId: "item-permission-timeline",
                toolName: "Bash",
              },
            }),
          ]),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });
});
