import { setTimeout as sleep } from "node:timers/promises";
import { deleteThread } from "@bb/db";
import type { HostDaemonInteractiveRequest } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  internalAuthHeaders,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createAllowForSessionResolution,
  createAllowOnceResolution,
  createCommandApprovalPayload,
  createPermissionGrantApprovalPayload,
} from "../helpers/pending-interactions.js";
import { createTestAppHarness } from "../helpers/test-app.js";

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

function postInteractiveRequest(
  args: RegisterInteractiveRequestArgs,
): Promise<Response> {
  return args.harness.app.request("/internal/session/interactive-request", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify(args.body),
  });
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
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-resolve",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("persists a session-scoped command approval resolution", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-session-resolve",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the existing pending interaction when registration is retried", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-registration-retry",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("waits for daemon-spooled turn/started before registering an interactive request", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-wait-turn-start",
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
      const body = buildCommandApprovalInteractiveRequest({
        sessionId: session.id,
        suffix: "wait-turn-start",
        threadId: thread.id,
      });

      const responsePromise = postInteractiveRequest({ body, harness });
      await sleep(50);
      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toEqual([]);

      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: body.interaction.turnId,
        providerThreadId: body.interaction.providerThreadId,
      });

      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "created",
        status: "pending",
      });
      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toEqual([
        expect.objectContaining({
          providerRequestId: body.interaction.providerRequestId,
          status: "pending",
          turnId: body.interaction.turnId,
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns retryable 503 when interactive request turn/started has not landed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-turn-start-timeout",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the existing resolving interaction when registration retry arrives after user resolution", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-registration-retry-resolving",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("interrupts pending interactive requests for provider exits", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-interrupt",
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
    } finally {
      await harness.cleanup();
    }
  });

  it("skips deleted threads in interrupt batches and still interrupts live threads", async () => {
    const harness = await createTestAppHarness();
    try {
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
    } finally {
      await harness.cleanup();
    }
  });

  it("interrupts pending interactive requests before deleting threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-interaction-delete-thread",
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
          body: JSON.stringify({ managerChildThreadsConfirmed: false }),
        },
      );
      expect(deleteResponse.status).toBe(200);

      expect(await threadEventWaiter.promise).toBe(true);

      const queuedDelete = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.deleted" && command.threadId === thread.id,
      );
      expect(queuedDelete.row.sessionId).toBe(session.id);

      expect(
        harness.deps.pendingInteractions.listThreadInteractions(thread.id),
      ).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("persists Claude interactive requests and resolves them through the same lifecycle", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-claude-interaction-resolve",
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
    } finally {
      await harness.cleanup();
    }
  });
});
