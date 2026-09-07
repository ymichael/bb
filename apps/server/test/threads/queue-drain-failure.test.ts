import {
  claimQueuedThreadMessageGroup,
  getQueuedThreadMessage,
  listEvents,
  setQueuedThreadMessageFailureReason,
} from "@bb/db";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { noteDispatchRequeued } from "../../src/services/threads/dispatch-hooks.js";
import { recordQueuedMessageDrainFailure } from "../../src/services/threads/queue-drain-failure.js";
import {
  requestQueuedMessageDispatch,
  runQueuedMessageDispatch,
} from "../../src/services/threads/queued-message-dispatch.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/queue-drain-failure-project";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

/**
 * A thread with a queued row on a host that is either connected or not.
 *
 * `seedHostSession` opens a daemon session; `seedHost` alone leaves the host
 * enrolled but away, which is exactly the state a drain hits when a laptop
 * shuts. Nothing else about the fixture differs, so a test that flips this flag
 * is testing the host's liveness and nothing else.
 */
function seedQueuedRow(
  harness: TestAppHarness,
  args: { hostConnected: boolean; hostName: string; sendAt?: number },
) {
  const host = args.hostConnected
    ? seedHostSession(harness.deps, { name: args.hostName }).host
    : seedHost(harness.deps, { name: args.hostName });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
  const row = seedQueuedMessage(harness.deps, {
    threadId: thread.id,
    content: textInput("Capture the Safari trace"),
    waitingOn: { kind: "thread-busy" },
    ...(args.sendAt === undefined ? {} : { sendAt: args.sendAt }),
  });
  return { host, thread, row };
}

function reread(harness: TestAppHarness, queuedMessageId: string) {
  const row = getQueuedThreadMessage(harness.db, queuedMessageId);
  if (row === null) throw new Error("the queued row vanished");
  return toThreadQueuedMessage(row);
}

describe("host-connected queue dispatch", () => {
  it("releases exactly the returning machine's host-offline rows", async () => {
    await withTestHarness(async (harness) => {
      const away = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M4",
      });
      const otherAway = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M2",
      });
      for (const seeded of [away, otherAway]) {
        recordQueuedMessageDrainFailure(harness.deps, {
          error: new ApiError(502, "host_unavailable", "Host is not connected"),
          row: seeded.row,
          thread: seeded.thread,
        });
      }

      requestQueuedMessageDispatch(harness.deps, {
        hostId: away.host.id,
        kind: "host-connected",
      });

      // The returning machine's row is an ordinary queued row again, eligible
      // at the next drain; the other machine is still away and its row still
      // says so — a reconnect is one host's signal, not an amnesty.
      expect(reread(harness, away.row.id).waitingOn).toBeNull();
      expect(reread(harness, otherAway.row.id).waitingOn).toEqual({
        kind: "host-offline",
        hostName: "M2",
      });
    });
  });
});

