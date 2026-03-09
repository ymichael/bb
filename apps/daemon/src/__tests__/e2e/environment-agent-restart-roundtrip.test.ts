import { afterEach, describe, expect, it } from "vitest";
import {
  allocateLocalPort,
  createProject,
  createThread,
  listThreadEvents,
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

  it("recovers buffered provider events automatically after daemon restart", async () => {
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

    await waitForThreadStatus(harness.baseUrl, thread.id, "idle", 12_000);

    const events = await listThreadEvents(harness.baseUrl, thread.id);
    expect(events.filter((event) => event.type === "turn/started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(1);
    expect(harness.getEnvironmentAgentCursor(thread.id)).toBeGreaterThan(
      cursorBeforeRestart,
    );
  }, 20_000);
});
