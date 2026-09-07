import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  listQueuedThreadMessagesForApi,
  listRunningThreads,
} from "@bb/db";
import type { ThreadQueuedMessage } from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  createQueuedMessageForThread,
  sendNextQueuedMessageIfPresent,
} from "../../src/services/threads/queued-messages.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { attemptDispatch } from "../../src/services/threads/dispatch-attempt.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/dispatch-hooks-project";

/**
 * The hook registry. Reading a mapped type through a generic key is sound,
 * which is what lets the fake provider satisfy `listHooks<K>` with no cast —
 * the same shape the real registry uses on the plugin handle.
 */
type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function emptyRegistry(): HookRegistry {
  return { "message.dispatch": [] };
}

/**
 * Installs fake handlers through the same seam createApp registers the plugin
 * service through, so these tests exercise the real runner (order, lock, box,
 * validation, provenance) without loading plugins.
 */
function installHooks(
  registry: HookRegistry,
  options: { decisionTimeoutMs?: number } = {},
): void {
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    // Mirrors the plugin service's failure isolation: a throw is reported, not
    // propagated, and the runner is what turns it into a failed dispatch.
    invokeHook: async (_pluginId, _label, run) => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    decisionTimeoutMs: options.decisionTimeoutMs ?? 10_000,
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
});

function seedDispatchFixture(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  return { environment, host, project };
}

function createHookedThread(
  harness: TestAppHarness,
  args: {
    hostId: string;
    projectId: string;
    origin?: "app" | "cli" | "sdk";
    model?: string;
  },
) {
  return createThreadFromRequest(harness.deps, {
    environment: {
      type: "host",
      hostId: args.hostId,
      workspace: { type: "unmanaged", path: WORKSPACE_PATH },
    },
    input: textInput("Do the thing"),
    origin: args.origin ?? "app",
    projectId: args.projectId,
    providerId: "codex",
    ...(args.model !== undefined ? { model: args.model } : {}),
    startedOnBehalfOf: null,
  });
}

/**
 * The turn requests on a thread. The runtime-state seed plants one, so tests
 * about "did a turn dispatch" compare counts rather than expecting an empty
 * list.
 */
function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
}

/**
 * A thread's queued rows: a live queued row carrying a wait. This is the queue
 * shape that replaced the hold table — the row IS the queued dispatch.
 */
function queuedRows(
  harness: TestAppHarness,
  threadId: string,
): ThreadQueuedMessage[] {
  return listQueuedThreadMessages(harness.db, threadId)
    .map(toThreadQueuedMessage)
    .filter((entry) => entry.waitingOn !== null);
}

function onlyQueuedRow(
  harness: TestAppHarness,
  threadId: string,
): ThreadQueuedMessage {
  const rows = queuedRows(harness, threadId);
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(`expected exactly one queued row, found ${rows.length}`);
  }
  return rows[0];
}

