import { expect } from "vitest";
import type { Project, Thread, ThreadEvent } from "@bb/core";
import { isProviderEventEnvelope, DEFAULT_THREAD_PROVIDER_ID } from "@bb/core";
import {
  runCliCommand,
  startDaemonE2eHarness,
} from "./harness.js";
import {
  readJson,
  waitForThreadCondition,
} from "./environment-agent-api.js";
import { e2eTimeoutMs } from "./provider-mode.js";

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

async function createProject(baseUrl: string, rootPath: string): Promise<Project> {
  return readJson<Project>(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "e2e-daemon-project",
      rootPath,
    }),
  });
}

function parseThreadIdFromCliOutput(stdout: string): string {
  const match = stdout.match(/Thread spawned:\s+([A-Za-z0-9_-]+)/);
  if (!match) {
    throw new Error(`Unable to parse thread id from CLI output:\n${stdout}`);
  }
  return match[1];
}

async function waitForThreadRoundTrip(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  timeoutMs: number = 8_000,
): Promise<{ thread: Thread; events: ThreadEvent[]; reachedActive: boolean }> {
  let reachedActive = false;
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
        readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`),
      ]);
      if (thread.status === "active") {
        reachedActive = true;
      }
      return { thread, events };
    },
    isReady: ({ thread, events }) => {
      const normalizedTypes = events.map((event) => normalizeEventType(event.type));
      const sawTurnStarted = normalizedTypes.includes("turn/started");
      const sawTurnCompleted =
        normalizedTypes.includes("turn/completed") ||
        normalizedTypes.includes("turn/end");
      return thread.status === "idle" && (reachedActive || sawTurnStarted) && sawTurnCompleted;
    },
    describeLast: (snapshot) =>
      `Thread ${threadId} did not complete within ${timeoutMs}ms (status=${snapshot?.thread.status ?? "unknown"}, actions=${JSON.stringify(snapshot?.thread.builtInActions)}, events=${snapshot?.events.map((event) => normalizeEventType(event.type)).join(",") ?? ""})`,
  }).then(({ thread, events }) => ({
    thread,
    events,
    reachedActive,
  }));
}

function resolveExpectedProviderId(): string {
  return (process.env.BB_E2E_PROVIDER ?? DEFAULT_THREAD_PROVIDER_ID).trim().toLowerCase();
}

export async function runThreadSpawnRoundtripScenario(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 25,
    },
  });

  try {
    const project = await createProject(harness.baseUrl, harness.projectRoot);

    const cli = await runCliCommand({
      baseUrl: harness.baseUrl,
      args: [
        "thread",
        "spawn",
        "--project",
        project.id,
        "--prompt",
        "Reply with exactly E2E-SPAWN-ROUNDTRIP and finish. Do not run commands or add extra text.",
      ],
    });

    expect(cli.exitCode).toBe(0);
    expect(cli.signal).toBeNull();
    expect(cli.stderr).not.toContain("Error:");

    const threadId = parseThreadIdFromCliOutput(cli.stdout);

    const { thread, events, reachedActive } = await waitForThreadRoundTrip(
      harness.baseUrl,
      harness.wsUrl,
      threadId,
      e2eTimeoutMs(15_000, 60_000),
    );
    expect(reachedActive).toBe(true);
    expect(thread.projectId).toBe(project.id);
    expect(thread.status).toBe("idle");

    const eventTypes = events.map((event) => normalizeEventType(event.type));
    expect(eventTypes).toContain("client/thread/start");
    expect(eventTypes).toContain("client/turn/start");
    expect(eventTypes).toContain("turn/started");
    expect(eventTypes).toContain("turn/completed");
    expect(eventTypes.indexOf("turn/started")).toBeLessThan(
      eventTypes.indexOf("turn/completed"),
    );

    // Verify that provider events carry the expected providerId
    const expectedProviderId = resolveExpectedProviderId();
    const providerEventEnvelopes = events
      .filter((event) => isProviderEventEnvelope(event.data))
      .map((event) => (event.data as { __bb_provider_event: { providerId: string } }).__bb_provider_event);
    expect(providerEventEnvelopes.length).toBeGreaterThan(0);
    for (const envelope of providerEventEnvelopes) {
      expect(envelope.providerId).toBe(expectedProviderId);
    }

    // Thread record itself should have the correct providerId
    expect(thread.providerId).toBe(expectedProviderId);
  } finally {
    await harness.cleanup();
  }
}
