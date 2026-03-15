import { expect } from "vitest";
import type { Thread, ThreadEvent } from "@beanbag/agent-core";
import {
  createProject,
  readJson,
  waitForThreadCondition,
} from "./environment-agent-api.js";
import {
  startDaemonE2eHarness,
} from "./harness.js";
import { e2eTimeoutMs } from "./provider-mode.js";

interface TurnProgressCounts {
  clientTurnStarts: number;
  completedTurns: number;
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function measureTurnProgress(events: ThreadEvent[]): TurnProgressCounts {
  let clientTurnStarts = 0;
  let completedTurns = 0;

  for (const event of events) {
    const normalized = normalizeEventType(event.type);
    if (normalized === "client/turn/start") {
      clientTurnStarts += 1;
      continue;
    }
    if (normalized === "turn/completed" || normalized === "turn/end") {
      completedTurns += 1;
    }
  }

  return {
    clientTurnStarts,
    completedTurns,
  };
}

async function createWorktreeThread(
  baseUrl: string,
  projectId: string,
  inputText: string,
): Promise<Thread> {
  return readJson<Thread>(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      environmentKind: "worktree",
      input: [{ type: "text", text: inputText }],
    }),
  });
}

async function tellThread(
  baseUrl: string,
  threadId: string,
  inputText: string,
): Promise<void> {
  await readJson<{ ok: boolean }>(`${baseUrl}/api/v1/threads/${threadId}/tell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: [{ type: "text", text: inputText }],
    }),
  });
}

async function waitForIdleAfterTurnProgress(
  baseUrl: string,
  wsUrl: string,
  threadId: string,
  previousCounts: TurnProgressCounts,
  timeoutMs: number = 20_000,
): Promise<{
  thread: Thread;
  events: ThreadEvent[];
  counts: TurnProgressCounts;
}> {
  return waitForThreadCondition({
    threadId,
    timeoutMs,
    wsUrl,
    load: async () => {
      const [thread, events] = await Promise.all([
        readJson<Thread>(`${baseUrl}/api/v1/threads/${threadId}`),
        readJson<ThreadEvent[]>(`${baseUrl}/api/v1/threads/${threadId}/events`),
      ]);
      return {
        thread,
        events,
        counts: measureTurnProgress(events),
      };
    },
    isReady: ({ thread, counts }) =>
      thread.status === "idle" &&
      counts.clientTurnStarts > previousCounts.clientTurnStarts &&
      counts.completedTurns > previousCounts.completedTurns,
    describeLast: (snapshot) =>
      `Thread ${threadId} did not complete a new turn within ${timeoutMs}ms (status=${snapshot?.thread.status ?? "unknown"}, counts=${JSON.stringify(snapshot?.counts ?? measureTurnProgress([]))}, events=${snapshot?.events.map((event) => normalizeEventType(event.type)).join(",") ?? ""})`,
  });
}

export async function runThreadWorktreeFollowupRoundtripScenario(): Promise<void> {
  const harness = await startDaemonE2eHarness({
    fakeCodex: {
      defaultTurnDelayMs: 25,
    },
    initGitRepo: true,
  });

  try {
    const project = await createProject(
      harness.baseUrl,
      harness.projectRoot,
      "worktree-followup-e2e-project",
    );
    const thread = await createWorktreeThread(
      harness.baseUrl,
      project.id,
      "Reply with exactly WORKTREE-INITIAL and finish. Do not run commands or add extra text.",
    );

    const initialRoundTrip = await waitForIdleAfterTurnProgress(
      harness.baseUrl,
      harness.wsUrl,
      thread.id,
      {
        clientTurnStarts: 0,
        completedTurns: 0,
      },
      e2eTimeoutMs(20_000, 90_000),
    );
    expect(initialRoundTrip.thread.status).toBe("idle");
    expect(initialRoundTrip.thread.environmentId).toBeTruthy();

    await tellThread(
      harness.baseUrl,
      thread.id,
      "Reply with exactly WORKTREE-FOLLOWUP and finish. Do not run commands or add extra text.",
    );

    const followUpRoundTrip = await waitForIdleAfterTurnProgress(
      harness.baseUrl,
      harness.wsUrl,
      thread.id,
      initialRoundTrip.counts,
      e2eTimeoutMs(20_000, 90_000),
    );
    expect(followUpRoundTrip.thread.status).toBe("idle");
    expect(followUpRoundTrip.counts.clientTurnStarts).toBeGreaterThan(
      initialRoundTrip.counts.clientTurnStarts,
    );
    expect(followUpRoundTrip.counts.completedTurns).toBeGreaterThan(
      initialRoundTrip.counts.completedTurns,
    );
  } finally {
    await harness.cleanup();
  }
}
