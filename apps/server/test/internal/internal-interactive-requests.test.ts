import { setTimeout as sleep } from "node:timers/promises";
import { deleteThread } from "@bb/db";
import type { HostDaemonInteractiveRequest } from "@bb/host-daemon-contract";
import { renderTemplate } from "@bb/templates";
import { describe, expect, it } from "vitest";
import {
  internalAuthHeaders,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedThreadFixture,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createAllowForSessionResolution,
  createAllowOnceResolution,
  createCommandApprovalPayload,
  createPermissionGrantApprovalPayload,
  createUserQuestionPayload,
} from "../helpers/pending-interactions.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";

type TestAppHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

interface WaitForPendingInteractionIdArgs {
  harness: TestAppHarness;
  threadId: string;
}

interface RegisterInteractiveRequestArgs {
  body: HostDaemonInteractiveRequest;
  harness: TestAppHarness;
}

interface BuildCommandApprovalInteractiveRequestArgs {
  sessionId: string;
  suffix: string;
  threadId: string;
}

async function waitForPendingInteractionId(
  args: WaitForPendingInteractionIdArgs,
): Promise<string> {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const interactions =
      args.harness.deps.pendingInteractions.listThreadInteractions(
        args.threadId,
      );
    const pending = interactions.find(
      (interaction) => interaction.status === "pending",
    );
    if (pending) {
      return pending.id;
    }
    await sleep(10);
  }

  throw new Error("Timed out waiting for pending interaction");
}

function buildCommandApprovalInteractiveRequest(
  args: BuildCommandApprovalInteractiveRequestArgs,
): HostDaemonInteractiveRequest {
  return {
    sessionId: args.sessionId,
    interaction: {
      threadId: args.threadId,
      turnId: `turn-${args.suffix}`,
      providerId: "codex",
      providerThreadId: `provider-thread-${args.suffix}`,
      providerRequestId: `request-${args.suffix}`,
      payload: createCommandApprovalPayload({
        itemId: `item-${args.suffix}`,
        reason: "Needs approval",
        command: "git push",
        cwd: "/tmp/project",
      }),
    },
  };
}

async function postInteractiveRequest(
  args: RegisterInteractiveRequestArgs,
): Promise<Response> {
  return await args.harness.app.request(
    "/internal/session/interactive-request",
    {
      method: "POST",
      headers: internalAuthHeaders(args.harness),
      body: JSON.stringify(args.body),
    },
  );
}

function registerInteractiveRequest(
  args: RegisterInteractiveRequestArgs,
): Promise<Response> {
  seedTurnStarted(args.harness.deps, {
    threadId: args.body.interaction.threadId,
    turnId: args.body.interaction.turnId,
    providerThreadId: args.body.interaction.providerThreadId,
  });
  return postInteractiveRequest(args);
}

