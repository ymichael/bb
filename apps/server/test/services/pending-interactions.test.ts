import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  events as eventTable,
  pendingInteractions as pendingInteractionTable,
} from "@bb/db";
import type { PendingInteractionCreate } from "@bb/domain";
import { handleHostSessionOpened } from "../../src/internal/session-owner-side-effects.js";
import { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import type { AppDeps } from "../../src/types.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedSession,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createAllowForSessionResolution,
  createAllowOnceResolution,
  createCommandApprovalPayload,
  createDenyResolution,
  createFileChangeApprovalPayload,
  createPermissionGrantApprovalPayload,
  createToolUseApprovalPayload,
  createUserAnswerResolution,
  createUserQuestionPayload,
} from "../helpers/pending-interactions.js";
import { withTestHarness } from "../helpers/test-app.js";

function registerPendingInteraction(
  deps: Pick<AppDeps, "db" | "hub">,
  lifecycle: PendingInteractionLifecycle,
  interaction: PendingInteractionCreate,
) {
  seedTurnStarted(deps, {
    threadId: interaction.threadId,
    turnId: interaction.turnId,
    providerThreadId: interaction.providerThreadId,
  });
  return lifecycle.registerPendingInteraction({
    interaction,
  });
}

function seedPluginInteractionThread(deps: AppDeps, suffix: string) {
  const { host } = seedHostSession(deps, {
    id: `host-plugin-interaction-${suffix}`,
  });
  const { project } = seedProjectWithSource(deps, { hostId: host.id });
  const environment = seedEnvironment(deps, {
    hostId: host.id,
    projectId: project.id,
  });
  return seedThread(deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
}

function requestPluginInteraction(
  deps: AppDeps,
  args: {
    threadId: string;
    name?: string;
    signal?: AbortSignal;
  },
) {
  return deps.pendingInteractions.requestPluginInteraction({
    pluginId: "secrets",
    threadId: args.threadId,
    rendererId: "secret-request",
    title: "Add secrets",
    payload: { fields: [{ name: args.name ?? "API_KEY" }] },
    timeoutMs: 10_000,
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

describe("pending interaction lifecycle", () => {
  it("returns a plugin response only through memory and persists metadata only", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "memory-only");
      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
      });
      const [interaction] =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
      expect(interaction?.payload.kind).toBe("plugin");

      harness.deps.pendingInteractions.respondToPluginInteraction({
        threadId: thread.id,
        interactionId: interaction!.id,
        value: { values: { API_KEY: "sentinel-secret-value" } },
      });

      await expect(pending).resolves.toEqual({
        outcome: "submitted",
        value: { values: { API_KEY: "sentinel-secret-value" } },
      });
      const [stored] = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, interaction!.id))
        .all();
      expect(JSON.stringify(stored)).not.toContain("sentinel-secret-value");
      expect(stored?.resolution).toBe('{"kind":"plugin_submitted"}');
      expect(
        JSON.stringify(harness.db.select().from(eventTable).all()),
      ).not.toContain("sentinel-secret-value");
    });
  });

  it("delivers a plugin response before terminal side effects run", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "delivery");
      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
      });
      const [interaction] =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
      vi.spyOn(harness.hub, "notifyThread").mockImplementationOnce(() => {
        throw new Error("timeline notification failed");
      });

      expect(
        harness.deps.pendingInteractions.respondToPluginInteraction({
          threadId: thread.id,
          interactionId: interaction!.id,
          value: { values: { API_KEY: "sentinel-secret-value" } },
        }),
      ).toMatchObject({ status: "resolved" });
      await expect(pending).resolves.toEqual({
        outcome: "submitted",
        value: { values: { API_KEY: "sentinel-secret-value" } },
      });
    });
  });

  it("contains abort callback failures and settles the in-memory waiter", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "abort");
      const controller = new AbortController();
      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
        signal: controller.signal,
      });
      vi.spyOn(
        harness.deps.pendingInteractions,
        "cancelPluginInteraction",
      ).mockImplementation(() => {
        throw new Error("cancellation failed");
      });

      expect(() => controller.abort()).not.toThrow();
      await expect(pending).resolves.toEqual({
        outcome: "cancelled",
        reason: "request-aborted",
      });
    });
  });

  it("interrupts a plugin interaction when its creation side effects fail", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "setup-failure");
      vi.spyOn(harness.hub, "notifyThread").mockImplementationOnce(() => {
        throw new Error("timeline notification failed");
      });

      await expect(
        Promise.resolve().then(() =>
          requestPluginInteraction(harness.deps, {
            threadId: thread.id,
          }),
        ),
      ).rejects.toThrow("timeline notification failed");
      expect(
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        ),
      ).toEqual([]);
      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toMatchObject([{ status: "interrupted" }]);
    });
  });

  it("settles every plugin waiter before batch terminal side effects", async () => {
    await withTestHarness(async (harness) => {
      const firstThread = seedPluginInteractionThread(harness.deps, "batch-1");
      const secondThread = seedPluginInteractionThread(harness.deps, "batch-2");
      const first = requestPluginInteraction(harness.deps, {
        threadId: firstThread.id,
        name: "FIRST",
      });
      const second = requestPluginInteraction(harness.deps, {
        threadId: secondThread.id,
        name: "SECOND",
      });
      vi.spyOn(harness.hub, "notifyThread").mockImplementationOnce(() => {
        throw new Error("timeline notification failed");
      });

      expect(() =>
        harness.deps.pendingInteractions.interruptPluginInteractions("secrets"),
      ).toThrow("timeline notification failed");
      await expect(Promise.all([first, second])).resolves.toEqual([
        { outcome: "cancelled", reason: "plugin-disposed" },
        { outcome: "cancelled", reason: "plugin-disposed" },
      ]);
    });
  });

  it("includes project and pending state metadata in interaction change notifications", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-notification-metadata",
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
      const notifyThread = vi.spyOn(harness.hub, "notifyThread");

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-notification-metadata-1",
          providerId: "codex",
          providerThreadId: "provider-thread-notification-metadata",
          providerRequestId: "request-notification-metadata",
          payload: createCommandApprovalPayload({
            itemId: "item-notification-metadata-1",
            reason: "Needs approval",
            command: "git status",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["interactions-changed"],
        { hasPendingInteraction: true, projectId: project.id },
      );

      harness.deps.pendingInteractions.completeResolvingInteraction({
        interactionId: created.interaction.id,
        resolution: createAllowOnceResolution(),
      });

      expect(notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["interactions-changed"],
        { hasPendingInteraction: false, projectId: project.id },
      );
    });
  });

  it("skips corrupt rows when listing pending interactions", async () => {
    await withTestHarness(async (harness) => {
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };
      const lifecycle = new PendingInteractionLifecycle({
        config: harness.deps.config,
        db: harness.db,
        hub: harness.hub,
        lifecycleDedupers: harness.deps.lifecycleDedupers,
        logger,
        machineAuth: harness.deps.machineAuth,
        providerRegistry: harness.deps.providerRegistry,
        aiServices: harness.deps.aiServices,
        pluginHostArtifacts: harness.deps.pluginHostArtifacts,
        skillTreeRegistry: harness.deps.skillTreeRegistry,
        telemetry: harness.deps.telemetry,
        terminalSessions: harness.deps.terminalSessions,
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-corrupt-list",
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

      const corrupt = registerPendingInteraction(harness.deps, lifecycle, {
        threadId: thread.id,
        turnId: "turn-corrupt-list-1",
        providerId: "codex",
        providerThreadId: "provider-thread-corrupt-list",
        providerRequestId: "request-corrupt-list-1",
        payload: createCommandApprovalPayload({
          itemId: "item-corrupt-list-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
        }),
      });
      if (corrupt.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${corrupt.reason}`,
        );
      }

      harness.db
        .update(pendingInteractionTable)
        .set({
          status: "resolved",
          resolution: "{",
          resolvedAt: Date.now(),
        })
        .where(eq(pendingInteractionTable.id, corrupt.interaction.id))
        .run();

      const valid = registerPendingInteraction(harness.deps, lifecycle, {
        threadId: thread.id,
        turnId: "turn-corrupt-list-2",
        providerId: "codex",
        providerThreadId: "provider-thread-corrupt-list",
        providerRequestId: "request-corrupt-list-2",
        payload: createCommandApprovalPayload({
          itemId: "item-corrupt-list-2",
          reason: "Needs approval",
          command: "git status",
          cwd: "/tmp/project",
        }),
      });
      if (valid.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${valid.reason}`,
        );
      }

      expect(lifecycle.listThreadInteractions(thread.id)).toEqual([
        valid.interaction,
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          field: "resolution",
          interactionId: corrupt.interaction.id,
        }),
        "Skipping corrupt pending interaction row",
      );
      expect(() =>
        lifecycle.getThreadInteraction({
          threadId: thread.id,
          interactionId: corrupt.interaction.id,
        }),
      ).toThrow("Stored pending interaction resolution is invalid");
    });
  });

  it("resolves user-question interactions with user answers", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-user-question-answer",
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
        providerId: "claude-code",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-user-question-answer",
          providerId: "claude-code",
          providerThreadId: "provider-thread-user-question-answer",
          providerRequestId: "request-user-question-answer",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const answerResolution = createUserAnswerResolution({
        freeText: "Use staging until QA signs off.",
      });
      const resolving =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: answerResolution,
        });

      expect(resolving).toMatchObject({
        id: created.interaction.id,
        resolution: answerResolution,
        status: "resolving",
      });

      const completed =
        harness.deps.pendingInteractions.completeResolvingInteraction({
          interactionId: created.interaction.id,
          resolution: answerResolution,
        });

      expect(completed).toMatchObject({
        id: created.interaction.id,
        resolution: answerResolution,
        status: "resolved",
      });
    });
  });

  it("interrupts pending user-question interactions without orphaning state", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-user-question-interrupted",
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
        providerId: "claude-code",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-user-question-interrupted",
          providerId: "claude-code",
          providerThreadId: "provider-thread-user-question-interrupted",
          providerRequestId: "request-user-question-interrupted",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const interrupted =
        harness.deps.pendingInteractions.interruptPendingInteraction({
          interactionId: created.interaction.id,
          reason: "Provider exited",
        });

      expect(interrupted).toMatchObject({
        id: created.interaction.id,
        resolution: null,
        status: "interrupted",
        statusReason: "Provider exited",
      });
      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createUserAnswerResolution(),
        }),
      ).toThrowError(
        `Pending interaction ${created.interaction.id} is already interrupted`,
      );
    });
  });

  it("rejects reused provider request ids after the original interaction is terminal", async () => {
    await withTestHarness(async (harness) => {
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-terminal-dedupe-1",
          providerId: "codex",
          providerThreadId: "provider-thread-terminal-dedupe",
          providerRequestId: "request-terminal-dedupe",
          payload: createCommandApprovalPayload({
            itemId: "item-terminal-dedupe-1",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: createAllowOnceResolution(),
      });
      harness.deps.pendingInteractions.completeResolvingInteraction({
        interactionId: created.interaction.id,
        resolution: createAllowOnceResolution(),
      });

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-terminal-dedupe-2",
            providerId: "codex",
            providerThreadId: "provider-thread-terminal-dedupe",
            providerRequestId: "request-terminal-dedupe",
            payload: createCommandApprovalPayload({
              itemId: "item-terminal-dedupe-2",
              reason: "Needs approval again",
              command: "git push",
              cwd: "/tmp/project",
              availableDecisions: ["allow_once", "deny"],
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason:
          "Provider request request-terminal-dedupe was already handled and cannot be reused",
      });
    });
  });

  it("deduplicates active provider requests across daemon sessions when payloads match", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-reconnect-dedupe",
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
      const interaction: PendingInteractionCreate = {
        threadId: thread.id,
        turnId: "turn-reconnect-dedupe",
        providerId: "codex",
        providerThreadId: "provider-thread-reconnect-dedupe",
        providerRequestId: "request-reconnect-dedupe",
        payload: createCommandApprovalPayload({
          itemId: "item-reconnect-dedupe",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
        }),
      };

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        interaction,
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const duplicate = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        interaction,
      );

      expect(duplicate).toEqual({
        outcome: "existing",
        interaction: created.interaction,
      });
    });
  });

  it("preserves pending interactions when the same daemon instance reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-same-instance-reconnect",
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
      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-same-instance-reconnect",
          providerId: "codex",
          providerThreadId: "provider-thread-same-instance-reconnect",
          providerRequestId: "request-same-instance-reconnect",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }
      const replacementSession = seedSession(harness.deps, host.id);
      await handleHostSessionOpened(harness.deps, {
        activeThreads: [],
        hostId: host.id,
        openedSession: replacementSession,
        previousSession: session,
      });

      const row = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, created.interaction.id))
        .get();
      expect(row).toMatchObject({
        status: "pending",
        statusReason: null,
      });
    });
  });

  it("rejects active provider request reuse with a different payload", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-reconnect-payload-mismatch",
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
      const baseInteraction: PendingInteractionCreate = {
        threadId: thread.id,
        turnId: "turn-reconnect-payload-mismatch",
        providerId: "codex",
        providerThreadId: "provider-thread-reconnect-payload-mismatch",
        providerRequestId: "request-reconnect-payload-mismatch",
        payload: createCommandApprovalPayload({
          itemId: "item-reconnect-payload-mismatch",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
        }),
      };

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        baseInteraction,
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            ...baseInteraction,
            payload: createCommandApprovalPayload({
              itemId: "item-reconnect-payload-mismatch",
              reason: "Different approval",
              command: "git push",
              cwd: "/tmp/project",
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason:
          "Provider request request-reconnect-payload-mismatch is already awaiting a different interaction payload",
      });
    });
  });

  it("rejects interactions from providers that do not own the thread", async () => {
    await withTestHarness(async (harness) => {
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
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-provider-mismatch",
            providerId: "claude-code",
            providerThreadId: "provider-thread-provider-mismatch",
            providerRequestId: "request-provider-mismatch",
            payload: createCommandApprovalPayload({
              itemId: "item-provider-mismatch",
              reason: "Needs approval",
              command: "git push",
              cwd: "/tmp/project",
              availableDecisions: ["allow_once", "deny"],
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason: `Thread ${thread.id} belongs to provider codex, not claude-code`,
      });
    });
  });

  it("treats reordered permission grants as idempotent resolution retries", async () => {
    await withTestHarness(async (harness) => {
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-idempotent-permissions",
          providerId: "codex",
          providerThreadId: "provider-thread-idempotent-permissions",
          providerRequestId: "request-idempotent-permissions",
          payload: createPermissionGrantApprovalPayload({
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
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const firstResolution =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution({
            network: null,
            fileSystem: {
              read: ["/tmp/project/a", "/tmp/project/b"],
              write: ["/tmp/project/c", "/tmp/project/d"],
            },
          }),
        });
      expect(firstResolution.status).toBe("resolving");

      const retryResolution =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution({
            network: null,
            fileSystem: {
              read: ["/tmp/project/b", "/tmp/project/a"],
              write: ["/tmp/project/d", "/tmp/project/c"],
            },
          }),
        });

      expect(retryResolution).toMatchObject({
        id: created.interaction.id,
        status: "resolving",
        resolution: firstResolution.resolution,
      });
      const resolvingRow = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, created.interaction.id))
        .get();
      expect(resolvingRow).toMatchObject({
        status: "resolving",
        resolution: JSON.stringify(firstResolution.resolution),
      });

      const completed =
        harness.deps.pendingInteractions.completeResolvingInteraction({
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution({
            network: null,
            fileSystem: {
              read: ["/tmp/project/a", "/tmp/project/b"],
              write: ["/tmp/project/c", "/tmp/project/d"],
            },
          }),
        });
      expect(completed?.status).toBe("resolved");
      const resolvedRow = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, created.interaction.id))
        .get();
      expect(resolvedRow).toMatchObject({
        status: "resolved",
      });
    });
  });

  it("rejects permission allow resolutions that grant nothing", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-empty-grant",
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-empty-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-empty-grant",
          providerRequestId: "request-empty-grant",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-empty-grant",
            reason: "Needs network access",
            toolName: "WebFetch",
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: null,
            fileSystem: null,
          }),
        }),
      ).toThrow(
        "Allowed permission resolutions must grant at least one permission",
      );

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }).status,
      ).toBe("pending");
    });
  });

  it("allows a permission grant whose request has nothing to grant", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-no-grantable",
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-no-grantable",
          providerId: "codex",
          providerThreadId: "provider-thread-no-grantable",
          providerRequestId: "request-no-grantable",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-no-grantable",
            reason: "Needs approval",
            toolName: "SomeOpaqueTool",
            permissions: {
              network: null,
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: createAllowOnceResolution({
          network: null,
          fileSystem: null,
        }),
      });

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }).status,
      ).not.toBe("pending");
    });
  });

  it("accepts tool-use approvals without a timeline item of their own", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-tool-use",
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-tool-use",
          providerId: "codex",
          providerThreadId: "provider-thread-tool-use",
          providerRequestId: "request-tool-use",
          payload: createToolUseApprovalPayload({ itemId: "mcp-call-1" }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }
      const itemEventsFor = () =>
        harness.db
          .select()
          .from(eventTable)
          .where(eq(eventTable.threadId, thread.id))
          .all()
          .filter((row) => row.type.startsWith("item/"));
      expect(itemEventsFor()).toEqual([]);

      expect(
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createDenyResolution(),
        }),
      ).toEqual(
        expect.objectContaining({
          status: "resolving",
          resolution: expect.objectContaining({ decision: "deny" }),
        }),
      );
      expect(itemEventsFor()).toEqual([]);
    });
  });

  it("appends one interaction lifecycle event per status change, paired with the resolution, for every kind", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-lifecycle-event",
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
      const lifecycleEvents = () =>
        harness.db
          .select()
          .from(eventTable)
          .where(eq(eventTable.threadId, thread.id))
          .all()
          .filter((row) => row.type === "system/interaction/lifecycle")
          .map((row) => ({
            scope:
              row.scopeKind === "turn"
                ? { kind: "turn", turnId: row.turnId }
                : { kind: "thread" },
            interaction: JSON.parse(row.data).interaction,
          }));

      const grant = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-lifecycle",
          providerId: "codex",
          providerThreadId: "provider-thread-lifecycle",
          providerRequestId: "request-lifecycle-grant",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-grant",
          }),
        },
      );
      if (grant.outcome === "rejected") {
        throw new Error(`Expected registration to succeed: ${grant.reason}`);
      }
      const resolution = createAllowForSessionResolution({
        network: null,
        fileSystem: null,
      });
      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: grant.interaction.id,
        resolution,
      });
      harness.deps.pendingInteractions.completeResolvingInteraction({
        interactionId: grant.interaction.id,
        resolution,
      });

      expect(lifecycleEvents()).toEqual([
        {
          scope: { kind: "turn", turnId: "turn-lifecycle" },
          interaction: expect.objectContaining({
            id: grant.interaction.id,
            status: "pending",
            statusReason: null,
            origin: {
              kind: "provider",
              providerId: "codex",
              providerRequestId: "request-lifecycle-grant",
            },
            payload: {
              kind: "approval",
              reason: "Grant permission",
              subject: expect.objectContaining({
                kind: "permission_grant",
                itemId: "item-grant",
              }),
            },
            resolution: null,
          }),
        },
        {
          scope: { kind: "turn", turnId: "turn-lifecycle" },
          interaction: expect.objectContaining({
            id: grant.interaction.id,
            status: "resolving",
            resolution,
          }),
        },
        {
          scope: { kind: "turn", turnId: "turn-lifecycle" },
          interaction: expect.objectContaining({
            id: grant.interaction.id,
            status: "resolved",
            resolution,
          }),
        },
      ]);
      expect(lifecycleEvents()[0]?.interaction.payload).not.toHaveProperty(
        "availableDecisions",
      );

      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
        name: "SENTINEL_FIELD",
      });
      const [pluginInteraction] =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
      harness.deps.pendingInteractions.respondToPluginInteraction({
        threadId: thread.id,
        interactionId: pluginInteraction!.id,
        value: { values: { API_KEY: "x" } },
      });
      await pending;
      const pluginEvents = lifecycleEvents().filter(
        (event) => event.interaction.id === pluginInteraction!.id,
      );
      expect(pluginEvents.map((event) => event.interaction.status)).toEqual([
        "pending",
        "resolved",
      ]);
      expect(pluginEvents[0]).toEqual({
        scope: { kind: "thread" },
        interaction: {
          id: pluginInteraction!.id,
          status: "pending",
          statusReason: null,
          origin: {
            kind: "plugin",
            pluginId: "secrets",
            rendererId: "secret-request",
          },
          payload: { kind: "plugin", title: "Add secrets" },
          resolution: null,
        },
      });
      expect(JSON.stringify(pluginEvents)).not.toContain("SENTINEL_FIELD");
      expect(pluginEvents[1]?.interaction.resolution).toEqual({
        kind: "plugin_submitted",
      });
    });
  });

  it("writes a command approval's lifecycle record before its item at every status that touches the item", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-item-order",
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
      const writes = () =>
        harness.db
          .select()
          .from(eventTable)
          .where(eq(eventTable.threadId, thread.id))
          .orderBy(eventTable.sequence)
          .all()
          .filter(
            (row) =>
              row.type === "system/interaction/lifecycle" ||
              row.type.startsWith("item/"),
          )
          .map((row) => ({
            type: row.type,
            turnId: row.turnId,
            environmentId: row.environmentId,
            providerThreadId: row.providerThreadId,
          }));
      const lifecycle = {
        type: "system/interaction/lifecycle",
        turnId: "turn-item-order",
        environmentId: environment.id,
        providerThreadId: null,
      };
      const item = (type: "item/started" | "item/completed") => ({
        type,
        turnId: "turn-item-order",
        environmentId: environment.id,
        providerThreadId: "provider-thread-item-order",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-item-order",
          providerId: "codex",
          providerThreadId: "provider-thread-item-order",
          providerRequestId: "request-item-order",
          payload: createCommandApprovalPayload({ itemId: "item-order" }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(`Expected registration to succeed: ${created.reason}`);
      }
      expect(writes()).toEqual([lifecycle, item("item/started")]);

      const resolution = createDenyResolution();
      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution,
      });
      expect(writes().slice(2)).toEqual([lifecycle]);

      harness.deps.pendingInteractions.completeResolvingInteraction({
        interactionId: created.interaction.id,
        resolution,
      });
      expect(writes().slice(3)).toEqual([lifecycle, item("item/completed")]);
    });
  });

  it("carries a provider's plugin-defined request to the plugin form and its answer back as a request answer", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-plugin-request",
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
        providerId: "acp-cursor",
      });

      const request = {
        threadId: thread.id,
        turnId: "turn-plugin-request",
        providerId: "acp-cursor",
        providerThreadId: "provider-thread-plugin-request",
        providerRequestId: "request-plugin-request",
        payload: {
          kind: "secrets/secret-request" as const,
          title: "Add a token",
          data: { fields: ["SENTINEL_TOKEN"] },
        },
      };
      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          request,
        ),
      ).toEqual({
        outcome: "rejected",
        reason: expect.stringContaining('Plugin "secrets" is not loaded'),
      });
      harness.deps.pendingInteractions.setPluginDirectory({
        isLoaded: (pluginId) => pluginId === "secrets",
      });
      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        request,
      );
      if (created.outcome === "rejected") {
        throw new Error(`Expected registration to succeed: ${created.reason}`);
      }

      const oversized = { blob: "x".repeat(64 * 1024) };
      expect(() =>
        harness.deps.pendingInteractions.respondToInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          value: oversized,
        }),
      ).toThrow(
        expect.objectContaining({
          status: 413,
          message: "Interaction response exceeds 64 KiB",
        }),
      );
      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: { kind: "request_answer", value: oversized },
        }),
      ).toThrow(
        expect.objectContaining({
          status: 413,
          message: "Interaction response exceeds 64 KiB",
        }),
      );

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createDenyResolution(),
        }),
      ).toThrow("Only a request answer can resolve a plugin request");
      expect(() =>
        harness.deps.pendingInteractions.cancelPluginInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          reason: "user",
        }),
      ).toThrow("stop the turn instead");

      const answer = { kind: "request_answer", value: { TOKEN: "sentinel-x" } };
      const responding = harness.deps.pendingInteractions.respondToInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        value: { TOKEN: "sentinel-x" },
      });
      expect(responding).toMatchObject({
        id: created.interaction.id,
        status: "resolving",
        resolution: answer,
      });
      const completed =
        harness.deps.pendingInteractions.completeResolvingInteraction({
          interactionId: created.interaction.id,
          resolution: {
            kind: "request_answer",
            value: { TOKEN: "sentinel-x" },
          },
        });
      expect(completed).toMatchObject({
        status: "resolved",
        resolution: answer,
      });

      const lifecycle = harness.db
        .select()
        .from(eventTable)
        .where(eq(eventTable.threadId, thread.id))
        .all()
        .filter((row) => row.type === "system/interaction/lifecycle")
        .map((row) => JSON.parse(row.data).interaction);
      expect(lifecycle.map((record) => record.status)).toEqual([
        "pending",
        "resolving",
        "resolved",
      ]);
      expect(lifecycle[2]).toMatchObject({
        payload: { kind: "secrets/secret-request", title: "Add a token" },
        resolution: { kind: "request_answer" },
      });
      expect(JSON.stringify(lifecycle)).not.toContain("SENTINEL_TOKEN");
      expect(JSON.stringify(lifecycle)).not.toContain("sentinel-x");
    });
  });

  it("allows command approvals to grant explicit session permissions for session decisions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-command-grant",
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-command-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-command-grant",
          providerRequestId: "request-command-grant",
          payload: createCommandApprovalPayload({
            itemId: "item-command-grant",
            reason: "Needs network",
            command: "curl https://example.com",
            sessionGrant: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: { enabled: true },
            fileSystem: null,
          }),
        }),
      ).toEqual(
        expect.objectContaining({
          status: "resolving",
          resolution: expect.objectContaining({
            decision: "allow_for_session",
            grantedPermissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        }),
      );
    });
  });

  it("allows command session approvals when no BB session grant was requested", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-command-opaque-session",
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
        providerId: "acp-opencode",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-command-opaque-session",
          providerId: "acp-opencode",
          providerThreadId: "provider-thread-command-opaque-session",
          providerRequestId: "request-command-opaque-session",
          payload: createCommandApprovalPayload({
            itemId: "item-command-opaque-session",
            reason: "Needs provider-side session approval",
            command: "cd backend && pnpm test",
            sessionGrant: null,
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution(null),
        }),
      ).toEqual(
        expect.objectContaining({
          status: "resolving",
          resolution: {
            decision: "allow_for_session",
            grantedPermissions: null,
          },
        }),
      );
    });
  });

  it("rejects narrowed command session approval grants", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-narrowed-command-grant",
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-narrowed-command-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-narrowed-command-grant",
          providerRequestId: "request-narrowed-command-grant",
          payload: createCommandApprovalPayload({
            itemId: "item-narrowed-command-grant",
            reason: "Needs network and file access",
            command: "curl https://example.com > out.txt",
            sessionGrant: {
              network: { enabled: true },
              fileSystem: {
                read: [],
                write: ["/tmp/project"],
              },
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: { enabled: true },
            fileSystem: null,
          }),
        }),
      ).toThrow(
        "Command and file-change session approvals must grant the requested session permissions exactly",
      );
    });
  });

  it("rejects session command approvals without granted permissions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-null-session-grant",
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-null-session-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-null-session-grant",
          providerRequestId: "request-null-session-grant",
          payload: createCommandApprovalPayload({
            itemId: "item-null-session-grant",
            reason: "Needs network",
            command: "curl https://example.com",
            sessionGrant: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution(null),
        }),
      ).toThrow(
        "Session approval resolutions must include granted permissions",
      );
    });
  });

  it("rejects file-change approvals that try to grant write-scope permissions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-file-change-grant",
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-file-change-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-file-change-grant",
          providerRequestId: "request-file-change-grant",
          payload: createFileChangeApprovalPayload({
            itemId: "item-file-change-grant",
            reason: "Needs file write approval",
            writeScope: "/tmp/project",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          }),
        }),
      ).toThrow(
        "This approval subject and decision cannot grant the requested permissions",
      );
    });
  });

  it("rejects a second active interaction on the same thread", async () => {
    await withTestHarness(async (harness) => {
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-concurrent-reject-1",
          providerId: "codex",
          providerThreadId: "provider-thread-concurrent-reject",
          providerRequestId: "request-concurrent-reject-1",
          payload: createCommandApprovalPayload({
            itemId: "item-concurrent-reject-1",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-concurrent-reject-2",
            providerId: "codex",
            providerThreadId: "provider-thread-concurrent-reject",
            providerRequestId: "request-concurrent-reject-2",
            payload: createFileChangeApprovalPayload({
              itemId: "item-concurrent-reject-2",
              reason: "Needs file write approval",
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason: `Thread ${thread.id} is already awaiting user interaction`,
      });
    });
  });

  it("rejects command approvals with no available decisions", async () => {
    await withTestHarness(async (harness) => {
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
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-empty-decisions",
            providerId: "codex",
            providerThreadId: "provider-thread-empty-decisions",
            providerRequestId: "request-empty-decisions",
            payload: createCommandApprovalPayload({
              itemId: "item-empty-decisions",
              reason: "Needs approval",
              command: "git push",
              cwd: "/tmp/project",
              availableDecisions: [],
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason: "Approvals must include at least one available decision",
      });
    });
  });

  it("rejects resolving interrupted interactions", async () => {
    await withTestHarness(async (harness) => {
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

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-resolve-interrupted",
          providerId: "codex",
          providerThreadId: "provider-thread-resolve-interrupted",
          providerRequestId: "request-resolve-interrupted",
          payload: createCommandApprovalPayload({
            itemId: "item-resolve-interrupted",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      harness.deps.pendingInteractions.interruptPendingInteraction({
        interactionId: created.interaction.id,
        reason: "Provider exited",
      });

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution(),
        }),
      ).toThrowError(
        `Pending interaction ${created.interaction.id} is already interrupted`,
      );
    });
  });

  it("does not expire pending interactions on persistent hosts", async () => {
    await withTestHarness(async (harness) => {
      const pendingInteractions = new PendingInteractionLifecycle({
        config: harness.deps.config,
        db: harness.db,
        hub: harness.hub,
        lifecycleDedupers: harness.deps.lifecycleDedupers,
        logger: harness.deps.logger,
        machineAuth: harness.deps.machineAuth,
        providerRegistry: harness.deps.providerRegistry,
        aiServices: harness.deps.aiServices,
        pluginHostArtifacts: harness.deps.pluginHostArtifacts,
        skillTreeRegistry: harness.deps.skillTreeRegistry,
        telemetry: harness.deps.telemetry,
        terminalSessions: harness.deps.terminalSessions,
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

      const created = registerPendingInteraction(
        harness.deps,
        pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-no-expiry",
          providerId: "codex",
          providerThreadId: "provider-thread-no-expiry",
          providerRequestId: "request-no-expiry",
          payload: createCommandApprovalPayload({
            itemId: "item-no-expiry",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      await sleep(50);

      expect(
        pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }).status,
      ).toBe("pending");
    });
  });
});
