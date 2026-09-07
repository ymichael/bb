import { listEvents, listQueuedThreadMessages } from "@bb/db";
import { queuedMessageWaitingOnSchema } from "@bb/domain";
import { sendMessageResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import {
  listQueuedThreadCommands,
  registerTestHostRpcCapture,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("offline host follow-ups", () => {
  it.each([
    {
      mode: "steer-if-active",
      status: "idle",
      waitingOn: { kind: "host-offline", hostName: "M5" },
    },
    {
      mode: "queue-if-active",
      status: "active",
      waitingOn: { kind: "thread-busy" },
    },
  ] as const)("queues an offline $status follow-up", async (testCase) => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, {
        id: "host-offline-followup",
        name: "M5",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/offline-followup",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: testCase.status,
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-offline-followup",
      });
      if (testCase.status === "active") {
        seedTurnStarted(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-offline-followup",
          threadId: thread.id,
          turnId: "turn-current",
        });
      }
      const input = [
        {
          type: "text" as const,
          text: "Continue when M5 reconnects",
          mentions: [],
        },
      ];
      const eventCountBeforeSend = listEvents(harness.db, {
        threadId: thread.id,
      }).length;

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input,
            mode: testCase.mode,
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = sendMessageResponseSchema.parse(await readJson(response));
      expect(body).toMatchObject({
        delivery: "queued",
        queuedMessage: { sendAt: null },
      });
      if (body.delivery !== "queued") {
        throw new Error("expected the offline follow-up to queue");
      }

      const queued = listQueuedThreadMessages(harness.db, thread.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        id: body.queuedMessage.id,
        sendAt: null,
        failureReason: null,
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
        eventCountBeforeSend,
      );

      const reconnectSession = seedSession(harness.deps, host.id);
      const reconnectSocket = registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: reconnectSession.id,
      });
      onDaemonSocketOpen(harness.deps, {
        hostId: host.id,
        sessionId: reconnectSession.id,
        socket: reconnectSocket,
      });

      if (testCase.status === "active") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toEqual([]);
      }
      expect(body).toMatchObject({
        queuedMessage: { waitingOn: testCase.waitingOn },
      });
      expect(
        queuedMessageWaitingOnSchema.parse(JSON.parse(queued[0]!.waitingOn!)),
      ).toEqual(testCase.waitingOn);

      if (testCase.status === "active") {
        applyLoggedThreadLifecycleEvent(harness.deps, {
          event: { type: "run.succeeded" },
          threadId: thread.id,
        });
        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
      }

      const dispatched = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (dispatched.command.type !== "turn.submit") {
        throw new Error("expected the queued follow-up to dispatch");
      }
      expect(dispatched.command).toMatchObject({
        threadId: thread.id,
        input,
        target: { mode: "start" },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
        eventCountBeforeSend + 1,
      );
    });
  });
});
