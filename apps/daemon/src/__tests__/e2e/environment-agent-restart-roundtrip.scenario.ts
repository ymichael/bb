import { expect } from "vitest";
import {
  allocateLocalPort,
  createProject,
  createThread,
  listThreadEvents,
  waitForThreadStatus,
} from "./environment-agent-api.js";
import {
  startDaemonE2eHarness,
} from "./harness.js";

export async function runEnvironmentAgentRestartRoundtripScenario(): Promise<void> {
  const port = await allocateLocalPort();
  let harness = await startDaemonE2eHarness({
    port,
    fakeCodex: {
      defaultTurnDelayMs: 0,
      defaultScenario: "start-then-manual-complete",
    },
    preserveTempDirOnCleanup: true,
  });

  try {
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

    await waitForThreadStatus(harness.baseUrl, thread.id, "active", 5_000, harness.wsUrl);
    const cursorBeforeRestart = harness.getEnvironmentAgentCursor(thread.id);
    const tempDir = harness.tempDir;

    await harness.shutdownForRestart();
    harness.emitFakeCodexControlEvent();

    harness = await startDaemonE2eHarness({
      tempDir,
      port,
      fakeCodex: {
        defaultTurnDelayMs: 0,
        defaultScenario: "start-then-manual-complete",
      },
    });

    await waitForThreadStatus(harness.baseUrl, thread.id, "idle", 12_000, harness.wsUrl);

    const events = await listThreadEvents(harness.baseUrl, thread.id);
    expect(events.filter((event) => event.type === "turn/started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(1);
    expect(harness.getEnvironmentAgentCursor(thread.id)).toBeGreaterThan(
      cursorBeforeRestart,
    );
  } finally {
    await harness.cleanup();
  }
}
