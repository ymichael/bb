import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  PendingInteractionLifecycle,
} from "../../src/services/interactions/pending-interactions.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("pending interaction lifecycle", () => {
  it("interrupts waits that start with an already-aborted signal", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-aborted-signal",
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
        turnId: "turn-aborted-signal",
        providerId: "codex",
        providerThreadId: "provider-thread-aborted-signal",
        providerRequestId: "request-aborted-signal",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-aborted-signal",
          approvalId: null,
          reason: "Needs approval",
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

      const controller = new AbortController();
      controller.abort();

      await expect(
        harness.deps.pendingInteractions.waitForTerminalState({
          interactionId: registered.interaction.id,
          signal: controller.signal,
          abortReason: "Request aborted",
        }),
      ).resolves.toMatchObject({
        outcome: "interrupted",
        reason: "Request aborted",
        interaction: expect.objectContaining({
          id: registered.interaction.id,
          status: "interrupted",
          statusReason: "Request aborted",
        }),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects reused provider request ids after the original interaction is terminal", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-terminal-dedupe",
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

      const created = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-terminal-dedupe-1",
        providerId: "codex",
        providerThreadId: "provider-thread-terminal-dedupe",
        providerRequestId: "request-terminal-dedupe",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-terminal-dedupe-1",
          approvalId: null,
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (created.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${created.reason}`);
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: {
          kind: "command_approval",
          decision: "accept_for_session",
        },
      });

      expect(
        harness.deps.pendingInteractions.registerPendingInteraction({
          threadId: thread.id,
          turnId: "turn-terminal-dedupe-2",
          providerId: "codex",
          providerThreadId: "provider-thread-terminal-dedupe",
          providerRequestId: "request-terminal-dedupe",
          providerRequestMethod: "item/commandExecution/requestApproval",
          payload: {
            kind: "command_approval",
            itemId: "item-terminal-dedupe-2",
            approvalId: null,
            reason: "Needs approval again",
            command: "git push",
            cwd: "/tmp/project",
            commandActions: [],
            requestedPermissions: null,
            availableDecisions: ["accept", "decline", "cancel"],
          },
        }),
      ).toEqual({
        outcome: "rejected",
        reason:
          "Provider request request-terminal-dedupe was already handled and cannot be reused",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects user-input requests when the thread question policy is deny", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-question-policy-deny",
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
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-question-policy-deny",
        questionPolicy: "deny",
      });

      expect(
        harness.deps.pendingInteractions.registerPendingInteraction({
          threadId: thread.id,
          turnId: "turn-question-policy-deny",
          providerId: "codex",
          providerThreadId: "provider-thread-question-policy-deny",
          providerRequestId: "request-question-policy-deny",
          providerRequestMethod: "item/tool/requestUserInput",
          payload: {
            kind: "user_input_request",
            itemId: "item-question-policy-deny",
            questions: [
              {
                id: "environment",
                header: "Env",
                question: "Which environment?",
                allowsOther: true,
                isSecret: false,
                options: [],
              },
            ],
          },
        }),
      ).toEqual({
        outcome: "rejected",
        reason: "Thread question policy denies user-input requests",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("expires pending waits that are never resolved", async () => {
    const harness = await createTestAppHarness();
    try {
      const pendingInteractions = new PendingInteractionLifecycle({
        db: harness.db,
        hub: harness.hub,
        sandboxInteractionExpiryMs: 20,
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-expiry",
        type: "ephemeral",
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

      const created = pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-expiry",
        providerId: "codex",
        providerThreadId: "provider-thread-expiry",
        providerRequestId: "request-expiry",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-expiry",
          approvalId: null,
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (created.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${created.reason}`);
      }

      const outcomePromise = pendingInteractions.waitForTerminalState({
        interactionId: created.interaction.id,
      });
      await sleep(50);

      await expect(outcomePromise).resolves.toMatchObject({
        outcome: "expired",
        reason: "Pending interaction expired while waiting for a user response",
        interaction: expect.objectContaining({
          id: created.interaction.id,
          status: "expired",
          statusReason: "Pending interaction expired while waiting for a user response",
        }),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not expire pending interactions on persistent hosts", async () => {
    const harness = await createTestAppHarness();
    try {
      const pendingInteractions = new PendingInteractionLifecycle({
        db: harness.db,
        hub: harness.hub,
        sandboxInteractionExpiryMs: 20,
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-no-expiry",
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

      const created = pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-no-expiry",
        providerId: "codex",
        providerThreadId: "provider-thread-no-expiry",
        providerRequestId: "request-no-expiry",
        providerRequestMethod: "item/commandExecution/requestApproval",
        payload: {
          kind: "command_approval",
          itemId: "item-no-expiry",
          approvalId: null,
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (created.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${created.reason}`);
      }

      await sleep(50);

      expect(
        pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }).status,
      ).toBe("pending");
    } finally {
      await harness.cleanup();
    }
  });
});
