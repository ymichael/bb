import { afterEach, describe, expect, it } from "vitest";
import {
  createProject,
  createThread,
  getEnvironmentAgentStatus,
  replayEnvironmentAgentEvents,
  waitForThreadStatus,
} from "./environment-agent-api.js";
import {
  startDaemonE2eHarness,
  type DaemonE2eHarness,
} from "./harness.js";

describe.sequential("e2e: environment-agent replay", () => {
  let harness: DaemonE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it("replays buffered environment-agent events with stable pagination semantics", async () => {
    harness = await startDaemonE2eHarness();

    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "e2e-env-agent-replay-project",
    );
    const thread = await createThread(
      harness.baseUrl,
      project.id,
      "Generate enough provider activity to validate environment-agent replay pagination.",
    );
    await waitForThreadStatus(harness.baseUrl, thread.id, "idle");

    const status = await getEnvironmentAgentStatus(harness.baseUrl, thread.id);
    expect(status.latestSequence).toBeGreaterThanOrEqual(4);
    expect(status.lastAckedSequence ?? 0).toBeGreaterThan(0);
    expect(status.latestSequence).toBeGreaterThanOrEqual(
      status.lastAckedSequence ?? 0,
    );
    expect(status.pendingEventCount).toBe(
      status.latestSequence - (status.lastAckedSequence ?? 0),
    );

    const firstPage = await replayEnvironmentAgentEvents(harness.baseUrl, thread.id, {
      afterSequence: 0,
      limit: 2,
    });
    expect(firstPage.fromSequenceExclusive).toBe(0);
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.toSequenceInclusive).toBe(firstPage.events.at(-1)?.sequence);
    expect(firstPage.events[0]?.event.type).toBe("environment.ready");

    const secondPage = await replayEnvironmentAgentEvents(harness.baseUrl, thread.id, {
      afterSequence: firstPage.toSequenceInclusive,
      limit: 10,
    });
    expect(secondPage.fromSequenceExclusive).toBe(firstPage.toSequenceInclusive);
    expect(secondPage.events.length).toBeGreaterThan(0);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.events[0]!.sequence).toBeGreaterThan(
      firstPage.toSequenceInclusive,
    );

    const finalPage = await replayEnvironmentAgentEvents(harness.baseUrl, thread.id, {
      afterSequence: status.latestSequence,
    });
    expect(finalPage.events).toHaveLength(0);
    expect(finalPage.toSequenceInclusive).toBe(status.latestSequence);
    expect(finalPage.hasMore).toBe(false);
  }, 15_000);
});
