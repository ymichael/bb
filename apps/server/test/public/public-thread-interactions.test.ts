import { createDraft } from "@bb/db";
import { describe, expect, it } from "vitest";
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

      const registered = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-public-1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        providerRequestId: "request-1",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-1",
          approvalId: null,
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
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unavailable command decisions and invalid user-input answers", async () => {
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
      const secondThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const commandApproval = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-invalid-command-resolution",
        providerId: "codex",
        providerThreadId: "provider-thread-invalid-command-resolution",
        providerRequestId: "request-invalid-command-resolution",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-invalid-command-resolution",
          approvalId: null,
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
            kind: "user_input_request",
            answers: {
              environment: ["staging"],
            },
          }),
        },
      );
      expect(mismatchedKindResponse.status).toBe(400);
      await expect(readJson(mismatchedKindResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Pending interaction resolution kind does not match the interaction payload",
      });

      const userInput = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: secondThread.id,
        turnId: "turn-invalid-user-input-resolution",
        providerId: "codex",
        providerThreadId: "provider-thread-invalid-user-input-resolution",
        providerRequestId: "request-invalid-user-input-resolution",
        providerRequestMethod: "item/tool/requestUserInput",
        payload: {
          kind: "user_input_request",
          itemId: "item-invalid-user-input-resolution",
          questions: [
            {
              id: "environment",
              header: "Env",
              question: "Which environment?",
              allowsOther: false,
              isSecret: false,
              multiSelect: false,
              options: [
                { label: "staging", description: "Use staging", preview: null },
                { label: "prod", description: "Use production", preview: null },
              ],
            },
            {
              id: "ticket",
              header: "Ticket",
              question: "Which ticket?",
              allowsOther: true,
              isSecret: false,
              multiSelect: false,
              options: [],
            },
          ],
        },
      });
      if (userInput.outcome === "rejected") {
        throw new Error(`Expected user-input interaction registration to succeed: ${userInput.reason}`);
      }

      const missingAnswerResponse = await harness.app.request(
        `/api/v1/threads/${secondThread.id}/interactions/${userInput.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "user_input_request",
            answers: {
              environment: ["staging"],
            },
          }),
        },
      );
      expect(missingAnswerResponse.status).toBe(400);
      await expect(readJson(missingAnswerResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Missing answers for question ids: ticket",
      });

      const unknownQuestionResponse = await harness.app.request(
        `/api/v1/threads/${secondThread.id}/interactions/${userInput.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "user_input_request",
            answers: {
              environment: ["staging"],
              ticket: ["OPS-123"],
              extra: ["unexpected"],
            },
          }),
        },
      );
      expect(unknownQuestionResponse.status).toBe(400);
      await expect(readJson(unknownQuestionResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Unknown question ids: extra",
      });

      const emptyAnswerResponse = await harness.app.request(
        `/api/v1/threads/${secondThread.id}/interactions/${userInput.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "user_input_request",
            answers: {
              environment: ["staging"],
              ticket: [],
            },
          }),
        },
      );
      expect(emptyAnswerResponse.status).toBe(400);
      await expect(readJson(emptyAnswerResponse)).resolves.toEqual({
        code: "invalid_request",
        message: "Question 'ticket' requires at least one answer",
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

      const permissionRequest = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-permission-resolution",
        providerId: "codex",
        providerThreadId: "provider-thread-permission-resolution",
        providerRequestId: "request-permission-resolution",
        providerRequestMethod: "item/permissions/requestApproval",
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
            macos: null,
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

      const deniedPermissionRequest = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-permission-resolution-denied",
        providerId: "codex",
        providerThreadId: "provider-thread-permission-resolution",
        providerRequestId: "request-permission-resolution-denied",
        providerRequestMethod: "item/permissions/requestApproval",
        payload: {
          kind: "permission_request",
          itemId: "item-permission-resolution-denied",
          reason: "Grant network access",
          toolName: null,
          permissions: {
            network: { enabled: true },
            fileSystem: null,
            macos: null,
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
            permissions: {
              network: null,
              fileSystem: null,
            },
            scope: "turn",
          }),
        },
      );
      expect(denyResponse.status).toBe(200);
      await expect(readJson(denyResponse)).resolves.toMatchObject({
        id: deniedPermissionRequest.interaction.id,
        status: "resolved",
        resolution: {
          kind: "permission_request",
          permissions: {
            network: null,
            fileSystem: null,
          },
          scope: "turn",
        },
      });

      const invalidPermissionRequest = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-permission-resolution-invalid",
        providerId: "codex",
        providerThreadId: "provider-thread-permission-resolution",
        providerRequestId: "request-permission-resolution-invalid",
        providerRequestMethod: "item/permissions/requestApproval",
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
            macos: null,
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

      const commandApproval = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-amendment-resolution",
        providerId: "codex",
        providerThreadId: "provider-thread-amendment-resolution",
        providerRequestId: "request-amendment-resolution",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-amendment-resolution",
          approvalId: null,
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
        sandboxMode: "danger-full-access",
      });
      const pending = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-blocked-send",
        providerId: "codex",
        providerThreadId: "provider-thread-blocked",
        providerRequestId: "request-blocked",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-blocked",
          approvalId: null,
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

  it("queues Codex turn commands with on-request approval policy", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-public-thread-approval-policy",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/approval-policy-project",
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
        providerThreadId: "provider-thread-approval",
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
        approvalPolicy: "on-request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("resolves file-change and user-input interactions through thread routes", async () => {
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

      const fileChange = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-file-change",
        providerId: "codex",
        providerThreadId: "provider-thread-file-change",
        providerRequestId: "request-file-change",
        providerRequestMethod: "item/fileChange/requestApproval",
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

      const userInput = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-user-input",
        providerId: "codex",
        providerThreadId: "provider-thread-user-input",
        providerRequestId: "request-user-input",
        providerRequestMethod: "item/tool/requestUserInput",
        payload: {
          kind: "user_input_request",
          itemId: "item-user-input",
          questions: [
            {
              id: "environment",
              header: "Env",
              question: "Which environment?",
              allowsOther: false,
              isSecret: false,
              multiSelect: false,
              options: [
                { label: "staging", description: "Use staging", preview: null },
                { label: "prod", description: "Use production", preview: null },
              ],
            },
            {
              id: "ticket",
              header: "Ticket",
              question: "Which ticket?",
              allowsOther: true,
              isSecret: false,
              multiSelect: false,
              options: [],
            },
          ],
        },
      });
      if (userInput.outcome === "rejected") {
        throw new Error(`Expected user-input interaction registration to succeed: ${userInput.reason}`);
      }

      const userInputResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/interactions/${userInput.interaction.id}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "user_input_request",
            answers: {
              environment: ["staging"],
              ticket: ["OPS-123"],
            },
          }),
        },
      );
      expect(userInputResponse.status).toBe(200);
      await expect(readJson(userInputResponse)).resolves.toMatchObject({
        id: userInput.interaction.id,
        status: "resolved",
        resolution: {
          kind: "user_input_request",
          answers: {
            environment: ["staging"],
            ticket: ["OPS-123"],
          },
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

      const registered = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-timeline",
        providerId: "codex",
        providerThreadId: "provider-thread-timeline",
        providerRequestId: "request-timeline",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-timeline",
          approvalId: null,
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