/** A live thread that can take a follow-up send. */
function seedRunnableThread(
  harness: TestAppHarness,
  args: { hostId: string; status: "idle" | "active" },
) {
  const { environment, project } = seedDispatchFixture(harness, args.hostId);
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: args.status,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${args.hostId}`,
    threadId: thread.id,
  });
  if (args.status === "active") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      threadId: thread.id,
      turnId: `turn-${args.hostId}`,
      providerThreadId: `provider-${args.hostId}`,
    });
  }
  return { environment, project, thread };
}

async function expectApiError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the operation to fail");
}

describe("message.dispatch hook context", () => {
  it("hands the hook the start intent's host before an environment exists", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedDispatchFixture(harness, "host-intent");
      const seen: { environment: unknown; hostId: string | null }[] = [];
      installHooks({
        "message.dispatch": [
          {
            pluginId: "limits",
            handler: (context) => {
              seen.push({
                environment: context.environment,
                hostId: context.host?.id ?? null,
              });
              return { action: "wait", reason: "Inspecting" };
            },
          },
        ],
      });

      // A workspace path with no environment row yet: the environment is only
      // provisioned at admission, so the hook decides about a thread that has
      // none — the exact state a per-host limiter must still see a host in.
      const thread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: "/tmp/dispatch-hooks-cold" },
        },
        input: textInput("Do the thing"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      // A cold start has no environment yet, but its start intent already
      // names the machine it will occupy — a per-host limiter that saw null
      // here would wave every cold start past its pool.
      expect(seen).toEqual([{ environment: null, hostId: host.id }]);
      expect(queuedRows(harness, thread.id)).toHaveLength(1);
    });
  });
});

describe("pending admission races", () => {
  it("re-decides a first message that lost the admission instead of calling it sent", async () => {
    await withTestHarness(async (harness) => {
      // Park the thread in `pending` with its first message queued, then take
      // the hook away so the next attempts admit freely.
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: () => ({ action: "wait", reason: "at capacity" }) as const,
      });
      installHooks(registry);
      const { host, project } = seedDispatchFixture(harness, "host-race");
      const created = await createHookedThread(harness, {
        hostId: host.id,
        projectId: project.id,
      });
      setPluginHookProvider(undefined);
      const stale = getThread(harness.db, created.id);
      if (!stale) throw new Error("expected the pending thread");
      expect(stale.status).toBe("pending");
      const attempt = (text: string) =>
        attemptDispatch(harness.deps, {
          thread: stale,
          payload: { input: textInput(text), mode: "start" },
          source: { kind: "inline" },
          queuePayload: { kind: "inline" },
          origin: null,
          originPluginId: null,
          startedOnBehalfOf: null,
          trigger: "user",
        });

      // The first attempt wins the admission; the second holds a thread row
      // captured before that flip — exactly what a concurrent sender holds.
      expect((await attempt("Winner")).kind).toBe("dispatched");
      const loser = await attempt("Loser");

      // Reporting `dispatched` here is what used to lose the message. The
      // thread is starting now, so the loser queues behind its cold start.
      expect(loser.kind).toBe("queued");
      if (loser.kind !== "queued") throw new Error("expected a queued outcome");
      expect(loser.entry.waitingOn).toEqual({ kind: "provisioning" });
      expect(
        loser.entry.content.flatMap((block) =>
          block.type === "text" ? [block.text] : [],
        ),
      ).toEqual(["Loser"]);
    });
  });
});

describe("message.dispatch hook composition", () => {
  it("runs every handler in install order and freezes the resolved tuple", async () => {
    await withTestHarness(async (harness) => {
      const seen: string[] = [];
      let secondSawModel: string | null = null;
      const registry = emptyRegistry();
      registry["message.dispatch"].push(
        {
          pluginId: "first",
          handler: () => {
            seen.push("first");
            return { action: "proceed" } as const;
          },
        },
        {
          pluginId: "second",
          handler: (context) => {
            seen.push("second");
            secondSawModel = context.requestedExecution.model;
            // Waiting here queues the dispatch so the frozen tuple is
            // observable without dispatching a real turn.
            return { action: "wait", reason: "checking" } as const;
          },
        },
      );
      installHooks(registry);
      const { host, project } = seedDispatchFixture(harness, "host-hook-order");

      const thread = await createHookedThread(harness, {
        hostId: host.id,
        projectId: project.id,
        model: "requested-model",
      });

      expect(seen).toEqual(["first", "second"]);
      // Every handler decides about the same resolved request, and that is the
      // tuple the queued row freezes.
      expect(secondSawModel).toBe("requested-model");
      expect(onlyQueuedRow(harness, thread.id).model).toBe("requested-model");
    });
  });

  it("names every waiter on the reason when a pass collects several", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push(
        {
          pluginId: "limiter",
          handler: () => ({ action: "wait", reason: "at capacity" }) as const,
        },
        {
          pluginId: "quiet-hours",
          handler: () => ({ action: "wait", reason: "after hours" }) as const,
        },
      );
      installHooks(registry);
      const { host, project } = seedDispatchFixture(harness, "host-hook-multi");

      const thread = await createHookedThread(harness, {
        hostId: host.id,
        projectId: project.id,
      });

      expect(onlyQueuedRow(harness, thread.id).waitingOn).toEqual({
        kind: "plugin",
        pluginId: "limiter",
        reason: "at capacity (also waiting on quiet-hours: after hours)",
      });
    });
  });

  it("short-circuits the pass on reject with a 409 naming the plugin", async () => {
    await withTestHarness(async (harness) => {
      let laterHandlerRan = false;
      const registry = emptyRegistry();
      registry["message.dispatch"].push(
        {
          pluginId: "dlp",
          handler: () =>
            ({ action: "reject", message: "Contains a secret" }) as const,
        },
        {
          pluginId: "never",
          handler: () => {
            laterHandlerRan = true;
            return { action: "proceed" } as const;
          },
        },
      );
      installHooks(registry);
      const { host, project } = seedDispatchFixture(
        harness,
        "host-hook-reject",
      );

      const error = await expectApiError(() =>
        createHookedThread(harness, { hostId: host.id, projectId: project.id }),
      );

      expect(error.status).toBe(409);
      expect(error.body.code).toBe("dispatch_rejected");
      expect(error.body.message).toBe("Contains a secret");
      expect(error.body.details).toEqual({ pluginId: "dlp" });
      expect(laterHandlerRan).toBe(false);
      // Nothing persisted: a rejected create leaves no thread and no row.
      expect(listQueuedThreadMessagesForApi(harness.db, {})).toEqual([]);
    });
  });

  it("runs one pass at a time so a counting handler never sees itself interleaved", async () => {
    await withTestHarness(async (harness) => {
      let inFlight = 0;
      let maxInFlight = 0;
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: async () => {
          // A handler that tallies its own in-flight work is only correct if the
          // server-wide evaluation lock holds; without it both passes would
          // see zero running and both would proceed.
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { action: "wait", reason: "counting" } as const;
        },
      });
      installHooks(registry);
      const { host, project } = seedDispatchFixture(harness, "host-hook-lock");

      await Promise.all([
        createHookedThread(harness, { hostId: host.id, projectId: project.id }),
        createHookedThread(harness, { hostId: host.id, projectId: project.id }),
      ]);

      expect(maxInFlight).toBe(1);
    });
  });
});

describe("message.dispatch hook admission visibility", () => {
  it("commits a cleared first dispatch before the lock releases, so the next pass sees it", async () => {
    // The invariant `sdk.threads.listRunning()` rests on. The evaluation lock
    // already serializes the QUESTIONS; this pins that the ANSWERS land inside
    // it too. Without the flip-before-unlock ordering both passes below read an
    // empty running set and a limit of one admits two threads — the exact race
    // that made the limiter keep its own tally of in-flight `proceed`s.
    await withTestHarness(async (harness) => {
      const seen: string[][] = [];
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: async () => {
          // Precisely what the concurrency limiter does: ask the server what
          // is running, at the moment the handler runs.
          const running = listRunningThreads(harness.db);
          seen.push(running.map((row) => row.id));
          return running.length >= 1
            ? ({
                action: "wait",
                reason: "1 of 1 running on all hosts",
              } as const)
            : ({ action: "proceed" } as const);
        },
      });
      installHooks(registry);
      const { host, project } = seedDispatchFixture(harness, "host-admission");

      const created = await Promise.all([
        createHookedThread(harness, { hostId: host.id, projectId: project.id }),
        createHookedThread(harness, { hostId: host.id, projectId: project.id }),
      ]);

      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual([]);
      expect(seen[1]).toHaveLength(1);

      const admittedId = seen[1]![0]!;
      const queued = created.find((thread) => thread.id !== admittedId)!;
      expect(created.map((thread) => thread.id)).toContain(admittedId);
      // One admitted and started, one still pending with its message queued.
      expect(getThread(harness.db, admittedId)?.status).not.toBe("pending");
      expect(getThread(harness.db, queued.id)?.status).toBe("pending");
      expect(onlyQueuedRow(harness, queued.id).waitingOn).toEqual({
        kind: "plugin",
        pluginId: "limiter",
        reason: "1 of 1 running on all hosts",
      });
    });
  });

  it("shows a warm follow-up's admission only after its send lands, not inside the pass", async () => {
    // The honest boundary on the exactness contract. A first dispatch commits
    // `pending -> starting` inside the lock; a follow-up on an already-live
    // thread commits `idle -> active` inside the send transaction, which needs
    // a prepared host command and therefore cannot run under the lock. So a
    // handler deciding about an idle thread does not yet see it, and sees it on
    // the next attempt. Pinned here so a future change that closes the gap
    // fails loudly and takes the doc comment with it.
    await withTestHarness(async (harness) => {
      const seen: string[][] = [];
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: () => {
          seen.push(listRunningThreads(harness.db).map((row) => row.id));
          return { action: "proceed" } as const;
        },
      });
      installHooks(registry);
      const { environment, thread } = seedRunnableThread(harness, {
        hostId: "host-warm-admission",
        status: "idle",
      });

      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("first follow-up"), mode: "auto" },
        thread,
      });
      // Not visible to its own pass: an idle thread occupies nothing, and the
      // activation is still ahead of it.
      expect(seen).toEqual([[]]);
      // It IS committed by the time the send returns, so the next attempt —
      // and every other reader — sees it.
      expect(listRunningThreads(harness.db).map((row) => row.id)).toEqual([
        thread.id,
      ]);
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-host-warm-admission",
        threadId: thread.id,
        turnId: "turn-host-warm-admission",
      });

      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("a steer"), mode: "steer" },
        thread: getThread(harness.db, thread.id)!,
      });
      expect(seen[1]).toEqual([thread.id]);
    });
  });
});

describe("dispatch hooks and the no-hook path", () => {
  it("leaves creation unchanged when no plugin answers the hook", async () => {
    await withTestHarness(async (harness) => {
      // A provider is registered, but no plugin answers `message.dispatch`:
      // the pass must not run, take the lock, or allocate a queued row.
      installHooks(emptyRegistry());
      const { host, project } = seedDispatchFixture(harness, "host-hook-none");

      const thread = await createHookedThread(harness, {
        hostId: host.id,
        projectId: project.id,
      });

      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      const types = listEvents(harness.db, { threadId: thread.id }).map(
        (event) => event.type,
      );
      expect(types).toContain("client/turn/requested");
    });
  });

  it("hooks a steer into a live turn like any other dispatch", async () => {
    // Steers used to be exempt because they joined a decision already made.
    // With one checkpoint they are hooked uniformly, distinguished only by
    // `attempt` — which is what lets a limiter or a DLP handler cover them.
    await withTestHarness(async (harness) => {
      const attempts: string[] = [];
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: (context) => {
          attempts.push(context.attempt);
          return {
            action: "reject",
            message: "no steering right now",
          } as const;
        },
      });
      installHooks(registry);
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-hook-steer",
        status: "active",
      });

      const error = await expectApiError(() =>
        acceptThreadSendRequest(harness.deps, {
          payload: { input: textInput("actually, stop"), mode: "steer" },
          thread,
        }),
      );

      expect(error.status).toBe(409);
      expect(error.body.code).toBe("dispatch_rejected");
      expect(attempts).toEqual(["join-turn"]);
    });
  });
});

describe("message.dispatch hooks on the queue drain", () => {
  it("returns the claimed row to the queue instead of consuming it when the pass waits", async () => {
    await withTestHarness(async (harness) => {
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: () => ({ action: "wait", reason: "at capacity" }) as const,
      });
      installHooks(registry);
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-hook-drain",
        status: "idle",
      });
      const queued = await createQueuedMessageForThread(harness.deps, {
        payload: { input: textInput("queued work") },
        thread,
      });
      const turnsBefore = turnRequests(harness, thread.id).length;

      const drained = await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: thread.id,
      });

      expect(drained).toBe(true);
      // The claim is handed back rather than consumed: it is the SAME row, now
      // queued, so the user still has one card for one message.
      const waiting = onlyQueuedRow(harness, thread.id);
      expect(waiting.id).toBe(queued.id);
      expect(waiting.content).toEqual(textInput("queued work"));
      expect(waiting.waitingOn).toEqual({
        kind: "plugin",
        pluginId: "limiter",
        reason: "at capacity",
      });
      expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore);
    });
  });

  it("returns an ordinary row when its hook pass crosses a manual stop", async () => {
    await withTestHarness(async (harness) => {
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      const registry = emptyRegistry();
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: async () => {
          entered.resolve();
          await release.promise;
          return { action: "proceed" } as const;
        },
      });
      installHooks(registry);
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-hook-stop-race",
        status: "idle",
      });
      const queued = await createQueuedMessageForThread(harness.deps, {
        payload: { input: textInput("stay paused") },
        thread,
      });
      const turnsBefore = turnRequests(harness, thread.id).length;

      const draining = sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: thread.id,
      });
      await entered.promise;
      try {
        applyLoggedThreadLifecycleEvent(harness.deps, {
          event: { type: "run.started" },
          threadId: thread.id,
        });
        seedTurnStarted(harness.deps, {
          environmentId: thread.environmentId,
          providerThreadId: "provider-host-hook-stop-race",
          threadId: thread.id,
          turnId: "turn-host-hook-stop-race",
        });
        const stopResponse = harness.app.request(
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
        expect((await stopResponse).status).toBe(200);
      } finally {
        release.resolve();
      }

      await expect(draining).resolves.toBe(false);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        { id: queued.id },
      ]);
      expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });
});
