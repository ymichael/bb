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
});