describe("recordQueuedMessageDrainFailure", () => {
  it("does not automatically re-attempt a terminally failed row", async () => {
    await withTestHarness(async (harness) => {
      let attempts = 0;
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "rejector",
        handler: () => {
          attempts += 1;
          return { action: "reject", message: "Rejected for testing" } as const;
        },
      });
      setPluginHookProvider({
        listHooks: (hook) => registry[hook],
        invokeHook: async (_pluginId, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });

      try {
        const { row, thread } = seedQueuedRow(harness, {
          hostConnected: true,
          hostName: "M4",
        });

        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
        expect(reread(harness, row.id).failureReason).toBe(
          "Rejected for testing",
        );

        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });

        expect(attempts).toBe(1);
        expect(
          claimQueuedThreadMessageGroup(harness.db, harness.deps.hub, row.id, {
            kind: "explicit-send",
          }),
        ).not.toBeNull();
      } finally {
        setPluginHookProvider(undefined);
      }
    });
  });

  it("records a terminal failure from the turn-started wake", async () => {
    await withTestHarness(async (harness) => {
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "rejector",
        handler: () =>
          ({ action: "reject", message: "Rejected on turn start" }) as const,
      });
      setPluginHookProvider({
        listHooks: (hook) => registry[hook],
        invokeHook: async (_pluginId, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });

      try {
        const { host } = seedHostSession(harness.deps, { name: "M4" });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: WORKSPACE_PATH,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: WORKSPACE_PATH,
        });
        const thread = seedThread(harness.deps, {
          environmentId: environment.id,
          projectId: project.id,
          status: "active",
        });
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-turn-started",
          threadId: thread.id,
        });
        seedTurnStarted(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-turn-started",
          threadId: thread.id,
          turnId: "turn-started",
        });
        const row = seedQueuedMessage(harness.deps, {
          content: textInput("Wait for the turn"),
          threadId: thread.id,
          waitingOn: { kind: "turn-starting" },
        });
        noteDispatchRequeued(thread.id);

        await runQueuedMessageDispatch(harness.deps, {
          kind: "turn-started",
          threadId: thread.id,
        });

        expect(reread(harness, row.id).failureReason).toBe(
          "Rejected on turn start",
        );
      } finally {
        setPluginHookProvider(undefined);
      }
    });
  });

  it("re-queues on the named host when the machine is the thing that is missing", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M4",
        // A due row that could not be delivered: the instant has passed and
        // keeping it would leave the due sweep re-claiming a row that cannot go.
        sendAt: Date.now() - 1_000,
      });

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new ApiError(502, "host_unavailable", "Host is not connected"),
        row,
        thread,
      });

      const queued = reread(harness, row.id);
      expect(queued.waitingOn).toEqual({
        kind: "host-offline",
        hostName: "M4",
      });
      expect(queued.sendAt).toBeNull();
      // An absent machine is a wait, not a failure: the row recovers by itself
      // when the host comes back, so presenting it as an error would be wrong.
      expect(queued.failureReason).toBeNull();
      // A drain failure changes the row, not the transcript.
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([]);
    });
  });

  it("records the reason and keeps the wait when the host is present", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: true,
        hostName: "M4",
      });

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new ApiError(409, "thread_not_writable", "Thread is archived"),
        row,
        thread,
      });

      const queued = reread(harness, row.id);
      expect(queued.failureReason).toBe("Thread is archived");
      // The row is still waiting on what queued it. A failure says what went
      // wrong last time, not what the row is waiting for, and a queue would
      // have erased it on the very next attempt.
      expect(queued.waitingOn).toEqual({ kind: "thread-busy" });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([]);
    });
  });

  it("does not leak an internal fault's wording onto the row", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: true,
        hostName: "M4",
      });

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new Error("Cannot read properties of undefined (reading 'id')"),
        row,
        thread,
      });

      // `ApiError` messages are written for a caller; anything else was
      // written for a log and has no business on a queued row.
      expect(reread(harness, row.id).failureReason).toBe(
        "The message could not be sent.",
      );
    });
  });

  it("lets a later successful queue clear a failure the row was showing", async () => {
    await withTestHarness(async (harness) => {
      const { thread, row } = seedQueuedRow(harness, {
        hostConnected: false,
        hostName: "M4",
      });

      setQueuedThreadMessageFailureReason(harness.db, harness.deps.hub, {
        id: row.id,
        threadId: row.threadId,
        failureReason: "Thread is archived",
      });

      recordQueuedMessageDrainFailure(harness.deps, {
        error: new ApiError(502, "host_unavailable", "Host is not connected"),
        row,
        thread,
      });

      // The host is away, so this attempt re-queues rather than failing — and a
      // fresh statement of why the row is waiting supersedes the stale failure
      // instead of showing the reader two contradictory explanations.
      const queued = reread(harness, row.id);
      expect(queued.waitingOn).toEqual({
        kind: "host-offline",
        hostName: "M4",
      });
      expect(queued.failureReason).toBeNull();
    });
  });
});
