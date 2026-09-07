import { describe, expect, it } from "vitest";
import { getLatestThreadSequence, listQueuedThreadMessages } from "@bb/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  turnScope,
} from "@bb/domain";
import type { ClientTurnRequestId } from "@bb/domain";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedCompactableThread(
  harness: TestAppHarness,
  args: { providerId: string; providerThreadId: string },
) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: args.providerId,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: args.providerThreadId,
    threadId: thread.id,
  });
  return { host, session, thread };
}

function registerSuccessfulTurnResponder(
  harness: TestAppHarness,
  args: { hostId: string; sessionId: string },
) {
  return registerHostRpcResponder(harness, {
    ...args,
    handle: ({ command }): HostRpcHandlerResult => {
      if (command.type === "host.list_files") {
        return { ok: true, result: { files: [], truncated: false } };
      }
      if (command.type === "host.read_file") {
        return {
          ok: false,
          errorCode: "ENOENT",
          errorMessage: `Path does not exist: ${command.path}`,
        };
      }
      return { ok: true, result: { appliedAs: "new-turn" } };
    },
  });
}

function seedAcceptedProviderTurn(
  harness: TestAppHarness,
  args: {
    clientRequestId: ClientTurnRequestId;
    environmentId: string;
    providerThreadId: string;
    threadId: string;
    turnId: string;
  },
): void {
  seedTurnStarted(harness.deps, {
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    threadId: args.threadId,
    turnId: args.turnId,
  });
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "turn/input/accepted",
    scope: turnScope(args.turnId),
    data: {
      providerThreadId: args.providerThreadId,
      clientRequestId: args.clientRequestId,
    },
  });
}

describe("public thread compaction", () => {
  it("dispatches the same structured /compact turn as the composer", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "pi",
        providerThreadId: "provider-thread-1",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/compact`,
        { method: "POST" },
      );
      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      const turnSubmitRequests = responder.requests.filter(
        ({ command }) => command.type === "turn.submit",
      );
      expect(turnSubmitRequests).toHaveLength(1);
      expect(turnSubmitRequests[0]?.command).toMatchObject({
        type: "turn.submit",
        threadId: thread.id,
        input: createStandaloneBuiltinCompactCommandInput(),
        resumeContext: {
          providerId: "pi",
          providerThreadId: "provider-thread-1",
        },
      });
    });
  });

  it("routes ACP agent compaction onto the bridge's /compact turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "acp-omp",
        providerThreadId: "provider-thread-acp",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/compact`,
        { method: "POST" },
      );
      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      const turnSubmitRequests = responder.requests.filter(
        ({ command }) => command.type === "turn.submit",
      );
      expect(turnSubmitRequests).toHaveLength(1);
      expect(turnSubmitRequests[0]?.command).toMatchObject({
        type: "turn.submit",
        threadId: thread.id,
        input: createStandaloneBuiltinCompactCommandInput(),
        resumeContext: {
          providerId: "acp-omp",
          providerThreadId: "provider-thread-acp",
        },
      });
    });
  });

  it("queues sends and defers send-now while manual compaction is active", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedCompactableThread(harness, {
        providerId: "pi",
        providerThreadId: "provider-thread-queue",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const compactResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/compact`,
        { method: "POST" },
      );
      expect(compactResponse.status).toBe(200);
      const compactRequest = responder.requests.find(
        ({ command }) => command.type === "turn.submit",
      );
      if (!compactRequest || compactRequest.command.type !== "turn.submit") {
        throw new Error("Expected compaction turn.submit request");
      }
      if (!thread.environmentId) {
        throw new Error("Expected compactable thread environment");
      }
      const compactionTurnId = "turn-manual-compaction";
      seedAcceptedProviderTurn(harness, {
        clientRequestId: compactRequest.command.requestId,
        environmentId: thread.environmentId,
        providerThreadId: "provider-thread-queue",
        threadId: thread.id,
        turnId: compactionTurnId,
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Send after compaction" }],
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      const [queuedMessage] = listQueuedThreadMessages(harness.db, thread.id);
      if (!queuedMessage) {
        throw new Error("Expected the send to remain queued");
      }

      const sendNowResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "steer" }),
        },
      );
      expect(sendNowResponse.status).toBe(200);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      expect(
        responder.requests.filter(
          ({ command }) => command.type === "turn.submit",
        ),
      ).toHaveLength(1);

      expect(
        await sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: thread.id,
        }),
      ).toBe(false);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "provider-thread-queue",
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: turnScope(compactionTurnId),
        data: {
          providerThreadId: "provider-thread-queue",
          status: "completed",
        },
      });
      const completion = applyTurnCompletedEvent(harness.deps, {
        threadId: thread.id,
        providerThreadId: "provider-thread-queue",
        type: "turn/completed",
        scope: turnScope(compactionTurnId),
        status: "completed",
      });
      expect(completion.nextStatus).toBe("idle");
      expect(
        await sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: thread.id,
        }),
      ).toBe(true);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      await expect
        .poll(
          () =>
            responder.requests.filter(
              ({ command }) => command.type === "turn.submit",
            ).length,
        )
        .toBe(2);
    });
  });

  it("rejects manual compaction for unsupported providers and active threads", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const unsupportedThread = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "acp-cursor",
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "codex",
        status: "active",
      });

      const unsupportedResponse = await harness.app.request(
        `/api/v1/threads/${unsupportedThread.id}/compact`,
        { method: "POST" },
      );
      expect(unsupportedResponse.status).toBe(409);
      await expect(readJson(unsupportedResponse)).resolves.toMatchObject({
        message: expect.stringContaining(
          "does not support manual context compaction",
        ),
      });

      const activeResponse = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/compact`,
        { method: "POST" },
      );
      expect(activeResponse.status).toBe(409);
      await expect(readJson(activeResponse)).resolves.toMatchObject({
        message:
          "Context can only be compacted while the thread is idle or errored",
      });
    });
  });
});
