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
        payload: {
          kind: "command_approval",
          itemId: "item-aborted-signal",
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
        payload: {
          kind: "command_approval",
          itemId: "item-terminal-dedupe-1",
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
          payload: {
            kind: "command_approval",
            itemId: "item-terminal-dedupe-2",
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

  it("rejects interactions from providers that do not own the thread", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-provider-mismatch",
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
        providerId: "codex",
      });

      expect(
        harness.deps.pendingInteractions.registerPendingInteraction({
          threadId: thread.id,
          turnId: "turn-provider-mismatch",
          providerId: "claude-code",
          providerThreadId: "provider-thread-provider-mismatch",
          providerRequestId: "request-provider-mismatch",
          payload: {
            kind: "command_approval",
            itemId: "item-provider-mismatch",
            reason: "Needs approval",
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
          `Thread ${thread.id} belongs to provider codex, not claude-code`,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("treats reordered permission grants as idempotent resolution retries", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-idempotent-permissions",
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
        turnId: "turn-idempotent-permissions",
        providerId: "codex",
        providerThreadId: "provider-thread-idempotent-permissions",
        providerRequestId: "request-idempotent-permissions",
        payload: {
          kind: "permission_request",
          itemId: "item-idempotent-permissions",
          reason: "Needs workspace access",
          toolName: "Bash",
          permissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project/a", "/tmp/project/b"],
              write: ["/tmp/project/c", "/tmp/project/d"],
            },
          },
        },
      });
      if (created.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${created.reason}`);
      }

      const firstResolution = harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: {
          kind: "permission_request",
          decision: "allow",
          permissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project/a", "/tmp/project/b"],
              write: ["/tmp/project/c", "/tmp/project/d"],
            },
          },
          scope: "turn",
        },
      });
      expect(firstResolution.status).toBe("resolved");

      const retryResolution = harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: {
          kind: "permission_request",
          decision: "allow",
          permissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project/b", "/tmp/project/a"],
              write: ["/tmp/project/d", "/tmp/project/c"],
            },
          },
          scope: "turn",
        },
      });

      expect(retryResolution).toMatchObject({
        id: created.interaction.id,
        status: "resolved",
        resolution: firstResolution.resolution,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("resolves waiters when an interaction reaches a terminal state", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-wait-resolve",
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
        turnId: "turn-wait-resolve",
        providerId: "codex",
        providerThreadId: "provider-thread-wait-resolve",
        providerRequestId: "request-wait-resolve",
        payload: {
          kind: "command_approval",
          itemId: "item-wait-resolve",
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

      const outcomePromise = harness.deps.pendingInteractions.waitForTerminalState({
        interactionId: created.interaction.id,
      });
      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: {
          kind: "command_approval",
          decision: "accept",
        },
      });

      await expect(outcomePromise).resolves.toMatchObject({
        outcome: "resolved",
        interaction: expect.objectContaining({
          id: created.interaction.id,
          status: "resolved",
          resolution: {
            kind: "command_approval",
            decision: "accept",
          },
        }),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a second active interaction on the same thread", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-concurrent-reject",
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
        turnId: "turn-concurrent-reject-1",
        providerId: "codex",
        providerThreadId: "provider-thread-concurrent-reject",
        providerRequestId: "request-concurrent-reject-1",
        payload: {
          kind: "command_approval",
          itemId: "item-concurrent-reject-1",
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

      expect(
        harness.deps.pendingInteractions.registerPendingInteraction({
          threadId: thread.id,
          turnId: "turn-concurrent-reject-2",
          providerId: "codex",
          providerThreadId: "provider-thread-concurrent-reject",
          providerRequestId: "request-concurrent-reject-2",
          payload: {
            kind: "file_change_approval",
            itemId: "item-concurrent-reject-2",
            reason: "Needs file write approval",
            grantRoot: "/tmp/project",
          },
        }),
      ).toEqual({
        outcome: "rejected",
        reason: `Thread ${thread.id} is already awaiting user interaction`,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects command approvals with no available decisions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-empty-decisions",
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

      expect(
        harness.deps.pendingInteractions.registerPendingInteraction({
          threadId: thread.id,
          turnId: "turn-empty-decisions",
          providerId: "codex",
          providerThreadId: "provider-thread-empty-decisions",
          providerRequestId: "request-empty-decisions",
          payload: {
            kind: "command_approval",
            itemId: "item-empty-decisions",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
            commandActions: [],
            requestedPermissions: null,
            availableDecisions: [],
          },
        }),
      ).toEqual({
        outcome: "rejected",
        reason: "Command approvals must include at least one available decision",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects resolving interrupted interactions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-resolve-interrupted",
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
        turnId: "turn-resolve-interrupted",
        providerId: "codex",
        providerThreadId: "provider-thread-resolve-interrupted",
        providerRequestId: "request-resolve-interrupted",
        payload: {
          kind: "command_approval",
          itemId: "item-resolve-interrupted",
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

      harness.deps.pendingInteractions.interruptPendingInteraction({
        interactionId: created.interaction.id,
        reason: "Provider exited",
      });

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: {
            kind: "command_approval",
            decision: "accept",
          },
        })
      ).toThrowError(
        `Pending interaction ${created.interaction.id} is already interrupted`,
      );
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
        payload: {
          kind: "command_approval",
          itemId: "item-expiry",
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

  it("hydrates pending interactions on ephemeral hosts and expires them after restart", async () => {
    const harness = await createTestAppHarness();
    try {
      const originalLifecycle = new PendingInteractionLifecycle({
        db: harness.db,
        hub: harness.hub,
        sandboxInteractionExpiryMs: 60_000,
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-hydrate-expiry",
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

      const created = originalLifecycle.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-hydrate-expiry",
        providerId: "codex",
        providerThreadId: "provider-thread-hydrate-expiry",
        providerRequestId: "request-hydrate-expiry",
        payload: {
          kind: "command_approval",
          itemId: "item-hydrate-expiry",
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

      const restartedLifecycle = new PendingInteractionLifecycle({
        db: harness.db,
        hub: harness.hub,
        sandboxInteractionExpiryMs: 20,
      });
      await sleep(50);

      expect(
        restartedLifecycle.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }),
      ).toMatchObject({
        id: created.interaction.id,
        status: "expired",
        statusReason: "Pending interaction expired while waiting for a user response",
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
        payload: {
          kind: "command_approval",
          itemId: "item-no-expiry",
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
