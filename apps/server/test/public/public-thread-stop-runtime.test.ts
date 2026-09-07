import {
  getThread,
  isThreadQueueAutoSendPaused,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  listQueuedCommands,
  listQueuedThreadCommands,
  internalAuthHeaders,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { stopThreadForCurrentState } from "../../src/services/threads/thread-lifecycle.js";

describe("thread runtime stop", () => {
  it("releases an idle runtime without changing thread state", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle", visibility: "hidden" },
      });
      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/stop`,
        { method: "POST" },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stop.command).toMatchObject({ intent: "release" });

      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(0);
    });
  });

  it("settles background commands terminated by an idle runtime release", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "idle", visibility: "hidden" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "item/started",
        scope: turnScope("turn-1"),
        providerThreadId: "provider-thread-1",
        itemId: "task:orphaned-waiter",
        itemKind: "backgroundTask",
        data: {
          providerThreadId: "provider-thread-1",
          item: {
            type: "backgroundTask",
            id: "task:orphaned-waiter",
            taskType: "local_bash",
            description: "Wait for tests",
            status: "pending",
            taskStatus: "running",
            skipTranscript: false,
          },
        },
      });

      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/stop`,
        { method: "POST" },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });

      expect((await responsePromise).status).toBe(200);
      const taskCompletions = listEvents(harness.db, {
        threadId: thread.id,
      }).filter((event) => event.type === "item/backgroundTask/completed");
      expect(taskCompletions).toHaveLength(1);
      expect(JSON.parse(taskCompletions[0]!.data)).toMatchObject({
        item: { status: "interrupted", taskStatus: "stopped" },
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(0);
    });
  });

  it("waits for an active runtime release and settles the thread", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active", visibility: "hidden" },
      });
      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/stop`,
        { method: "POST" },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stop.command).toMatchObject({ intent: "interrupt" });
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
    });
  });

  it("keeps a startup-parked message paused after a manual stop until explicitly sent", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        thread: { status: "active", visibility: "hidden" },
      });
      const queueResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Park while the turn starts" }],
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );
      expect(queueResponse.status).toBe(200);
      await expect(readJson(queueResponse)).resolves.toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "turn-starting" } },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

      const stopResponsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/stop`,
        { method: "POST" },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      expect((await stopResponsePromise).status).toBe(200);

      const queuedMessage = listQueuedThreadMessages(harness.db, thread.id)[0]!;

      const staleStart = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-stopped-runtime",
                scope: turnScope("turn-stopped-runtime"),
              },
            },
          ]),
        }),
      });
      expect(staleStart.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(isThreadQueueAutoSendPaused(harness.db, thread.id)).toBe(true);

      const laterQueueResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queue after the stop" }],
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );
      expect(
        laterQueueResponse.status,
        await laterQueueResponse.clone().text(),
      ).toBe(201);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      const pausedMessages = listQueuedThreadMessages(harness.db, thread.id);
      expect(pausedMessages).toHaveLength(2);
      expect(pausedMessages[0]?.id).toBe(queuedMessage.id);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(sendResponse.status).toBe(200);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toEqual([pausedMessages[1]!.id]);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(1);

      const acceptedStart = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents([
              {
                threadId: thread.id,
                event: {
                  type: "turn/started",
                  threadId: thread.id,
                  providerThreadId: "provider-stopped-runtime",
                  scope: turnScope("turn-deliberate-resume"),
                },
              },
            ]),
          }),
        },
      );
      expect(acceptedStart.status).toBe(200);
      expect(isThreadQueueAutoSendPaused(harness.db, thread.id)).toBe(false);
    });
  });

  it("still releases the runtime when the turn completes during the stop", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "idle", visibility: "hidden" },
      });
      const stalePromise = stopThreadForCurrentState(
        harness.deps,
        { ...thread, status: "active" },
        environment,
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stop.command).toMatchObject({ intent: "release" });

      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      await stalePromise;

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(0);
    });
  });

  it("makes concurrent stops share one release and one result", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle", visibility: "hidden" },
      });

      const first = harness.app.request(`/api/v1/threads/${thread.id}/stop`, {
        method: "POST",
      });
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      const second = Promise.resolve(
        harness.app.request(`/api/v1/threads/${thread.id}/stop`, {
          method: "POST",
        }),
      );

      const settledEarly = await Promise.race([
        second.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      expect(settledEarly).toBe("pending");
      expect(listQueuedCommands(harness, "thread.stop")).toHaveLength(1);

      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });

      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
    });
  });

  it("reports a failed release to the caller", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle", visibility: "hidden" },
      });
      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/stop`,
        { method: "POST" },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );

      await reportQueuedCommandError(harness, stop, {
        errorCode: "test_release_failure",
        errorMessage: "Test release failure",
      });

      expect((await responsePromise).status).toBeGreaterThanOrEqual(500);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });

  it("reports success when the release cannot reach a disconnected host", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-release-offline" });
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
        status: "idle",
        visibility: "hidden",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/stop`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });
});