describe("internal interactive request lifecycle", () => {
  it("persists an interactive request and delivers a later resolution through a command", async () => {
    await withTestHarness(async (harness) => {
      const { session, environment, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-interaction-resolve",
        },
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-1",
        providerThreadId: "provider-thread-1",
      });

      const response = await harness.app.request(
        "/internal/session/interactive-request",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            interaction: {
              threadId: thread.id,
              turnId: "turn-1",
              providerId: "codex",
              providerThreadId: "provider-thread-1",
              providerRequestId: "request-1",
              payload: createCommandApprovalPayload({
                itemId: "item-1",
                reason: "Needs approval",
                command: "git push",
                cwd: "/tmp/project",
              }),
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      const interactionId = await waitForPendingInteractionId({
        harness,
        threadId: thread.id,
      });
      const resolved =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId,
          resolution: createAllowOnceResolution(),
        });

      expect(resolved).toMatchObject({
        id: interactionId,
        status: "resolving",
      });

      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === interactionId,
      );
      expect(queuedResolve.command).toMatchObject({
        type: "interactive.resolve",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        providerRequestId: "request-1",
        resolution: createAllowOnceResolution(),
      });
      const commandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(commandResultResponse.status).toBe(200);

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId,
        }),
      ).toMatchObject({
        id: interactionId,
        status: "resolved",
        resolution: createAllowOnceResolution(),
      });

      const retriedCommandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(retriedCommandResultResponse.status).toBe(200);
      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId,
        }),
      ).toMatchObject({
        id: interactionId,
        status: "resolved",
        resolution: createAllowOnceResolution(),
      });
    });
  });

  it("persists user-question interactive requests", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-user-question-enabled",
        },
        thread: { providerId: "claude-code" },
      });

      const response = await registerInteractiveRequest({
        harness,
        body: {
          sessionId: session.id,
          interaction: {
            threadId: thread.id,
            turnId: "turn-user-question-enabled",
            providerId: "claude-code",
            providerThreadId: "provider-thread-user-question-enabled",
            providerRequestId: "request-user-question-enabled",
            payload: createUserQuestionPayload(),
          },
        },
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      const [interaction] =
        harness.deps.pendingInteractions.listThreadInteractions(thread.id);
      if (!interaction) {
        throw new Error("Expected user-question interaction to be persisted");
      }
      expect(interaction).toMatchObject({
        payload: {
          kind: "user_question",
        },
        status: "pending",
      });
    });
  });

  it("persists a session-scoped command approval resolution", async () => {
    await withTestHarness(async (harness) => {
      const { session, environment, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-interaction-session-resolve",
        },
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-session-1",
        providerThreadId: "provider-thread-session-1",
      });
      const sessionGrant = {
        network: { enabled: true },
        fileSystem: null,
      };
      const sessionResolution = createAllowForSessionResolution(sessionGrant);

      const response = await harness.app.request(
        "/internal/session/interactive-request",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            interaction: {
              threadId: thread.id,
              turnId: "turn-session-1",
              providerId: "codex",
              providerThreadId: "provider-thread-session-1",
              providerRequestId: "request-session-1",
              payload: createCommandApprovalPayload({
                itemId: "item-session-1",
                reason: "Needs approval",
                command: "git push",
                cwd: "/tmp/project",
                sessionGrant,
              }),
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      const interactionId = await waitForPendingInteractionId({
        harness,
        threadId: thread.id,
      });
      const resolved =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId,
          resolution: sessionResolution,
        });

      expect(resolved).toMatchObject({
        id: interactionId,
        status: "resolving",
        resolution: sessionResolution,
      });

      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === interactionId,
      );
      expect(queuedResolve.command).toMatchObject({
        type: "interactive.resolve",
        providerId: "codex",
        providerThreadId: "provider-thread-session-1",
        providerRequestId: "request-session-1",
        resolution: sessionResolution,
      });
      const commandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(commandResultResponse.status).toBe(200);
      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId,
        }),
      ).toMatchObject({
        id: interactionId,
        status: "resolved",
        resolution: sessionResolution,
      });

      const retriedCommandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(retriedCommandResultResponse.status).toBe(200);
    });
  });

  it("returns the existing pending interaction when registration is retried", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-interaction-registration-retry",
        },
      });
      const body = buildCommandApprovalInteractiveRequest({
        sessionId: session.id,
        suffix: "registration-retry",
        threadId: thread.id,
      });

      const firstResponse = await registerInteractiveRequest({ body, harness });
      expect(firstResponse.status).toBe(200);
      await expect(readJson(firstResponse)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });
      const interactionId = await waitForPendingInteractionId({
        harness,
        threadId: thread.id,
      });

      const retryResponse = await registerInteractiveRequest({ body, harness });

      expect(retryResponse.status).toBe(200);
      await expect(readJson(retryResponse)).resolves.toMatchObject({
        outcome: "existing",
        interactionId,
        status: "pending",
      });
      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toHaveLength(1);
    });
  });

  it("notifies a parent thread when a child needs attention for a pending interaction", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-child-needs-attention",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/child-needs-attention-parent",
        projectId: project.id,
      });
      const childEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/child-needs-attention-child",
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        environmentId: parentEnvironment.id,
        projectId: project.id,
        title: "Project coordinator",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: parentEnvironment.id,
        inputText: "Initial parent task",
        providerThreadId: "provider-parent-needs-attention",
        threadId: parentThread.id,
      });
      const childThread = seedThread(harness.deps, {
        environmentId: childEnvironment.id,
        parentThreadId: parentThread.id,
        projectId: project.id,
        title: "Backend port validation cleanup",
      });
      const body = buildCommandApprovalInteractiveRequest({
        sessionId: session.id,
        suffix: "child-needs-attention",
        threadId: childThread.id,
      });

      const response = await registerInteractiveRequest({ body, harness });
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      const parentTurnCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "turn.submit" &&
          command.threadId === parentThread.id,
      );
      if (parentTurnCommand.command.type !== "turn.submit") {
        throw new Error(
          `Expected parent turn command, got ${parentTurnCommand.command.type}`,
        );
      }
      const threadMention = `@thread:${childThread.id}`;
      const expectedText = renderTemplate(
        "systemMessageChildThreadNeedsAttention",
        {
          blockerSummary: [
            "Blocked on command approval:",
            "Command: git push",
            "Cwd: /tmp/project",
          ].join("\n"),
          threadMention,
        },
      );
      const mentionStart = expectedText.indexOf(threadMention);
      expect(parentTurnCommand.command.input).toEqual(
        expect.arrayContaining([
          {
            type: "text",
            text: expectedText,
            mentions: [
              {
                start: mentionStart,
                end: mentionStart + threadMention.length,
                resource: {
                  kind: "thread",
                  label: "Backend port validation cleanup",
                  projectId: project.id,
                  threadId: childThread.id,
                },
              },
            ],
          },
        ]),
      );

      const retryResponse = await registerInteractiveRequest({
        body,
        harness,
      });
      expect(retryResponse.status).toBe(200);
      await expect(readJson(retryResponse)).resolves.toMatchObject({
        outcome: "existing",
        status: "pending",
      });
      await expect(
        waitForQueuedCommandAfter(
          harness,
          parentTurnCommand.row.cursor,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === parentThread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    });
  });

  it("notifies a parent when a hidden delegated child needs attention", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-hidden-delegated-needs-attention",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/hidden-delegated-needs-attention-parent",
        projectId: project.id,
      });
      const childEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/hidden-delegated-needs-attention-child",
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        environmentId: parentEnvironment.id,
        projectId: project.id,
        visibility: "hidden",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: parentEnvironment.id,
        inputText: "Coordinate hidden delegated work",
        providerThreadId: "provider-hidden-delegated-needs-attention-parent",
        threadId: parentThread.id,
      });
      const childThread = seedThread(harness.deps, {
        environmentId: childEnvironment.id,
        parentThreadId: parentThread.id,
        projectId: project.id,
        visibility: "hidden",
      });

      const response = await registerInteractiveRequest({
        body: buildCommandApprovalInteractiveRequest({
          sessionId: session.id,
          suffix: "hidden-delegated-needs-attention",
          threadId: childThread.id,
        }),
        harness,
      });

      expect(response.status).toBe(200);
      const parentTurnCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.state === "pending" &&
          command.type === "turn.submit" &&
          command.threadId === parentThread.id,
      );
      expect(parentTurnCommand.command.type).toBe("turn.submit");
    });
  });

  it("does not notify a parent when a fork child needs attention", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-hidden-child-needs-attention",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/hidden-child-needs-attention-parent",
        projectId: project.id,
      });
      const childEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/hidden-child-needs-attention-child",
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        environmentId: parentEnvironment.id,
        projectId: project.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: parentEnvironment.id,
        inputText: "Coordinate hidden child work",
        providerThreadId: "provider-hidden-child-needs-attention-parent",
        threadId: parentThread.id,
      });
      const childThread = seedThread(harness.deps, {
        environmentId: childEnvironment.id,
        originKind: "fork",
        parentThreadId: parentThread.id,
        projectId: project.id,
        visibility: "hidden",
      });

      const response = await registerInteractiveRequest({
        body: buildCommandApprovalInteractiveRequest({
          sessionId: session.id,
          suffix: "hidden-child-needs-attention",
          threadId: childThread.id,
        }),
        harness,
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === parentThread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    });
  });

  it("returns retryable 503 when interactive request turn/started has not landed", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-interaction-turn-start-timeout",
        },
      });
      const body = buildCommandApprovalInteractiveRequest({
        sessionId: session.id,
        suffix: "turn-start-timeout",
        threadId: thread.id,
      });

      const response = await postInteractiveRequest({ body, harness });

      expect(response.status).toBe(503);
      await expect(readJson(response)).resolves.toEqual({
        code: "turn_start_not_ready",
        message:
          "Turn start has not been stored yet; retry interactive request registration",
        retryable: true,
      });
      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toEqual([]);
    });
  });

  it("returns the existing resolving interaction when registration retry arrives after user resolution", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-interaction-registration-retry-resolving",
        },
      });
      const body = buildCommandApprovalInteractiveRequest({
        sessionId: session.id,
        suffix: "registration-retry-resolving",
        threadId: thread.id,
      });

      const firstResponse = await registerInteractiveRequest({ body, harness });
      expect(firstResponse.status).toBe(200);
      await expect(readJson(firstResponse)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });
      const interactionId = await waitForPendingInteractionId({
        harness,
        threadId: thread.id,
      });
      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId,
        resolution: createAllowOnceResolution(),
      });

      const retryResponse = await registerInteractiveRequest({ body, harness });

      expect(retryResponse.status).toBe(200);
      await expect(readJson(retryResponse)).resolves.toMatchObject({
        outcome: "existing",
        interactionId,
        status: "resolving",
      });
      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toEqual([
        expect.objectContaining({
          id: interactionId,
          status: "resolving",
        }),
      ]);
    });
  });

  it("interrupts pending interactive requests for provider exits", async () => {
    await withTestHarness(async (harness) => {
      const { session, environment, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-interaction-interrupt",
        },
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-1",
        providerThreadId: "provider-thread-1",
      });

      const response = await harness.app.request(
        "/internal/session/interactive-request",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            interaction: {
              threadId: thread.id,
              turnId: "turn-1",
              providerId: "codex",
              providerThreadId: "provider-thread-1",
              providerRequestId: "request-1",
              payload: createCommandApprovalPayload({
                itemId: "item-1",
                reason: "Needs approval",
                command: "git push",
                cwd: "/tmp/project",
              }),
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      await waitForPendingInteractionId({
        harness,
        threadId: thread.id,
      });

      const interruptResponse = await harness.app.request(
        "/internal/session/interactive-request/interrupt",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            providerId: "codex",
            threadIds: [thread.id],
            reason: "Provider exited",
          }),
        },
      );

      expect(interruptResponse.status).toBe(200);
      await expect(readJson(interruptResponse)).resolves.toEqual({
        ok: true,
        interactionIds: [expect.any(String)],
      });

      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toEqual([
        expect.objectContaining({
          status: "interrupted",
          statusReason: "Provider exited",
        }),
      ]);
    });
  });

  it("skips deleted threads in interrupt batches and still interrupts live threads", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-interrupt-deleted-skip",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const liveThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const deletedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      deleteThread(harness.db, harness.hub, deletedThread.id);
      seedTurnStarted(harness.deps, {
        threadId: liveThread.id,
        environmentId: environment.id,
        turnId: "turn-interrupt-live",
        providerThreadId: "provider-thread-interrupt-live",
      });

      const response = await harness.app.request(
        "/internal/session/interactive-request",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            interaction: {
              threadId: liveThread.id,
              turnId: "turn-interrupt-live",
              providerId: "codex",
              providerThreadId: "provider-thread-interrupt-live",
              providerRequestId: "request-interrupt-live",
              payload: createCommandApprovalPayload({
                itemId: "item-interrupt-live",
                reason: "Needs approval",
                command: "git push",
                cwd: "/tmp/project",
              }),
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      const interactionId = await waitForPendingInteractionId({
        harness,
        threadId: liveThread.id,
      });

      const interruptResponse = await harness.app.request(
        "/internal/session/interactive-request/interrupt",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            providerId: "codex",
            threadIds: [deletedThread.id, liveThread.id],
            reason: "Provider exited",
          }),
        },
      );

      expect(interruptResponse.status).toBe(200);
      await expect(readJson(interruptResponse)).resolves.toEqual({
        ok: true,
        interactionIds: [interactionId],
      });

      expect(
        harness.deps.pendingInteractions.listThreadInteractions(liveThread.id),
      ).toEqual([
        expect.objectContaining({
          id: interactionId,
          status: "interrupted",
          statusReason: "Provider exited",
        }),
      ]);
    });
  });

  it("interrupts pending interactive requests before deleting threads", async () => {
    await withTestHarness(async (harness) => {
      const { session, environment, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-interaction-delete-thread",
        },
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-delete-1",
        providerThreadId: "provider-thread-delete-1",
      });

      const response = await harness.app.request(
        "/internal/session/interactive-request",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            interaction: {
              threadId: thread.id,
              turnId: "turn-delete-1",
              providerId: "codex",
              providerThreadId: "provider-thread-delete-1",
              providerRequestId: "request-delete-1",
              payload: createCommandApprovalPayload({
                itemId: "item-delete-1",
                reason: "Needs approval",
                command: "git push",
                cwd: "/tmp/project",
              }),
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      await waitForPendingInteractionId({
        harness,
        threadId: thread.id,
      });

      const threadEventWaiter = harness.hub.registerThreadEventWaiter(
        thread.id,
        1_000,
      );

      const deleteResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );
      expect(deleteResponse.status).toBe(200);

      expect(await threadEventWaiter.promise).toBe(true);

      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toEqual([]);
    });
  });

  it("persists Claude interactive requests and resolves them through the same lifecycle", async () => {
    await withTestHarness(async (harness) => {
      const { session, environment, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-claude-interaction-resolve",
        },
        thread: { providerId: "claude-code" },
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-claude-1",
        providerThreadId: "claude-thread-1",
      });

      const response = await harness.app.request(
        "/internal/session/interactive-request",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            interaction: {
              threadId: thread.id,
              turnId: "turn-claude-1",
              providerId: "claude-code",
              providerThreadId: "claude-thread-1",
              providerRequestId: "request-claude-1",
              payload: createPermissionGrantApprovalPayload({
                itemId: "item-claude-1",
                reason: "Need network access",
                toolName: "WebFetch",
                permissions: {
                  network: { enabled: true },
                  fileSystem: null,
                },
              }),
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });

      const interactionId = await waitForPendingInteractionId({
        harness,
        threadId: thread.id,
      });
      const resolved =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId,
          resolution: createAllowForSessionResolution({
            network: { enabled: true },
            fileSystem: null,
          }),
        });

      expect(resolved).toMatchObject({
        id: interactionId,
        status: "resolving",
      });

      const queuedResolve = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "interactive.resolve" &&
          command.interactionId === interactionId,
      );
      expect(queuedResolve.command).toMatchObject({
        type: "interactive.resolve",
        providerId: "claude-code",
        providerThreadId: "claude-thread-1",
        providerRequestId: "request-claude-1",
        resolution: createAllowForSessionResolution({
          network: { enabled: true },
          fileSystem: null,
        }),
      });
      const commandResultResponse = await reportQueuedCommandSuccess(
        harness,
        queuedResolve,
        {},
      );
      expect(commandResultResponse.status).toBe(200);

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId,
        }),
      ).toMatchObject({
        id: interactionId,
        status: "resolved",
      });
    });
  });
});
