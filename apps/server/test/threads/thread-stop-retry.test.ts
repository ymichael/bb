import { setTimeout as sleep } from "node:timers/promises";
import { getThread, listEvents } from "@bb/db";
import type { Environment, Thread } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  finalizeStoppedThread,
  hasLiveThreadStopInFlight,
  requestThreadStopForCurrentState,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface ActiveThreadStopFixture {
  environment: Environment;
  thread: Thread;
}

interface SeedActiveThreadStopFixtureArgs {
  harness: TestAppHarness;
  value: number;
}

interface WaitForStopRpcIdleArgs {
  threadId: string;
}

function seedActiveThreadStopFixture(
  args: SeedActiveThreadStopFixtureArgs,
): ActiveThreadStopFixture {
  const { host } = seedHostSession(args.harness.deps, {
    id: `host-thread-stop-retry-${args.value}`,
  });
  const { project } = seedProjectWithSource(args.harness.deps, {
    hostId: host.id,
    path: `/tmp/thread-stop-retry-${args.value}`,
  });
  const environment = seedEnvironment(args.harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/thread-stop-retry-${args.value}`,
    status: "ready",
  });
  const thread = seedThread(args.harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });

  return { environment, thread };
}

async function waitForStopRpcIdle(args: WaitForStopRpcIdleArgs): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!hasLiveThreadStopInFlight(args.threadId)) {
      return;
    }
    await sleep(10);
  }

  throw new Error("Timed out waiting for live thread stop RPC to settle");
}

describe("thread stop dispatch", () => {
  it("does not re-dispatch the stop after a live stop RPC failure", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 1,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(hasLiveThreadStopInFlight(thread.id)).toBe(true);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandError(harness, stopCommand, {
        errorCode: "test_thread_stop_failure",
        errorMessage: "Test live stop failure",
      });
      await waitForStopRpcIdle({ threadId: thread.id });

      expect(hasLiveThreadStopInFlight(thread.id)).toBe(false);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(0);
    });
  });

  it("settles a stopped thread when the host reports no runtime exists", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 4,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandError(harness, stopCommand, {
        errorCode: "unknown_environment",
        errorMessage: "No runtime exists for environment env_missing_runtime",
      });
      await waitForStopRpcIdle({ threadId: thread.id });

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(
        threadEvents.filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
      expect(
        threadEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(0);
    });
  });

  it("treats a second stop completion as a no-op after the stop already settled", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 3,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        turnId: "turn-stop-settles-twice",
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: "pi-entry-at-stop",
      });
      const settled = getThread(harness.db, thread.id);
      expect(settled).toMatchObject({
        status: "idle",
      });

      finalizeStoppedThread(harness.deps, {
        threadId: thread.id,
      });

      expect(getThread(harness.db, thread.id)).toEqual(settled);
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(
        threadEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(1);
      const completion = threadEvents.find(
        (event) => event.type === "turn/completed",
      );
      expect(completion).toBeDefined();
      expect(JSON.parse(completion?.data ?? "{}")).toMatchObject({
        providerCheckpointId: "pi-entry-at-stop",
        status: "interrupted",
      });
      expect(
        threadEvents.filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not queue duplicate stop commands while a stop RPC is in flight", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 2,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const firstStopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(hasLiveThreadStopInFlight(thread.id)).toBe(true);

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(1);

      await reportQueuedCommandSuccess(harness, firstStopCommand, {
        providerCheckpointId: null,
      });
      await waitForStopRpcIdle({ threadId: thread.id });
    });
  });
});
