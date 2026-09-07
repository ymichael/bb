import { getThread } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  type Environment,
  type ResolvedThreadExecutionOptions,
  type Thread,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  hasLiveThreadStartInFlight,
  requestThreadStart,
  requestThreadStopForCurrentState,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  createTestDaemonEventEnvelope,
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  type QueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const START_EXECUTION = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  source: "client/turn/requested",
} satisfies ResolvedThreadExecutionOptions;

interface StartLiveThreadStartRpcArgs {
  harness: TestAppHarness;
  requestIdValue: number;
}

interface LiveThreadStartRpcFixture {
  environment: Environment;
  startCommand: QueuedCommand;
  thread: Thread;
}

interface FailLiveStartRpcArgs {
  harness: TestAppHarness;
  startCommand: QueuedCommand;
}

async function startLiveThreadStartRpc(
  args: StartLiveThreadStartRpcArgs,
): Promise<LiveThreadStartRpcFixture> {
  const { host } = seedHostSession(args.harness.deps, {
    id: `host-live-start-handoff-${args.requestIdValue}`,
  });
  const { project } = seedProjectWithSource(args.harness.deps, {
    hostId: host.id,
    path: `/tmp/live-start-handoff-${args.requestIdValue}`,
  });
  const environment = seedEnvironment(args.harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/live-start-handoff-${args.requestIdValue}`,
    status: "ready",
  });
  const thread = seedThread(args.harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "starting",
  });

  await requestThreadStart(args.harness.deps, {
    thread,
    environment,
    fork: null,
    input: textInput("start live runtime"),
    requestId: encodeClientTurnRequestIdNumber({
      value: args.requestIdValue,
    }),
    execution: START_EXECUTION,
    permissionEscalation: "ask",
    projectId: project.id,
    providerId: thread.providerId,
    syncGeneratedTitle: false,
  });

  const startCommand = await waitForQueuedCommand(
    args.harness,
    ({ command }) =>
      command.type === "thread.start" && command.threadId === thread.id,
  );
  expect(hasLiveThreadStartInFlight(thread.id)).toBe(true);
  return { environment, startCommand, thread };
}

async function failLiveStartRpc(args: FailLiveStartRpcArgs): Promise<void> {
  await reportQueuedCommandError(args.harness, args.startCommand, {
    errorCode: "test_live_start_cleanup",
    errorMessage: "Test settled live thread start",
  });
}

describe("live thread start handoff", () => {
  it("sends live stop when manual stop races with an unsettled thread start", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await startLiveThreadStartRpc({
        harness,
        requestIdValue: 1,
      });
      try {
        requestThreadStopForCurrentState(
          harness.deps,
          fixture.thread,
          fixture.environment,
        );

        const stopCommand = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" &&
            command.threadId === fixture.thread.id,
        );
        expect(stopCommand.command).toMatchObject({
          type: "thread.stop",
          environmentId: fixture.environment.id,
          threadId: fixture.thread.id,
        });
        expect(getThread(harness.db, fixture.thread.id)?.status).toBe(
          "stopping",
        );
        await reportQueuedCommandSuccess(harness, stopCommand, {
          providerCheckpointId: null,
        });
      } finally {
        await failLiveStartRpc({
          harness,
          startCommand: fixture.startCommand,
        });
      }
    });
  });

  it("sends live stop when archive races with an unsettled thread start", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await startLiveThreadStartRpc({
        harness,
        requestIdValue: 2,
      });
      try {
        const response = await harness.app.request(
          `/api/v1/threads/${fixture.thread.id}/archive`,
          { method: "POST" },
        );

        expect(response.status).toBe(200);
        const stopCommand = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" &&
            command.threadId === fixture.thread.id,
        );
        expect(stopCommand.command).toMatchObject({
          type: "thread.stop",
          environmentId: fixture.environment.id,
          threadId: fixture.thread.id,
        });
        expect(getThread(harness.db, fixture.thread.id)?.archivedAt).toEqual(
          expect.any(Number),
        );
        expect(
          listQueuedThreadCommands(
            harness,
            "thread.archive",
            fixture.thread.id,
          ),
        ).toEqual([]);
        await reportQueuedCommandSuccess(harness, stopCommand, {
          providerCheckpointId: null,
        });
      } finally {
        await failLiveStartRpc({
          harness,
          startCommand: fixture.startCommand,
        });
      }
    });
  });

  it("sends live stop when delete races with an unsettled thread start", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await startLiveThreadStartRpc({
        harness,
        requestIdValue: 3,
      });
      try {
        const response = await harness.app.request(
          `/api/v1/threads/${fixture.thread.id}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ childThreadsConfirmed: false }),
          },
        );

        expect(response.status).toBe(200);
        const stopCommand = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" &&
            command.threadId === fixture.thread.id,
        );
        expect(stopCommand.command).toMatchObject({
          type: "thread.stop",
          environmentId: fixture.environment.id,
          threadId: fixture.thread.id,
        });
        expect(getThread(harness.db, fixture.thread.id)).toBeNull();
        await reportQueuedCommandSuccess(harness, stopCommand, {
          providerCheckpointId: null,
        });
      } finally {
        await failLiveStartRpc({
          harness,
          startCommand: fixture.startCommand,
        });
      }
    });
  });

  it("does not reactivate a stopped thread when a late thread start succeeds", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await startLiveThreadStartRpc({
        harness,
        requestIdValue: 4,
      });

      requestThreadStopForCurrentState(
        harness.deps,
        fixture.thread,
        fixture.environment,
      );
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: null,
      });
      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        status: "idle",
      });

      await reportQueuedCommandSuccess(harness, fixture.startCommand, {
        providerThreadId: "provider-stopped-late-start",
      });

      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        archivedAt: null,
        status: "idle",
      });
    });
  });

  it("does not reactivate a thread when a late start succeeds while its stop is still in flight", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await startLiveThreadStartRpc({
        harness,
        requestIdValue: 7,
      });

      requestThreadStopForCurrentState(
        harness.deps,
        fixture.thread,
        fixture.environment,
      );
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandSuccess(harness, fixture.startCommand, {
        providerThreadId: "provider-stop-in-flight-late-start",
      });

      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: null,
      });
      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        status: "idle",
      });
    });
  });

  it("does not reactivate an idle thread when a completed start turn settled first", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await startLiveThreadStartRpc({
        harness,
        requestIdValue: 6,
      });
      const providerThreadId = "provider-completed-before-start-settlement";
      const turnId = "turn-completed-before-start-settlement";
      const sessionId = fixture.startCommand.row.sessionId;
      if (!sessionId) {
        throw new Error("Queued thread start is missing sessionId");
      }

      const eventResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId,
            eventGroups: groupHostDaemonEvents([
              createTestDaemonEventEnvelope({
                event: {
                  type: "thread/identity",
                  threadId: fixture.thread.id,
                  providerThreadId,
                  scope: threadScope(),
                },
              }),
              createTestDaemonEventEnvelope({
                event: {
                  type: "turn/started",
                  threadId: fixture.thread.id,
                  providerThreadId,
                  scope: turnScope(turnId),
                },
              }),
              createTestDaemonEventEnvelope({
                event: {
                  type: "turn/completed",
                  threadId: fixture.thread.id,
                  providerThreadId,
                  scope: turnScope(turnId),
                  status: "completed",
                },
              }),
            ]),
          }),
        },
      );
      expect(eventResponse.status).toBe(200);
      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        status: "idle",
      });

      await reportQueuedCommandSuccess(harness, fixture.startCommand, {
        providerThreadId,
      });

      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        status: "idle",
      });
    });
  });

  it("does not reactivate an archived thread when a late thread start succeeds", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await startLiveThreadStartRpc({
        harness,
        requestIdValue: 5,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/archive`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: null,
      });
      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        archivedAt: expect.any(Number),
        status: "idle",
      });

      await reportQueuedCommandSuccess(harness, fixture.startCommand, {
        providerThreadId: "provider-archived-late-start",
      });

      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        archivedAt: expect.any(Number),
        status: "idle",
      });
    });
  });
});
