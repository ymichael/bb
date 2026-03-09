import { afterEach, describe, expect, it } from "vitest";
import {
  allocateLocalPort,
  createProject,
  createThread,
  deliverEnvironmentAgentEvents,
  listThreadEvents,
  replayEnvironmentAgentEvents,
  sleep,
  waitForThreadStatus,
} from "./environment-agent-api.js";
import {
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";

describe.sequential("e2e: environment-agent restart recovery", () => {
  let harness: DaemonE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it("replays buffered provider events after daemon restart using the persisted cursor", async () => {
    const port = await allocateLocalPort();
    harness = await startDaemonE2eHarness({
      port,
      fakeCodex: {
        defaultTurnDelayMs: 1_500,
      },
      preserveTempDirOnCleanup: true,
    });

    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "e2e-env-agent-restart-project",
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      "Start a long-running turn so the daemon can restart mid-flight.",
    );

    await waitForThreadStatus(harness.baseUrl, thread.id, "active");
    const cursorBeforeRestart = harness.getEnvironmentAgentCursor(thread.id);

    await harness.shutdownForRestart();
    await sleep(1_800);

    harness = await startDaemonE2eHarness({
      tempDir: harness.tempDir,
      port,
      fakeCodex: {
        defaultTurnDelayMs: 1_500,
      },
    });

    const replay = await replayEnvironmentAgentEvents(harness.baseUrl, thread.id, {
      afterSequence: cursorBeforeRestart,
    });
    expect(replay.fromSequenceExclusive).toBe(cursorBeforeRestart);
    expect(replay.events.length).toBeGreaterThan(0);
    expect(
      replay.events.some(
        (event) =>
          event.event.type === "provider.event" &&
          event.event.method === "turn/completed",
      ),
    ).toBe(true);

    const authorization = harness.getEnvironmentAgentAuthorization(thread.id);
    expect(authorization).toMatch(/^Bearer /);

    const delivered = await deliverEnvironmentAgentEvents(
      harness.baseUrl,
      thread.id,
      authorization!,
      {
        protocolVersion: 1,
        threadId: thread.id,
        events: replay.events,
      },
    );
    expect(delivered.acknowledgedSequence).toBe(replay.toSequenceInclusive);

    await waitForThreadStatus(harness.baseUrl, thread.id, "idle");

    const events = await listThreadEvents(harness.baseUrl, thread.id);
    expect(events.filter((event) => event.type === "turn/started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(1);
    expect(harness.getEnvironmentAgentCursor(thread.id)).toBeGreaterThan(
      cursorBeforeRestart,
    );
  }, 20_000);
});
